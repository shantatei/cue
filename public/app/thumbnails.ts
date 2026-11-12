import { esc } from "./util.js";

export function thumbnailURLs(id: string, supplied?: string | null, quality = "hq720") {
  if (!/^[\w-]{11}$/.test(id)) return [];
  const urls = [];
  try {
    const url = new URL(supplied ?? "");
    if (url.protocol === "https:" && ["i.ytimg.com", "i9.ytimg.com"].includes(url.hostname)) urls.push(url.href);
  } catch {}
  for (const q of [quality, "hq720", "maxresdefault", "hqdefault", "mqdefault"]) {
    if (/^[\w-]+$/.test(q)) urls.push(`https://i.ytimg.com/vi/${id}/${q}.jpg`);
  }
  return [...new Set(urls)];
}

export function thumb(id: string, quality = "hq720", supplied?: string | null, className = "") {
  const urls = thumbnailURLs(id, supplied, quality);
  if (!urls.length) return `<span class="thumbnail-unavailable" role="img" aria-label="Thumbnail unavailable"></span>`;
  return `<img class="${esc(className)}" src="/api/img?u=${encodeURIComponent(urls[0])}" data-thumbnail-urls="${esc(JSON.stringify(urls))}" data-thumbnail-index="0" alt="" loading="lazy">`;
}

export function installThumbnailFallbacks(root = document) {
  const next = (img: HTMLImageElement) => {
    const urls = JSON.parse(img.dataset.thumbnailUrls!) as string[];
    const index = Number(img.dataset.thumbnailIndex) + 1;
    if (index >= urls.length) {
      const fallback = document.createElement("span");
      fallback.className = `thumbnail-unavailable ${img.className}`; fallback.setAttribute("role", "img");
      fallback.setAttribute("aria-label", "Thumbnail unavailable"); img.replaceWith(fallback); return;
    }
    img.dataset.thumbnailIndex = String(index); img.src = `/api/img?u=${encodeURIComponent(urls[index])}`;
  };
  root.addEventListener("error", (e) => { if (e.target instanceof HTMLImageElement && e.target.hasAttribute("data-thumbnail-urls")) next(e.target); }, true);
  root.addEventListener("load", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    // YouTube's missing-image response can decode successfully as a tiny grey placeholder.
    if (img.matches?.("img[data-thumbnail-urls]") && img.naturalWidth <= 120 && img.naturalHeight <= 90) next(img);
  }, true);
}
