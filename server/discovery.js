export async function searchSuggestions(query, fetcher = fetch) {
  const url = new URL("https://suggestqueries.google.com/complete/search");
  url.search = new URLSearchParams({ client: "firefox", ds: "yt", q: query, hl: "en" });
  const response = await fetcher(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error("Search suggestions unavailable.");
  const result = await response.json();
  return [...new Set((Array.isArray(result?.[1]) ? result[1] : [])
    .filter((s) => typeof s === "string" && s.trim() && s.length <= 200).map((s) => s.trim()))].slice(0, 12);
}

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_REF = /^video:([\w-]{11})$/;
const AVATAR_HOSTS = new Set(["yt3.googleusercontent.com", "yt3.ggpht.com"]);
export function channelAvatarURL(html) {
  for (const tag of html.match(/<(?:meta|link)\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));
    if (attributes.property !== "og:image" && attributes.itemprop !== "thumbnailUrl") continue;
    try {
      const url = new URL((attributes.content ?? attributes.href).replace(/&amp;/g, "&"));
      if (url.protocol === "https:" && AVATAR_HOSTS.has(url.hostname)) return url.href.replace(/=s\d+(?=-|$)/, "=s96");
    } catch {}
  }
  throw new Error("Channel image unavailable.");
}

/** Deduplicate creators and bound concurrent public channel lookups while images lazy-load. */
export function createChannelAvatars({ fetcher = fetch, concurrency = 6 } = {}) {
  const cache = new Map(), waiting = [];
  let active = 0;
  const run = async (load) => {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try { return await load(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
  return async (id) => {
    if (!CHANNEL_ID.test(id) && !VIDEO_REF.test(id)) throw new Error("Bad channel id.");
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.result;
    const result = run(async () => {
      let path = `/channel/${id}`;
      // A few feed entries omit channel_id. Resolve their public author link via oEmbed.
      const video = VIDEO_REF.exec(id)?.[1];
      if (video) {
        const url = new URL("https://www.youtube.com/oembed");
        url.search = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${video}`, format: "json" });
        const response = await fetcher(url, { signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error("Channel image unavailable.");
        const author = new URL((await response.json()).author_url);
        if (author.protocol !== "https:" || author.hostname !== "www.youtube.com" || !/^\/(?:channel\/UC[\w-]{22}|@[^/?#]+)\/?$/.test(author.pathname)) throw new Error("Invalid creator link.");
        path = author.pathname.replace(/\/$/, "");
      }
      const response = await fetcher(`https://www.youtube.com${path}/about`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("Channel image unavailable.");
      return channelAvatarURL(await response.text());
    });
    cache.set(id, { at: Date.now(), result });
    result.catch(() => { if (cache.get(id)?.result === result) cache.delete(id); });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return result;
  };
}
