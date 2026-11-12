import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTopics } from "../public/app/topics.js";

const members = (videos, id) => [...(buildTopics(videos).find((t) => t.id === id)?.videoIds ?? [])];

test("uses per-video subjects rather than the old subscription groups", () => {
  const videos = [
    { id: "game", title: "VCT finals", group: { id: "music" } },
    { id: "song", title: "Official music video", ch: { name: "Valorant channel" } },
    { id: "other", title: "Our weekend", group: { id: "val" } },
  ];
  assert.deepEqual(members(videos, "topic:valorant"), ["game"]);
  assert.deepEqual(members(videos, "topic:gaming"), ["game"]);
  assert.deepEqual(members(videos, "topic:music"), ["song"]);
});

test("recognizes tags, categories and hashtags including camel case and Unicode", () => {
  const videos = [
    { id: "a", title: "Highlights #ApexLegends" },
    { id: "b", tags: ["MachineLearning"] },
    { id: "c", categories: ["Music"] },
    { id: "d", description: "Watch now #VALORANT" },
    { id: "e", hashtags: ["#Kpop"] },
    { id: "f", title: "새 영상 #댄스" },
  ];
  for (const [topic, id] of [["apex", "a"], ["ai", "b"], ["music", "c"], ["valorant", "d"], ["kpop", "e"], ["dance", "f"]]) {
    assert.ok(members(videos, `topic:${topic}`).includes(id), topic);
  }
  assert.ok(members(videos, "topic:music").includes("e"));
});

test("promotes repeated niche hashtags, omits generic and one-off hashtags", () => {
  const videos = [
    { id: "a", title: "#Woodworking #woodworking #Shorts #Unique #목공" },
    { id: "b", description: "#woodworking #목공 #viral", hashtags: ["woodworking"] },
  ];
  assert.deepEqual(members(videos, "hashtag:woodworking"), ["a", "b"]);
  assert.deepEqual(members(videos, "hashtag:목공"), ["a", "b"]);
  assert.equal(buildTopics(videos).length, 2);
});

test("falls back to a recognizable channel only without video topic evidence", () => {
  assert.deepEqual(members([{ id: "a", title: "Grand finals", channel: "Valorant" }], "topic:valorant"), ["a"]);
  assert.deepEqual(members([{ id: "a", title: "Cooking a recipe", channel: "Valorant" }], "topic:valorant"), []);
});

test("does not match partial words or fail on unavailable metadata", () => {
  assert.deepEqual(buildTopics([{ id: "a", title: "Chair repair" }, { id: "b", tags: null, categories: {}, hashtags: [null, 4], description: null }]), []);
  assert.deepEqual(buildTopics([]), []);
});

test("counts distinct videos, ranks deterministically, caps topics, and does not mutate input", () => {
  const videos = [{ id: "a", title: "Music and coding" }, { id: "b", title: "Music" }, { id: "a", title: "Music and coding" }];
  const before = JSON.stringify(videos);
  const topics = buildTopics(videos);
  assert.equal(topics[0].id, "topic:music");
  assert.equal(topics[0].videoIds.size, 2);
  assert.deepEqual(buildTopics([...videos].reverse()), topics);
  assert.equal(buildTopics(videos, 1).length, 1);
  assert.equal(JSON.stringify(videos), before);
});

test("sample and connected video shapes use identical rules", async () => {
  const fixture = JSON.parse(await readFile(new URL("../public/app/fixture.json", import.meta.url)));
  const sample = fixture.videos;
  const connected = sample.map(({ group, ...video }) => ({ ...video, group: { id: "all" } }));
  assert.deepEqual(buildTopics(sample), buildTopics(connected));
  assert.ok(buildTopics(sample).some((t) => t.id === "topic:valorant"));
  assert.ok(buildTopics(sample).every((t) => t.videoIds.size > 0));
});
