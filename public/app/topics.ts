import type { Video } from "./types.js";
// Shared by sample and connected profiles. Topics describe videos, not subscription groups.
// Feed entries often lack tags/descriptions; titles still work without fetching every video.
const RULES: [string, string, RegExp][] = [
  ["valorant", "Valorant", /\b(valorant|vct|radiant|paper rex)\b/u],
  ["apex", "Apex Legends", /\bapex(?:\s*legends)?\b/u],
  ["minecraft", "Minecraft", /\bminecraft\b/u],
  ["gaming", "Gaming", /\b(gaming|gameplay|esports|video games|fortnite|overwatch|marvel rivals|league of legends|counter strike|cs2|speedrun)\b/u],
  ["ai", "Artificial intelligence", /\b(ai|artificial\s*intelligence|machine\s*learning|llm|chatgpt|openai|claude|codex|deepseek)\b/u],
  ["coding", "Programming", /\b(programming|coding|javascript|typescript|python|react|software engineering|web development|rust|developer)\b/u],
  ["technology", "Technology", /\b(technology|tech|iphone|macbook|android|nvidia|gpu|linux|gadgets)\b/u],
  ["kpop", "K-pop", /\b(k[ -]?pop|blackpink|bts|twice|aespa|le sserafim|new ?jeans|stray kids|ive)\b|케이팝/u],
  ["music", "Music", /\b(music|official mv|music video|lyrics|lyric video|album|concert|singing|guitar|piano|remix|dj set)\b|뮤직/u],
  ["dance", "Dance", /\b(dance|dancing|choreography|choreo|1million)\b|안무|댄스/u],
  ["cooking", "Cooking", /\b(cooking|recipe|baking|chef|cookbook)\b|요리/u],
  ["food", "Food", /\b(food|mukbang|street food|restaurant|먹방)\b/u],
  ["travel", "Travel", /\b(travel|traveling|travelling|itinerary|backpacking)\b/u],
  ["fitness", "Fitness", /\b(fitness|workout|bodybuilding|weightlifting|pilates|yoga)\b/u],
  ["sports", "Sports", /\b(sports|football|soccer|basketball|nba|mma|ufc|formula 1|f1)\b/u],
  ["podcasts", "Podcasts", /\b(podcast|podcasts)\b/u],
  ["news", "News", /\b(news|politics|election|geopolitics)\b/u],
  ["science", "Science", /\b(science|physics|chemistry|biology|astronomy|space telescope)\b/u],
  ["history", "History", /\b(history|historical|ancient|archaeology)\b/u],
  ["film", "Film & animation", /\b(film|cinema|movie|animation|anime|trailer)\b/u],
];
const normalize = (text: string) => text.normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[_-]/g, " ");
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((s) => typeof s === "string") : [];
const ignored = new Set(["shorts", "short", "viral", "trending", "fyp", "foryou", "youtube", "youtubeshorts", "subscribe", "recommended"]);

function hashtags(video: Video) {
  const text = [video.title, video.description, ...strings(video.hashtags)].filter((s) => typeof s === "string").join(" ");
  const tags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_]{1,39})/gu)].map((m) => m[1]);
  // Some extractors expose hashtags without the leading #.
  tags.push(...strings(video.hashtags).map((s) => s.replace(/^#/, "")));
  return [...new Set(tags.map((s) => s.normalize("NFKC")))]
    .filter((s) => /^[\p{L}\p{N}][\p{L}\p{N}_]{1,39}$/u.test(s) && !ignored.has(s.toLowerCase()));
}

function classify(video: Video) {
  const hashes = hashtags(video);
  const text = normalize([video.title, ...strings(video.tags), ...strings(video.categories), ...hashes].filter((s) => typeof s === "string").join(" "));
  const found = new Map(RULES.filter(([, , rule]) => rule.test(text)).map(([id, label]) => [`topic:${id}`, label]));
  // Only fall back to the channel name when the video's own metadata gives no topic.
  if (!found.size) {
    const channel = normalize(video.ch?.name ?? video.channel ?? "");
    for (const [id, label, rule] of RULES) if (rule.test(channel)) found.set(`topic:${id}`, label);
  }
  for (const tag of hashes) {
    if (!RULES.some(([, , rule]) => rule.test(normalize(tag)))) found.set(`hashtag:${tag.toLowerCase()}`, `#${tag.toLowerCase()}`);
  }
  // Specific subjects also belong in their broader topic.
  if (["valorant", "apex", "minecraft"].some((id) => found.has(`topic:${id}`))) found.set("topic:gaming", "Gaming");
  if (found.has("topic:kpop")) found.set("topic:music", "Music");
  return found;
}

export const matchesTopic = (video: Video, id: string) => classify(video).has(id);

/** IDs -> matching video IDs; built from this feed only, with no account-specific rules or state. */
export function buildTopics(videos: Video[], limit = 12) {
  const topics = new Map<string, { id: string; label: string; videoIds: Set<string> }>();
  for (const video of videos) {
    for (const [id, label] of classify(video)) {
      if (!topics.has(id)) topics.set(id, { id, label, videoIds: new Set() });
      topics.get(id)!.videoIds.add(video.id);
    }
  }
  return [...topics.values()]
    .filter((topic) => !topic.id.startsWith("hashtag:") || topic.videoIds.size >= 2)
    .sort((a, b) => b.videoIds.size - a.videoIds.size || a.label.localeCompare(b.label, "en"))
    .slice(0, limit);
}
