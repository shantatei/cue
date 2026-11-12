// Builds public/app/fixture.json: real channels and recent uploads for the design
// prototypes. Subscription names come from the owner's screenshots; the grouping is a guess.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";

const run = (args) =>
  new Promise((resolve) =>
    execFile("yt-dlp", ["-J", "--flat-playlist", ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
      resolve(err ? null : JSON.parse(out)),
    ),
  );

// [group, name as shown in YouTube, handle or search query]
const SUBS = [
  ["val", "100 Thieves", "@100Thieves"], ["val", "100 Thieves Valorant", "@100ThievesValorant"],
  ["val", "aceu", "?aceu valorant"], ["val", "Subroza", "?Subroza"], ["val", "ValoCook", "?ValoCook"],
  ["val", "[ Daily Dose Of Tarik ]", "?Daily Dose Of Tarik"], ["val", "Aleksib", "?Aleksib"],
  ["val", "Akshon", "?Akshon Esports"], ["val", "adreN", null], ["val", "Albralelie", null],
  ["val", "AdamXLegend", null], ["val", "Adapt Gaming", null], ["val", "Agent Gumle", null],
  ["val", "Aimbottz", null], ["val", "Airen", null], ["val", "Akjon", null], ["val", "Ahrora", null],
  ["val", "Alvo", null], ["val", "A10", null],
  ["kr", "피식대학Psick Univ", "?피식대학 Psick Univ"], ["kr", "허블렛 Hubblet", "?허블렛 Hubblet"],
  ["kr", "키즐 kizzle", "?키즐 kizzle"], ["kr", "또모TOWMOO", "?또모TOWMOO"],
  ["kr", "하이틴에이저 Hi-teenager", null], ["kr", "표애플 Pyoapple", null],
  ["kr", "표은지Eunji Pyoapple", null], ["kr", "천가을tv", null], ["kr", "한갱", null],
  ["kr", "쌍타쿠", null], ["kr", "A-YEON", null], ["kr", "Achapi", null], ["kr", "Agartube", null],
  ["kr", "[Awesome Haeun]어썸하은", null],
  ["mus", "1MILLION Dance Studio", "@1MILLIONDance_official"], ["mus", "aespa", "?aespa"],
  ["mus", "Alan Walker", "?Alan Walker"], ["mus", "AFTERHOURS", null],
  ["dev", "Claude", "@claude"], ["dev", "(x)rnavkha", "@xrnavkha"], ["dev", "Always Creating", null],
  ["dev", "A Ashraf", null],
  ["misc", "1-UP Gaming", "@1-UPGaming"], ["misc", "Popping SG", "?Popping SG"],
];
const GROUPS = [
  { id: "val", code: "VL", name: "Valorant & esports" },
  { id: "kr", code: "KR", name: "Korean creators" },
  { id: "mus", code: "MD", name: "Music & dance" },
  { id: "dev", code: "DV", name: "Software & AI" },
  { id: "misc", code: "GN", name: "Everything else" },
];
const SHORTS = ["@100Thieves", "@1MILLIONDance_official"];

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

async function resolve(source, name) {
  if (source.startsWith("@")) return `https://www.youtube.com/${source}`;
  const found = await run([`ytsearch5:${source.slice(1)}`]);
  const want = norm(name);
  const hit = found?.entries.find((e) => e.channel && (norm(e.channel).includes(want) || want.includes(norm(e.channel))));
  return hit ? `https://www.youtube.com/channel/${hit.channel_id}` : null;
}

async function channel(url) {
  const j = await run(["--playlist-items", "1-6", "--extractor-args", "youtubetab:approximate_date", `${url}/videos`]);
  if (!j) return null;
  const avatar = j.thumbnails?.find((t) => t.id === "avatar_uncropped")?.url ?? null;
  return {
    channel: {
      id: j.channel_id, name: j.channel, handle: j.uploader_id, subs: j.channel_follower_count ?? null,
      verified: !!j.channel_is_verified, avatar: avatar && `${avatar.replace(/=.*$/, "")}=s96-c-k-c0x00ffffff-no-rj`,
    },
    videos: j.entries.filter((e) => e.duration).map((e) => ({
      id: e.id, title: e.title, duration: e.duration, views: e.view_count ?? null,
      timestamp: e.timestamp ?? null, channelId: j.channel_id,
    })),
  };
}

async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const fetched = await pool(SUBS, 6, async ([group, name, source]) => {
  if (!source) return { group, name };
  const url = await resolve(source, name);
  const data = url && (await channel(url));
  console.error(data ? `ok   ${name} -> ${data.channel.name} (${data.videos.length})` : `miss ${name}`);
  return { group, name, ...data };
});
const shorts = (await pool(SHORTS, 2, async (handle) => {
  const j = await run(["--playlist-items", "1-7", `https://www.youtube.com/${handle}/shorts`]);
  return (j?.entries ?? []).map((e) => ({ id: e.id, title: e.title, views: e.view_count ?? null, channelId: j.channel_id }));
})).flat();

await writeFile(new URL("../public/app/fixture.json", import.meta.url), JSON.stringify({
  generated: new Date().toISOString(),
  groups: GROUPS,
  channels: fetched.filter((f) => f.channel).map((f) => f.channel),
  subscriptions: fetched.map((f) => ({ name: f.name, group: f.group, channelId: f.channel?.id ?? null })),
  videos: fetched.flatMap((f) => f.videos ?? []),
  shorts,
}, null, 1));
