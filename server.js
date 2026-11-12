import http from "node:http";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, PROFILE_RE } from "./server/account.js";
import { searchSuggestions, createChannelAvatars } from "./server/discovery.js";
import { youtubeSearchURL, searchShorts } from "./server/search.js";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const DATA = fileURLToPath(new URL("./data/", import.meta.url));
// large-v3-turbo is the fast, accurate transcriber but was trained without translation data, so
// it answers a translate request in the original language. Translation needs the full large-v3.
const WHISPER = {
  transcribe: { file: `${DATA}models/ggml-large-v3-turbo-q5_0.bin`, minBytes: 570e6 },
  translate: { file: `${DATA}models/ggml-large-v3-q5_0.bin`, minBytes: 1070e6 },
};
const ID_RE = /^[\w-]{11}$/;
const TTL = 30 * 60 * 1000; // stream URLs expire after a few hours
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2",
};

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    execFile("yt-dlp", args, { maxBuffer: 256 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(errOut || err.message)) : resolve(out),
    );
  });
}

const account = createAccount({ ytdlp });
const channelAvatar = createChannelAvatars();

// key -> { at, promise }; caching the promise also dedupes concurrent lookups
const cache = new Map();
function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

// YouTube throttles open-ended and large range requests to about 1.5x playback speed;
// ranges up to 10 MB are served at full speed, so the proxy fetches in chunks.
const CHUNK = 10 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mime = (kind, ext, codec) => `${kind}/${ext === "m4a" ? "mp4" : ext}; codecs="${codec}"`;
// yt-dlp reports WebM VP9 as a bare "vp9", which browsers' capability checks reject.
// Profile 0, 8-bit, with the level YouTube uses for each tier.
const VP9_LEVEL = { 144: 11, 240: 20, 360: 21, 480: 30, 720: 31, 1080: 40, 1440: 50, 2160: 50, 4320: 60 };
const vcodec = (f, quality) =>
  f.vcodec === "vp9" ? `vp09.00.${(VP9_LEVEL[quality] ?? 51) + (f.fps > 30 && quality >= 720 ? 1 : 0)}.08` : f.vcodec;

function pickFormats(j) {
  const direct = j.formats.filter((f) => f.protocol === "https" && f.url && !f.has_drm);
  // YouTube only starts serving a freshly signed URL a few seconds after issuing it
  // (available_at); fetching earlier returns 403.
  const urls = Object.fromEntries(direct.map((f) => [f.format_id, { url: f.url, at: (f.available_at ?? 0) * 1000 }]));
  const shape = (f) => ({
    id: f.format_id,
    // YouTube's own label ("2160p60") names the quality tier better than raw height
    // for vertical and ultrawide videos.
    quality: Number(/^(\d+)p/.exec(f.format_note ?? "")?.[1]) || f.height,
    width: f.width, height: f.height, fps: Math.round(f.fps ?? 30),
    bitrate: Math.round((f.tbr ?? 0) * 1000), ext: f.ext, vcodec: f.vcodec,
  });
  // HDR variants are skipped: without tone mapping they look washed out on SDR screens.
  const video = direct
    .filter((f) => f.vcodec !== "none" && f.acodec === "none" && (f.dynamic_range ?? "SDR") === "SDR")
    .map((f) => {
      const { ext, vcodec: codec, ...rest } = shape(f);
      return { ...rest, mime: mime("video", ext, vcodec({ vcodec: codec, fps: rest.fps }, rest.quality)) };
    });
  const tracks = direct.filter((f) => f.vcodec === "none" && f.acodec !== "none" && !f.format_id.endsWith("-drc"));
  const original = Math.max(...tracks.map((f) => f.language_preference ?? -1)); // skip dubbed tracks
  const audio = tracks
    .filter((f) => (f.language_preference ?? -1) === original)
    .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))
    .map((f) => ({ id: f.format_id, bitrate: Math.round((f.abr ?? 0) * 1000), mime: mime("audio", f.ext, f.acodec) }));
  const muxed = direct
    .filter((f) => f.vcodec !== "none" && f.acodec !== "none")
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((f) => {
      const { ext, vcodec: codec, ...rest } = shape(f);
      return { ...rest, mime: mime("video", ext, `${codec}, ${f.acodec}`) };
    });
  return { urls, video, audio, muxed };
}

