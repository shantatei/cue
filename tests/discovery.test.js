import test from "node:test";
import assert from "node:assert/strict";
import { searchSuggestions, channelAvatarURL, createChannelAvatars } from "../server/discovery.js";
import { avatar } from "../public/app/avatars.js";

const id = "UC" + "a".repeat(22);
const html = `<meta content="https://yt3.googleusercontent.com/creator=s900-c-k" property="og:image">`;

test("suggestions use YouTube search and return bounded, distinct text", async () => {
  const result = await searchSuggestions("a&b", async (url) => {
    assert.equal(url.searchParams.get("q"), "a&b");
    assert.equal(url.searchParams.get("ds"), "yt");
    return { ok: true, json: async () => ["a&b", [" apple ", "apple", "adele", null, {}, "", "x".repeat(201)]] };
  });
  assert.deepEqual(result, ["apple", "adele"]);
  assert.deepEqual(await searchSuggestions("a", async () => ({ ok: true, json: async () => null })), []);
  await assert.rejects(searchSuggestions("a", async () => ({ ok: false })), /unavailable/);
});

test("channel metadata supports attribute order, quotes, and thumbnail links", () => {
  assert.equal(channelAvatarURL(html), "https://yt3.googleusercontent.com/creator=s96-c-k");
  assert.equal(channelAvatarURL("<link itemprop='thumbnailUrl' href='https://yt3.ggpht.com/photo=s900-c-k?x=1&amp;y=2'>"), "https://yt3.ggpht.com/photo=s96-c-k?x=1&y=2");
  for (const url of ["http://yt3.ggpht.com/a", "https://evil.example/image", "https://yt3.ggpht.com.evil.example/a"]) {
    assert.throws(() => channelAvatarURL(`<meta property="og:image" content="${url}">`), /unavailable/);
  }
});

test("creator lookup deduplicates, caches, and validates channel IDs", async () => {
  let requests = 0;
  const get = createChannelAvatars({ fetcher: async (url) => {
    requests++; assert.equal(url, `https://www.youtube.com/channel/${id}/about`);
    await new Promise((r) => setTimeout(r, 1));
    return { ok: true, text: async () => html };
  } });
  const urls = await Promise.all([get(id), get(id), get(id)]);
  assert.equal(new Set(urls).size, 1);
  await get(id); assert.equal(requests, 1);
  await assert.rejects(get("../../other"), /Bad channel/);
});

test("creator lookup bounds concurrency and lets failed images retry", async () => {
  let active = 0, peak = 0, fail = true;
  const get = createChannelAvatars({ concurrency: 2, fetcher: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2)); active--;
    if (fail) { fail = false; return { ok: false }; }
    return { ok: true, text: async () => html };
  } });
  const ids = Array.from({ length: 6 }, (_, i) => "UC" + String(i).repeat(22));
  await Promise.allSettled(ids.map(get));
  assert.equal(peak, 2);
  assert.ok(await get(ids[0]));
});

test("unsubscribed creator renders a real lazy-loaded avatar request", () => {
  const markup = avatar({ id }, "A & B");
  assert.match(markup, new RegExp(`/api/channel-avatar\\?id=${id}`));
  assert.match(markup, /loading="lazy"/);
  assert.match(markup, /A &amp; B/);
  assert.match(avatar({ avatar: "https://yt3.ggpht.com/photo" }, "A"), /\/api\/img\?u=/);
  assert.match(avatar(null, "A"), /<span/);
  assert.match(avatar({ videoId: "5tg7jMWtNX4" }, "Missing ID"), /\/api\/channel-avatar\?v=5tg7jMWtNX4/);
});

test("feed entries without channel IDs resolve only public YouTube creator links", async () => {
  const paths = [];
  const get = createChannelAvatars({ fetcher: async (url) => {
    paths.push(String(url));
    if (paths.length === 1) return { ok: true, json: async () => ({ author_url: "https://www.youtube.com/@creator" }) };
    return { ok: true, text: async () => html };
  } });
  assert.ok(await get("video:5tg7jMWtNX4"));
  assert.match(paths[0], /youtube.com\/oembed/);
  assert.equal(paths[1], "https://www.youtube.com/@creator/about");
  const bad = createChannelAvatars({ fetcher: async () => ({ ok: true, json: async () => ({ author_url: "https://evil.example/@creator" }) }) });
  await assert.rejects(bad("video:5tg7jMWtNX4"), /Invalid creator/);
});
