import test from "node:test";
import assert from "node:assert/strict";
import { createHomeFeed } from "../public/app/home-feed.js";
import { matchesTopic } from "../public/app/topics.js";
import { createRecommendationPager } from "../server/recommendations.js";

test("continues beyond the original batch, deduplicating overlapping recommendations", async () => {
  const cursors: string[] = [];
  const feed = createHomeFeed(async (cursor) => {
    cursors.push(cursor);
    return cursor ? { videos: [{ id: "c" }], nextCursor: null } : { videos: [{ id: "a" }, { id: "b" }], nextCursor: "next" };
  });
  feed.merge([{ id: "a" }]);
  assert.equal(await feed.loadMore(), 2);
  assert.deepEqual(cursors, ["", "next"]);
  assert.deepEqual(feed.videos.map((v) => v.id), ["a", "b", "c"]);
  assert.equal(feed.ended, true);
  await feed.loadMore();
  assert.equal(cursors.length, 2);
});

test("sparse topic scans past unrelated pages to find more matching videos", async () => {
  let calls = 0;
  const feed = createHomeFeed(async () => {
    calls++;
    return { videos: [{ id: String(calls), title: calls === 3 ? "VCT finals #Valorant" : "Cooking a recipe" }], nextCursor: calls < 3 ? String(calls) : null };
  });
  assert.equal(await feed.loadMore((v) => matchesTopic(v, "topic:gaming")), 1);
  assert.equal(calls, 3);
});

test("bounds scans for empty topics and permits loading another batch", async () => {
  let calls = 0;
  const feed = createHomeFeed(async () => ({ videos: [{ id: String(++calls), title: "Music" }], nextCursor: String(calls) }));
  await feed.loadMore(() => false);
  assert.equal(calls, 4);
  assert.equal(feed.ended, false);
  await feed.loadMore(() => false);
  assert.equal(calls, 8);
});

test("concurrent loads share work; failed requests can retry the same cursor", async () => {
  let calls = 0;
  const feed = createHomeFeed(async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    return { videos: [{ id: "ok" }], nextCursor: null };
  });
  const first = feed.loadMore();
  assert.equal(first, feed.loadMore());
  await assert.rejects(first, /offline/);
  assert.equal(feed.loading, false);
  assert.equal(await feed.loadMore(), 1);
});

test("expired cursors restart once without duplicating cards", async () => {
  const calls: string[] = [];
  const feed = createHomeFeed(async (cursor) => {
    calls.push(cursor);
    if (cursor) throw Object.assign(new Error("expired"), { status: 410 });
    return { videos: [{ id: "same" }], nextCursor: "old" };
  });
  await assert.rejects(feed.loadMore(), /expired/);
  assert.deepEqual(calls, ["", "old", "", "old"]);
  assert.equal(feed.videos.length, 1);
});

test("server cursors retain one iterator, bind profiles, and replay retries", async () => {
  let starts = 0, pages = 0, closed = 0;
  const pager = createRecommendationPager({ start: async () => {
    starts++;
    return { next: async () => ({ videos: [{ id: String(++pages) }], hasMore: pages < 3 }), close: () => closed++ };
  } });
  try {
    const first = await pager.page("alice");
    assert.ok(first.nextCursor);
    await assert.rejects(pager.page("bob", first.nextCursor), { status: 410 });
    const [second, retry] = await Promise.all([pager.page("alice", first.nextCursor), pager.page("alice", first.nextCursor)]);
    assert.deepEqual(second, retry);
    assert.deepEqual(await pager.page("alice", first.nextCursor), second);
    assert.ok(second.nextCursor);
    const last = await pager.page("alice", second.nextCursor);
    assert.equal(last.nextCursor, null);
    assert.equal(starts, 1);
    assert.equal(pages, 3);
    pager.closeProfile("alice");
    await assert.rejects(pager.page("alice", second.nextCursor), { status: 410 });
    assert.ok(closed > 0);
  } finally { pager.closeProfile("alice"); }
});

test("server worker failures can be recovered and sign-out closes sessions", async () => {
  let closed = 0;
  const pager = createRecommendationPager({ start: async () => ({ next: async () => { throw new Error("network"); }, close: () => closed++ }) });
  await assert.rejects(pager.page("alice"), /network/);
  assert.equal(closed, 1);
  pager.closeProfile("alice");
});