// Uploaded captions are used as they are; YouTube's auto-generated track is offered only in the
// video's own language (the dozens of machine-translated tracks are noise).
function captionList(j) {
  const urls = {}, list = [];
  for (const [lang, fmts] of Object.entries(j.subtitles ?? {})) {
    if (lang === "live_chat") continue;
    const f = fmts.find((x) => x.ext === "json3");
    if (!f) continue;
    urls[`m:${lang}`] = f.url;
    list.push({ id: `m:${lang}`, lang, name: f.name ?? lang, kind: "manual" });
  }
  const auto = Object.entries(j.automatic_captions ?? {}).find(([k]) => k.endsWith("-orig") || k === j.language);
  if (auto) list.push({ id: `a:${auto[0]}`, lang: auto[0].replace(/-orig$/, ""), name: auto[1][0]?.name ?? auto[0], kind: "auto" });
  return { urls, list };
}
const vttTime = (ms) => new Date(Math.max(0, ms)).toISOString().slice(11, 23);
function json3ToVtt(j) {
  const out = ["WEBVTT", ""];
  for (const e of j.events ?? []) {
    const text = (e.segs ?? []).map((x) => x.utf8).join("").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
    if (text) out.push(`${vttTime(e.tStartMs)} --> ${vttTime(e.tStartMs + (e.dDurationMs ?? 2000))}`, text, "");
  }
  return out.join("\n");
}
// Whisper invents stock credits on silence and sometimes emits cues with no duration.
// Only a cue that IS one of these is dropped; a real sentence that mentions them is kept.
const HALLUCINATIONS = [/amara\.org/i, /^subtitles? (made )?by\b/i, /^captions? by\b/i, /^thank(s| you) for watching\W*$/i, /^시청해 주셔서 감사합니다\W*$/, /^자막 제공\b/, /^ご視聴ありがとう(ございました)?\W*$/];
const isHallucination = (text) => { const t = text.replace(/\s+/g, " ").trim(); return t.length < 90 && HALLUCINATIONS.some((re) => re.test(t)); };
function tidyVtt(text) {
  const ms = (t) => t.trim().replace(",", ".").split(":").reduce((n, x) => n * 60 + parseFloat(x), 0) * 1000;
  const cues = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n"), at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const body = lines.slice(at + 1).join("\n").trim();
    if (body && !isHallucination(body)) cues.push({ start: ms(a), end: ms(b), text: body });
  }
  // A cue with no duration can't be shown; fold it into the line before it.
  for (let i = cues.length - 1; i > 0; i--) {
    const c = cues[i], prev = cues[i - 1];
    if (c.end - c.start < 300 && c.start - prev.end <= 1500 && prev.text.length + c.text.length < 110) { prev.text = `${prev.text} ${c.text}`.replace(/\s+/g, " "); prev.end = Math.max(prev.end, c.end); cues.splice(i, 1); }
  }
  cues.forEach((c, i) => { if (c.end - c.start < 700) c.end = Math.max(c.end, Math.min(cues[i + 1]?.start ?? c.start + 2000, c.start + 2500)); });
  return ["WEBVTT", "", ...cues.flatMap((c) => [`${vttTime(c.start)} --> ${vttTime(c.end)}`, c.text, ""])].join("\n");
}
// YouTube's auto-caption VTT repeats each line as it scrolls; keep each line once.
function cleanRollingVtt(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n"), at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->").map((x) => x.trim().split(/\s/)[0]);
    const last = lines.slice(at + 1).map((l) => l.replace(/<[^>]+>/g, "").trim()).filter(Boolean).at(-1);
    if (last && last !== cues.at(-1)?.text) cues.push({ a, b, text: last });
  }
  return ["WEBVTT", "", ...cues.flatMap((c) => [`${c.a} --> ${c.b}`, c.text, ""])].join("\n");
}
async function youtubeCaptions(id, cid) {
  const info = await getInfo(id);
  if (cid.startsWith("m:")) {
    const url = info.captionUrls[cid];
    if (!url) throw new Error("unknown caption track");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`captions ${r.status}`);
    return json3ToVtt(await r.json());
  }
  const lang = cid.slice(2), dir = `${DATA}tmp/yt-${id}`;
  await mkdir(dir, { recursive: true });
  await ytdlp(["--skip-download", "--no-playlist", "--write-auto-subs", "--sub-langs", lang, "--sub-format", "vtt", "-o", `${dir}/%(id)s`, `https://www.youtube.com/watch?v=${id}`]);
  const file = (await import("node:fs/promises").then((m) => m.readdir(dir))).find((f) => f.endsWith(".vtt"));
  if (!file) throw new Error("no auto captions");
  const text = cleanRollingVtt(await readFile(`${dir}/${file}`, "utf8"));
  await rm(dir, { recursive: true, force: true });
  return text;
}

