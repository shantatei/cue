import type { Fetcher } from "./discovery.js";
import type { Video } from "../public/app/types.js";
import type { Thumbnail } from "./yt-types.js";
interface SearchText { content?: string; simpleText?: string; runs?: { text: string }[] }
interface ShortsCard {
  entityId?: string; videoId?: string; headline?: SearchText; viewCountText?: SearchText;
  overlayMetadata?: { primaryText?: SearchText; secondaryText?: SearchText };
  onTap?: { innertubeCommand?: { reelWatchEndpoint?: { videoId?: string; thumbnail?: { thumbnails?: Thumbnail[] } } } };
  thumbnailViewModel?: { thumbnailViewModel?: { image?: { sources?: Thumbnail[] } } };
  thumbnail?: { thumbnails?: Thumbnail[] };
}
import { normalizeSearchFilters } from "../public/app/search-filters.js";

/** YouTube search filter fields, obtained from its public search-filter links. */
export function youtubeSearchURL(query: string, raw: Record<string, unknown> = {}) {
  const f = normalizeSearchFilters(raw), fields: number[] = [];
  const date = ({ today: 2, week: 3, month: 4, year: 5 } as Record<string, number>)[f.date];
  const type = ({ videos: 1, shorts: 9 } as Record<string, number>)[f.type];
  const duration = ({ short: 4, medium: 5, long: 2 } as Record<string, number>)[f.duration];
  if (date) fields.push(8, date);
  if (type) fields.push(16, type);
  if (duration) fields.push(24, duration);
  if (f.hd) fields.push(32, 1);
  if (f.cc) fields.push(40, 1);
  if (f.live) fields.push(64, 1);
  if (f.uhd) fields.push(112, 1);
  const bytes = [];
  if (f.sort !== "relevance") bytes.push(8, f.sort === "date" ? 2 : 3);
  if (fields.length) bytes.push(18, fields.length, ...fields);
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  if (bytes.length) url.searchParams.set("sp", Buffer.from(bytes).toString("base64"));
  return url.href;
}

// yt-dlp currently skips YouTube's shortsLockupViewModel in Shorts-only search.
// Read those public cards directly rather than returning an empty result for a valid filter.
export function shortsFromSearchData(data: unknown) {
  const videos = new Map<string, Video>();
  const text = (value?: SearchText) => value?.content ?? value?.simpleText ?? value?.runs?.map((r) => r.text).join("") ?? "";
  const views = (label: string) => {
    const match = /^([\d,.]+)\s*(k|m|b|thousand|million|billion)?\s*views/i.exec(label);
    return match ? Math.round(Number(match[1].replace(/,/g, "")) * (({ k: 1e3, m: 1e6, b: 1e9, thousand: 1e3, million: 1e6, billion: 1e9 } as Record<string, number>)[match[2]?.toLowerCase()] ?? 1)) : null;
  };
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || videos.size >= 60) return;
    const object = node as Record<string, unknown>;
    const card = (object.shortsLockupViewModel ?? object.reelItemRenderer) as ShortsCard | undefined;
    if (card) {
      const endpoint = card.onTap?.innertubeCommand?.reelWatchEndpoint;
      const id = endpoint?.videoId ?? card.videoId ?? card.entityId?.replace(/^shorts-shelf-item-/, "");
      const title = text(card.overlayMetadata?.primaryText) || text(card.headline);
      const sources = card.thumbnailViewModel?.thumbnailViewModel?.image?.sources ?? card.thumbnail?.thumbnails ?? endpoint?.thumbnail?.thumbnails ?? [];
      if (/^[\w-]{11}$/.test(id ?? "") && title) videos.set(id!, {
        id: id!, title, short: true, live: false, duration: null, timestamp: null,
        views: views(text(card.overlayMetadata?.secondaryText) || text(card.viewCountText)),
        thumbnail: [...sources].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null,
        channel: null, channelId: null,
      });
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(data && typeof data === "object" && "contents" in data ? data.contents : data);
  return [...videos.values()];
}

export async function searchShorts(url: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Couldn't load Shorts search results.");
  const html = await response.text();
  const raw = html.match(/\bvar ytInitialData\s*=\s*(\{.*?\});<\/script>/s)?.[1];
  if (!raw) throw new Error("YouTube didn't return Shorts search results. Try again.");
  return shortsFromSearchData(JSON.parse(raw));
}
