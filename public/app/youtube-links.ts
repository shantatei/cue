const ID = /^[\w-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtube-nocookie.com", "youtube-nocookie.com"]);

/**
 * Turns a pasted YouTube link into the matching Cue route, or null when the text isn't one.
 * Handles watch, youtu.be, Shorts, live, embed and channel links.
 */
export function cueRouteForLink(text: string): string | null {
  let url: URL;
  try { url = new URL(/^[\w.-]+\.[a-z]{2,}\//i.test(text.trim()) ? `https://${text.trim()}` : text.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || !HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "youtu.be") return ID.test(parts[0] ?? "") ? `#/watch/${parts[0]}` : null;
  const [kind, id] = parts;
  if (kind === "watch") { const v = url.searchParams.get("v") ?? ""; return ID.test(v) ? `#/watch/${v}` : null; }
  if (kind === "shorts" && ID.test(id ?? "")) return `#/shorts/${id}`;
  if ((kind === "live" || kind === "embed" || kind === "v") && ID.test(id ?? "")) return `#/watch/${id}`;
  if (kind === "channel" && /^UC[\w-]{22}$/.test(id ?? "")) return `#/channel/${id}`;
  return null;
}