const NEEDS_LOGIN = /sign in to confirm your age|age-restricted|members-only|join this channel|private video|this video is private|sign in to confirm you/i;
function getInfo(id, profile) {
  return cached(`info:${id}`, TTL, async () => {
    const args = ["-J", "--no-playlist", `https://www.youtube.com/watch?v=${id}`];
    let raw;
    try { raw = await ytdlp(args); }
    catch (e) {
      // Only a video that needs a login uses the account; everything else plays without it.
      if (!profile || !NEEDS_LOGIN.test(e.message) || !(await account.status(profile)).connected) throw e;
      raw = await account.auth(profile, args);
    }
    const j = JSON.parse(raw);
    const { urls, ...formats } = pickFormats(j);
    const captions = captionList(j);
    if (!formats.video.length && !formats.muxed.length) {
      throw new Error(j.is_live ? "Live streams aren't supported yet" : "No playable formats found");
    }
    return {
      urls,
      pub: {
        id, title: j.title, description: j.description, duration: j.duration,
        channel: j.channel, channelId: j.channel_id, handle: j.uploader_id,
        verified: !!j.channel_is_verified, subscribers: j.channel_follower_count,
        views: j.view_count, likes: j.like_count, comments: j.comment_count,
        timestamp: j.timestamp, tags: j.tags ?? [], categories: j.categories ?? [],
        chapters: j.chapters ?? [], heatmap: j.heatmap ?? [], thumbnail: j.thumbnail,
        language: j.language ?? null, captions: captions.list,
        ...formats,
      },
      captionUrls: captions.urls,
    };
  });
}

const flatEntry = (e) => ({
  id: e.id, title: e.title, duration: e.duration, views: e.view_count,
  channel: e.channel ?? e.uploader, channelId: e.channel_id, verified: !!e.channel_is_verified,
  timestamp: e.timestamp ?? null, live: e.live_status === "is_live", short: e.url?.includes("/shorts/") ?? false,
  description: e.description ?? "",
  thumbnail: e.thumbnail ?? [...(e.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null,
});

function search(q, filters) {
  const url = youtubeSearchURL(q, filters);
  return cached(`search:${url}`, 10 * 60 * 1000, async () => {
    if (filters?.type === "shorts") return searchShorts(url);
    const j = JSON.parse(await ytdlp(["-J", "--flat-playlist", "--playlist-items", "1-60", "--extractor-args", "youtubetab:approximate_date", url]));
    return (j.entries ?? []).filter((e) => ID_RE.test(e.id)).map(flatEntry);
  });
}

function comments(id) {
  return cached(`comments:${id}`, TTL, async () => {
    const j = JSON.parse(await ytdlp([
      "-J", "--no-playlist", "--skip-download", "--write-comments",
      "--extractor-args", "youtube:max_comments=30,30,0,0;comment_sort=top",
      `https://www.youtube.com/watch?v=${id}`,
    ]));
    return (j.comments ?? []).map((c) => ({
      author: c.author, avatar: c.author_thumbnail, text: c.text, likes: c.like_count ?? 0,
      timestamp: c.timestamp, pinned: !!c.is_pinned, hearted: !!c.is_favorited, byUploader: !!c.author_is_uploader,
    }));
  });
}

// Channel avatars come from a host that rate-limits browsers; fetch each once and keep it.
const IMG_HOSTS = new Set(["yt3.googleusercontent.com", "yt3.ggpht.com", "i.ytimg.com", "i9.ytimg.com"]);
function image(url) {
  return cached(`img:${url}`, 24 * 60 * 60 * 1000, async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`image ${r.status}`);
    return { type: r.headers.get("content-type") ?? "image/jpeg", body: Buffer.from(await r.arrayBuffer()) };
  });
}

// --- AI captions: yt-dlp fetches the audio, whisper.cpp transcribes it on this machine ---------
const aiFile = (id, task) => `${DATA}captions/${id}.${task}.vtt`;
const jobs = new Map(); // "id:task" -> { state, stage, progress, error }
const queue = [];
let busy = false;
const exists = (p) => stat(p).then(() => true, () => false);
const run = (cmd, args, onLine) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  let tail = "";
  child.stderr.on("data", (d) => { tail = (tail + d).slice(-4000); onLine?.(String(d)); });
  child.on("error", reject);
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split("\n").pop() || `${cmd} exited ${code}`))));
});

