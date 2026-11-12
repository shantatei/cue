import type { Channel } from "./types.js";
import { esc } from "./util.js";

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const letter = (name?: string | null) => [...(name ?? "?").replace(/[^\p{L}\p{N}]/gu, "")][0]?.toUpperCase() ?? "?";
const validChannel = (id?: string | null) => /^UC[\w-]{22}$/.test(id ?? "");
export function avatar(ch: (Partial<Channel> & { videoId?: string }) | null | undefined, name?: string | null, cls = "") {
  const channel = validChannel(ch?.id) ? ch!.id! : "";
  const video = /^[\w-]{11}$/.test(ch?.videoId ?? "") ? ch!.videoId! : "";
  const fallbackURL = channel ? `/api/channel-avatar?id=${channel}` : video ? `/api/channel-avatar?v=${video}` : "";
  const src = ch?.avatar ? `/api/img?u=${encodeURIComponent(ch.avatar)}` : fallbackURL;
  if (src) return `<img class="av ${cls}" src="${src}" data-avatar-name="${esc(name)}" data-avatar-url="${fallbackURL}" alt="" loading="lazy" width="36" height="36">`;
  return `<span class="av av-t ${cls}" style="--h:${hue(name ?? "")}" aria-hidden="true">${esc(letter(name))}</span>`;
}

export function installAvatarFallbacks(root = document) {
  root.addEventListener("error", (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.matches?.("img.av[data-avatar-name]")) return;
    if (img.dataset.avatarUrl && img.getAttribute("src")?.startsWith("/api/img?") && !img.dataset.retried) {
      img.dataset.retried = "true"; img.src = img.dataset.avatarUrl; return;
    }
    const fallback = document.createElement("span");
    fallback.className = `${img.className} av-t`;
    fallback.style.setProperty("--h", String(hue(img.dataset.avatarName ?? "")));
    fallback.textContent = letter(img.dataset.avatarName);
    fallback.setAttribute("aria-hidden", "true"); img.replaceWith(fallback);
  }, true);
}
