import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchFilters, quickSearchFilter, filterWatched } from "../public/app/search-filters.js";
import { youtubeSearchURL, shortsFromSearchData, searchShorts } from "../server/search.js";
import { thumbnailURLs, thumb } from "../public/app/thumbnails.js";

test("filter links match YouTube's public search controls", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ type: "videos" }, "EgIQAQ=="], [{ type: "shorts" }, "EgIQCQ=="],
    [{ date: "week" }, "EgIIAw=="], [{ duration: "short" }, "EgIYBA=="],
    [{ duration: "medium" }, "EgIYBQ=="], [{ live: true }, "EgJAAQ=="],
    [{ uhd: true }, "EgJwAQ=="], [{ hd: true }, "EgIgAQ=="], [{ cc: true }, "EgIoAQ=="],
    [{ sort: "popularity" }, "CAM="],
  ];
  for (const [filters, expected] of cases) {
    const url = new URL(youtubeSearchURL("a & b", filters));
    assert.equal(url.searchParams.get("search_query"), "a & b");
    assert.equal(url.searchParams.get("sp"), expected, JSON.stringify(filters));
  }
});

test("combined filters compose instead of filtering the first result batch locally", () => {
  const url = new URL(youtubeSearchURL("test", { type: "shorts", date: "week", duration: "short", sort: "date", hd: true }));
  assert.deepEqual([...Buffer.from(url.searchParams.get("sp")!, "base64")], [8, 2, 18, 8, 8, 3, 16, 9, 24, 4, 32, 1]);
  assert.equal(new URL(youtubeSearchURL("test")).searchParams.has("sp"), false);
});

test("quick filters reset incompatible options and sanitize unsupported parameters", () => {
  assert.equal(quickSearchFilter("recent").sort, "date");
  assert.equal(quickSearchFilter("live").live, true);
  assert.equal(quickSearchFilter("shorts").type, "shorts");
  assert.equal(quickSearchFilter("all").live, false);
  const f = normalizeSearchFilters({ type: "shell", date: "forever", sort: "random", live: "0" });
  assert.deepEqual(f, normalizeSearchFilters());
});

test("watched and unwatched use video IDs in known profile history", () => {
  const videos = [{ id: "one" }, { id: "two" }], history = new Set(["one"]);
  assert.deepEqual(filterWatched(videos, quickSearchFilter("watched"), history), [videos[0]]);
  assert.deepEqual(filterWatched(videos, quickSearchFilter("unwatched"), history), [videos[1]]);
  assert.deepEqual(filterWatched(videos, quickSearchFilter("all"), history), videos);
});

test("thumbnail uses the supplied image and retains alternate sizes when hq720 is missing", () => {
  const id = "lrtgQ-Va_Pw", supplied = `https://i.ytimg.com/vi/${id}/hqdefault.jpg?custom=1&v=2`;
  const urls = thumbnailURLs(id, supplied);
  assert.equal(urls[0], supplied);
  assert.ok(urls.includes(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`));
  assert.ok(urls.includes(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`));
  assert.equal(new Set(urls).size, urls.length);
  assert.match(thumb(id, "hq720", supplied), /data-thumbnail-urls=/);
  assert.match(thumb(id, "hq720", supplied), /\/api\/img\?u=/);
  assert.deepEqual(thumbnailURLs("invalid", supplied), []);
  assert.ok(thumbnailURLs(id, "https://evil.example/image").every((url) => url.startsWith("https://i.ytimg.com/")));
});

test("Shorts search reads current and legacy YouTube cards rather than dropping them", async () => {
  const card = { shortsLockupViewModel: {
    entityId: "shorts-shelf-item-AAAAAAAAAAA",
    onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: "AAAAAAAAAAA" } } },
    overlayMetadata: { primaryText: { content: "Tekken short" }, secondaryText: { content: "1.7k views" } },
    thumbnailViewModel: { thumbnailViewModel: { image: { sources: [{ url: "https://i.ytimg.com/vi/AAAAAAAAAAA/frame0.jpg", width: 405 }] } } },
  } };
  const data = { contents: { cards: [card, card, { reelItemRenderer: { videoId: "BBBBBBBBBBB", headline: { simpleText: "Other short" }, viewCountText: { simpleText: "2,000 views" } } }] } };
  const result = shortsFromSearchData(data);
  assert.equal(result.length, 2);
  assert.equal(result[0].views, 1700);
  assert.equal(result[0].short, true);
  assert.equal(result[1].views, 2000);
  const parsed = await searchShorts("https://www.youtube.com/results", async () => new Response(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`));
  assert.deepEqual(parsed, result);
  await assert.rejects(searchShorts("url", async () => new Response("invalid")), /didn't return/);
});