const modelReady = async (task) => (await stat(WHISPER[task].file).then((s) => s.size, () => 0)) >= WHISPER[task].minBytes;
async function aiStatus(id, task) {
  const ready = (await modelReady(task)) && (await exists("/opt/homebrew/bin/whisper-cli"));
  if (await exists(aiFile(id, task))) return { available: ready, state: "done" };
  return { available: ready, ...(jobs.get(`${id}:${task}`) ?? { state: "idle" }) };
}
function aiStart(id, task, lang) {
  const key = `${id}:${task}`;
  if (jobs.get(key)?.state === "running" || jobs.get(key)?.state === "queued") return;
  jobs.set(key, { state: "queued", stage: "Waiting for another transcription to finish", progress: 0 });
  queue.push(() => aiRun(id, task, lang));
  pump();
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await queue.shift()();
  busy = false;
}
async function aiRun(id, task, lang) {
  const key = `${id}:${task}`, job = { state: "running", stage: "Downloading audio", progress: 0 };
  jobs.set(key, job);
  const tmp = `${DATA}tmp/${id}`;
  try {
    await mkdir(`${DATA}tmp`, { recursive: true });
    await mkdir(`${DATA}captions`, { recursive: true });
    await run("yt-dlp", ["--no-playlist", "-f", "ba/b", "-x", "--audio-format", "wav", "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1", "-o", `${tmp}.%(ext)s`, `https://www.youtube.com/watch?v=${id}`]);
    const transcribe = async (language) => {
      job.stage = "Transcribing"; job.progress = 0;
      const args = ["-m", WHISPER[task].file, "-f", `${tmp}.wav`, "-l", language, "-ovtt", "-of", `${tmp}.${task}`, "-pp", "-np", "-ml", "48", "-sow", "-t", "8"];
      if (task === "translate") args.push("-tr");
      await run("whisper-cli", args, (chunk) => { const m = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)].at(-1); if (m) job.progress = Number(m[1]); });
    };
    const code = (lang ?? "auto").split("-")[0].toLowerCase();
    await transcribe(code).catch((e) => (code === "auto" ? Promise.reject(e) : transcribe("auto")));
    if (task === "translate") {
      // Refuse to cache a "translation" that is still mostly non-Latin text.
      const body = (await readFile(`${tmp}.translate.vtt`, "utf8")).split("\n").filter((l) => !l.includes("-->") && l !== "WEBVTT").join("");
      const letters = body.match(/\p{L}/gu) ?? [], latin = body.match(/\p{Script=Latin}/gu) ?? [];
      if (letters.length > 20 && latin.length / letters.length < 0.7) throw new Error("The translation came back untranslated.");
    }
    await rename(`${tmp}.${task}.vtt`, aiFile(id, task));
    jobs.delete(key);
  } catch (e) {
    jobs.set(key, { state: "error", error: String(e.message).slice(0, 300) });
  } finally {
    await rm(`${tmp}.wav`, { force: true }); await rm(`${tmp}.${task}.vtt`, { force: true });
  }
}

// Anything that touches the account must come from this app's own pages. A page on another site
// (or a DNS-rebinding trick) can send requests to localhost, but it can't pass this check.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function sameOrigin(req) {
  if (!HOSTS.has(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  const site = req.headers["sec-fetch-site"];
  return !site || site === "same-origin" || site === "none";
}

// A channel's recent uploads, for channels that aren't in the bundled sample data.
const channelPage = (cid) => cached(`chan:${cid}`, 10 * 60 * 1000, async () => {
  const j = JSON.parse(await ytdlp(["-J", "--flat-playlist", "--playlist-items", "1-36", "--extractor-args", "youtubetab:approximate_date", `https://www.youtube.com/channel/${cid}/videos`]));
  const avatar = j.thumbnails?.find((t) => t.id === "avatar_uncropped")?.url;
  return {
    id: cid, name: j.channel ?? j.title, handle: j.uploader_id ?? null, subs: j.channel_follower_count ?? null, verified: !!j.channel_is_verified,
    avatar: avatar ? `${avatar.replace(/=.*$/, "")}=s96-c-k-c0x00ffffff-no-rj` : null,
    videos: (j.entries ?? []).filter((e) => e.id && e.title).map((e) => ({ id: e.id, title: e.title, duration: e.duration ?? null, views: e.view_count ?? null, timestamp: e.timestamp ?? null, live: e.live_status === "is_live", channel: j.channel, channelId: cid })),
  };
});

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function stream(req, res, id, fid, retry = true) {
  const { urls } = await getInfo(id);
  const target = urls[fid];
  if (!target) return json(res, 404, { error: "unknown format" });
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const wait = target.at + 500 - Date.now();
  if (wait > 0) await sleep(wait);
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  let pos = range ? Number(range[1]) : 0;
  let end = range?.[2] ? Number(range[2]) : Infinity;
  const fetchChunk = () =>
    fetch(target.url, { headers: { range: `bytes=${pos}-${Math.min(end, pos + CHUNK - 1)}` }, signal: abort.signal });

  let upstream = await fetchChunk();
  if (upstream.status === 403 && retry) {
    // The signed URL expired; resolve a fresh one once.
    await upstream.body?.cancel();
    cache.delete(`info:${id}`);
    return stream(req, res, id, fid, false);
  }
  const total = Number(/\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "")?.[1]);
  if (upstream.status !== 206 || !total) {
    await upstream.body?.cancel();
    return json(res, upstream.status === 416 ? 416 : 502, { error: `upstream ${upstream.status}` });
  }
  end = Math.min(end, total - 1);
  res.writeHead(range ? 206 : 200, {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "content-length": end - pos + 1,
    "accept-ranges": "bytes",
    ...(range && { "content-range": `bytes ${pos}-${end}/${total}` }),
  });
  while (true) {
    for await (const buf of upstream.body) {
      pos += buf.length;
      if (!res.write(buf)) await once(res, "drain", { signal: abort.signal });
    }
    if (pos > end) return res.end();
    upstream = await fetchChunk();
    if (upstream.status !== 206) return res.destroy();
  }
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: "bad path" }); }
  let rel = normalize(decoded).replace(/^[/\\]+/, "");
  if (rel.startsWith("..")) return json(res, 400, { error: "bad path" });
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  try {
    const file = join(PUBLIC, rel), info = await stat(file);
    // no-cache means "ask me each time"; the ETag makes the answer a 304 with no body when nothing changed.
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache", etag };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    json(res, 404, { error: "not found" });
  }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const id = u.searchParams.get("v") ?? "";
  try {
    switch (u.pathname) {
      case "/api/info": {
        if (!ID_RE.test(id)) return json(res, 400, { error: "bad video id" });
        const p = u.searchParams.get("p");
        return json(res, 200, (await getInfo(id, PROFILE_RE.test(p ?? "") ? p : null)).pub);
      }
      case "/api/channel": {
        const cid = u.searchParams.get("id") ?? "";
        if (!/^UC[\w-]{22}$/.test(cid)) return json(res, 400, { error: "bad channel id" });
        return json(res, 200, await channelPage(cid));
      }
      case "/api/account": case "/api/account/connect": case "/api/account/disconnect": case "/api/account/channels": case "/api/account/feed": case "/api/account/shorts": case "/api/account/recommendations": {
        if (!sameOrigin(req)) return json(res, 403, { error: "Account endpoints only answer to this app." });
        const p = u.searchParams.get("p") ?? "";
        if (!PROFILE_RE.test(p)) return json(res, 400, { error: "bad profile" });
        const post = req.method === "POST";
        if (u.pathname === "/api/account") return json(res, 200, await account.status(p));
        if (u.pathname === "/api/account/connect") {
          if (!post) return json(res, 405, { error: "POST only" });
          return json(res, 200, await account.connect(p, u.searchParams.get("browser") ?? ""));
        }
        if (u.pathname === "/api/account/disconnect") {
          if (!post) return json(res, 405, { error: "POST only" });
          await account.disconnect(p);
          return json(res, 200, { connected: false });
        }
        if (!(await account.status(p)).connected) return json(res, 401, { error: "Not connected to a YouTube account." });
        if (u.pathname === "/api/account/recommendations") {
          try { return json(res, 200, await account.recommendations.page(p, u.searchParams.get("cursor") ?? "")); }
          catch (error) { return json(res, error.status ?? 502, { error: error.message }); }
        }
        const opts = { fresh: u.searchParams.get("fresh") === "1" };
        if (u.pathname === "/api/account/channels") return json(res, 200, await account.channels(p, opts));
        if (u.pathname === "/api/account/shorts") return json(res, 200, await account.shorts(p, opts));
        return json(res, 200, await account.feed(p, u.searchParams.get("kind") ?? "", opts));
      }
      case "/api/comments":
        if (!ID_RE.test(id)) return json(res, 400, { error: "bad video id" });
        return json(res, 200, await comments(id));
      case "/api/search": {
        const q = (u.searchParams.get("q") ?? "").trim().slice(0, 200);
        if (!q) return json(res, 400, { error: "empty query" });
        return json(res, 200, await search(q, Object.fromEntries(u.searchParams)));
      }
      case "/api/search-suggestions": {
        const q = (u.searchParams.get("q") ?? "").trim().slice(0, 200);
        if (!q) return json(res, 200, []);
        return json(res, 200, await cached(`suggest:${q}`, 10 * 60 * 1000, () => searchSuggestions(q)));
      }
      case "/api/channel-avatar": {
        const cid = u.searchParams.get("id") ?? "";
        const video = u.searchParams.get("v") ?? "";
        if (!/^UC[\w-]{22}$/.test(cid) && !ID_RE.test(video)) return json(res, 400, { error: "bad channel or video id" });
        const img = await image(await channelAvatar(cid || `video:${video}`));
        res.writeHead(200, { "content-type": img.type, "cache-control": "public, max-age=86400" });
        return res.end(img.body);
      }
      case "/api/captions": {
        if (!ID_RE.test(id)) return json(res, 400, { error: "bad video id" });
        const text = await cached(`cc:${id}:${u.searchParams.get("c")}`, TTL, () => youtubeCaptions(id, u.searchParams.get("c") ?? ""));
        res.writeHead(200, { "content-type": "text/vtt; charset=utf-8" });
        return res.end(text);
      }
      case "/api/ai-captions": {
        if (!ID_RE.test(id)) return json(res, 400, { error: "bad video id" });
        const task = u.searchParams.get("task") ?? "transcribe";
        if (!["transcribe", "translate"].includes(task)) return json(res, 400, { error: "task must be transcribe or translate" });
        if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "GET or POST only" });
        const status = await aiStatus(id, task);
        if (req.method === "POST") {
          if (!status.available) return json(res, 503, { error: "Whisper isn't installed on this machine." });
          if (status.state !== "done") aiStart(id, task, u.searchParams.get("lang"));
          return json(res, 202, await aiStatus(id, task));
        }
        return json(res, 200, status);
      }
      case "/api/ai-captions.vtt": {
        const task = u.searchParams.get("task") ?? "transcribe";
        if (!["transcribe", "translate"].includes(task)) return json(res, 400, { error: "task must be transcribe or translate" });
        if (req.method !== "GET") return json(res, 405, { error: "GET only" });
        if (!ID_RE.test(id) || !(await exists(aiFile(id, task)))) return json(res, 404, { error: "not generated yet" });
        res.writeHead(200, { "content-type": "text/vtt; charset=utf-8" });
        return res.end(tidyVtt(await readFile(aiFile(id, task), "utf8")));
      }
      case "/api/ai-captions/clear":
        if (req.method !== "POST") return json(res, 405, { error: "POST only" });
        await rm(`${DATA}captions`, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      case "/api/img": {
        let target;
        try { target = new URL(u.searchParams.get("u") ?? ""); } catch { return json(res, 400, { error: "bad url" }); }
        if (target.protocol !== "https:" || !IMG_HOSTS.has(target.hostname)) return json(res, 400, { error: "host not allowed" });
        const img = await image(target.href);
        res.writeHead(200, { "content-type": img.type, "cache-control": "public, max-age=86400" });
        return res.end(img.body);
      }
      case "/stream":
        if (!ID_RE.test(id)) return json(res, 400, { error: "bad video id" });
        return await stream(req, res, id, u.searchParams.get("f") ?? "");
      default:
        return await serveStatic(req, res, u.pathname);
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    // yt-dlp prefixes its messages with "ERROR: [youtube] <id>:"; the person reading this doesn't need that.
    const message = String(e.message).trim().split("\n").pop().replace(/^ERROR:\s*(\[[^\]]+\]\s*)?(?:[\w-]{11}:\s*)?/, "").slice(0, 300);
    if (!res.headersSent) json(res, 500, { error: message });
    else res.destroy();
  }
}).listen(PORT, "127.0.0.1", () => { console.log(`http://localhost:${PORT}`); account.warm(); });
