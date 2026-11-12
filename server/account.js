// A YouTube account connected through the browser's own login session.
//
// The login cookies for youtube.com and google.com are copied out of the browser once (see
// scripts/export-cookies.py: nothing for any other site is read to disk) into
// data/accounts/<profile>/cookies.txt, readable only by this user. yt-dlp then uses that file to read
// the account's subscriptions, history, Watch later, Liked videos and recommendations.
// Playback never uses it unless a video needs a login (age-restricted, members-only, private).
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRecommendationPager, startRecommendationWorker } from "./recommendations.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCOUNTS = process.env.OWN_ACCOUNTS_DIR ? `${process.env.OWN_ACCOUNTS_DIR.replace(/\/?$/, "/")}` : `${ROOT}data/accounts/`;
const BROWSERS = ["chrome", "brave", "edge", "firefox", "safari", "vivaldi", "opera", "chromium"];
const LOGIN_FAILED = /Login details are needed|Sign in to confirm|sign in to|cookies? .*(invalid|expired|no longer valid)|account cookies/i;
const MIN = 60 * 1000;
const MAX_STALE = 12 * 60 * MIN;                         // older than this, wait for a real refresh
const TTL_SCALE = Number(process.env.OWN_TTL_SCALE) || 1; // tests shrink it

export const PROFILE_RE = /^[\w-]{1,40}$/;
const dirOf = (p) => `${ACCOUNTS}${p}/`;
const readJSON = async (path) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } };

let pythonPath;
async function yt_dlp_python() {
  pythonPath ??= await new Promise((resolve, reject) => execFile("sh", ["-c", 'head -1 "$(readlink -f "$(command -v yt-dlp)")"'], (err, out) => {
    const m = /^#!\s*(\S+)/.exec(out ?? "");
    err || !m ? reject(new Error("Couldn't find yt-dlp's Python environment.")) : resolve(m[1]);
  }));
  return pythonPath;
}

export function createAccount({ ytdlp }) {
  const cache = new Map();   // "profile:key" -> { at, value }
  const locks = new Map();   // one yt-dlp at a time per profile: it rewrites the cookie file when it finishes

  const withLock = (p, fn) => {
    const next = (locks.get(p) ?? Promise.resolve()).then(fn, fn);
    locks.set(p, next.catch(() => {}));
    return next;
  };
  const recommendations = createRecommendationPager({ start: (p) => withLock(p, async () =>
    startRecommendationWorker(await yt_dlp_python(), `${dirOf(p)}cookies.txt`)) });
  /**
   * Stale-while-revalidate. Within `ttl` the saved copy is returned. After that the old copy is still
   * returned immediately while one background refresh runs, so a page load never waits on yt-dlp
   * (it takes seconds). `fresh` skips the saved copy for callers that must be current, such as the
   * History page. Concurrent refreshes of the same list share one yt-dlp run.
   */
  // The lists are also kept on disk (next to the login, same permissions), so restarting the server
  // doesn't start from nothing: the saved copy is served at once and refreshed in the background.
  const hydrated = new Map();
  const hydrate = (p) => {
    if (!hydrated.has(p)) hydrated.set(p, readJSON(`${dirOf(p)}cache.json`).then((saved) => {
      for (const [key, e] of Object.entries(saved ?? {})) if (e?.value !== undefined && !cache.has(`${p}:${key}`)) cache.set(`${p}:${key}`, { at: e.at, value: e.value, loading: null });
    }));
    return hydrated.get(p);
  };
  const saving = new Map();
  const persist = (p) => {
    clearTimeout(saving.get(p));
    saving.set(p, setTimeout(async () => {
      const out = {};
      for (const [k, e] of cache) if (k.startsWith(`${p}:`) && e.value !== undefined) out[k.slice(p.length + 1)] = { at: e.at, value: e.value };
      try { await writeFile(`${dirOf(p)}cache.json.tmp`, JSON.stringify(out), { mode: 0o600 }); await rename(`${dirOf(p)}cache.json.tmp`, `${dirOf(p)}cache.json`); } catch {}
    }, 1500));
  };
  const cached = async (p, key, ttl, load, { fresh = false } = {}) => {
    await hydrate(p);
    const k = `${p}:${key}`, hit = cache.get(k), age = hit?.value === undefined ? Infinity : Date.now() - hit.at;
    const refresh = () => {
      if (cache.get(k)?.loading) return cache.get(k).loading;
      const loading = load().then(
        (value) => { cache.set(k, { at: Date.now(), value, loading: null }); persist(p); return value; },
        (err) => { const cur = cache.get(k); if (cur) cache.set(k, { ...cur, loading: null }); throw err; },
      );
      cache.set(k, { at: hit?.at ?? 0, value: hit?.value, loading });
      return loading;
    };
    if (!fresh && age < ttl * TTL_SCALE) return hit.value;
    if (!fresh && age < MAX_STALE) { refresh().catch(() => {}); return hit.value; }
    return refresh();
  };
  const forget = (p) => { recommendations.closeProfile(p); for (const k of cache.keys()) if (k.startsWith(`${p}:`)) cache.delete(k); hydrated.delete(p); clearTimeout(saving.get(p)); };

  async function status(p) {
    const m = await readJSON(`${dirOf(p)}account.json`);
    return m ? { connected: true, browser: m.browser, since: m.connectedAt, needsReconnect: !!m.needsReconnect } : { connected: false };
  }
  async function setMeta(p, patch) {
    const m = (await readJSON(`${dirOf(p)}account.json`)) ?? {};
    await writeFile(`${dirOf(p)}account.json`, JSON.stringify({ ...m, ...patch }), { mode: 0o600 });
  }

  /** Runs yt-dlp as this profile's account. A rejected login flags the profile for reconnecting. */
  function auth(p, args) {
    return withLock(p, async () => {
      const file = `${dirOf(p)}cookies.txt`;
      if (!(await stat(file).then(() => true, () => false))) throw new Error("Not connected to a YouTube account.");
      try { return await ytdlp(["--cookies", file, ...args]); }
      catch (e) {
        if (LOGIN_FAILED.test(e.message)) { await setMeta(p, { needsReconnect: true }); throw new Error("YouTube no longer accepts the saved login. Reconnect your account in Settings."); }
        throw e;
      } finally { await chmod(file, 0o600).catch(() => {}); }
    });
  }

  async function connect(p, browser) {
    if (!BROWSERS.includes(browser)) throw new Error("That browser isn't supported.");
    await mkdir(dirOf(p), { recursive: true, mode: 0o700 });
    const py = await yt_dlp_python();
    const out = await new Promise((resolve, reject) => {
      const child = spawn(py, [`${ROOT}scripts/export-cookies.py`, browser, `${dirOf(p)}cookies.txt`], { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("Timed out waiting for the browser. If macOS asked for Keychain access, allow it and try again.")); }, 2 * MIN);
      child.stdout.on("data", (d) => { text += d; });
      child.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(text.trim().split("\n").pop())); } catch { reject(new Error("Couldn't read the browser's cookies.")); } });
      child.on("error", reject);
    });
    if (!out.ok) { await rm(`${dirOf(p)}cookies.txt`, { force: true }); throw new Error(out.error); }
    try {   // prove the login works before calling it connected
      await ytdlp(["--cookies", `${dirOf(p)}cookies.txt`, "-J", "--flat-playlist", "--playlist-items", "1", "https://www.youtube.com/feed/channels"]);
    } catch (e) {
      await rm(`${dirOf(p)}cookies.txt`, { force: true });
      throw new Error(LOGIN_FAILED.test(e.message) ? `${browser} has YouTube cookies but YouTube doesn't accept them. Open YouTube there, make sure you're signed in, and try again.` : e.message);
    }
    await writeFile(`${dirOf(p)}account.json`, JSON.stringify({ browser, connectedAt: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
    forget(p);
    return status(p);
  }

  async function disconnect(p) { await rm(dirOf(p), { recursive: true, force: true }); forget(p); }

  const https = (u) => (u?.startsWith("//") ? `https:${u}` : u ?? null);
  const best = (thumbs) => https([...(thumbs ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url);

  const channels = (p, opts) => cached(p, "channels", 30 * MIN, async () => {
    const j = JSON.parse(await auth(p, ["-J", "--flat-playlist", "--playlist-items", "1-3000", "https://www.youtube.com/feed/channels"]));
    return (j.entries ?? []).filter((e) => e.channel_id).map((e) => ({
      id: e.channel_id, name: e.channel ?? e.title, handle: e.uploader_id ?? null,
      subs: e.channel_follower_count ?? null, verified: false,
      avatar: (() => { const u = best(e.thumbnails); return u ? u.replace(/=.*$/, "") + "=s96-c-k-c0x00ffffff-no-rj" : null; })(),
    }));
  }, opts);

  const FEEDS = {
    subs: { url: "https://www.youtube.com/feed/subscriptions", count: 80, ttl: 5 * MIN },
    home: { url: ":ytrec", count: 48, ttl: 5 * MIN },
    history: { url: ":ythistory", count: 150, ttl: 2 * MIN },
    later: { url: "https://www.youtube.com/playlist?list=WL", count: 300, ttl: 5 * MIN },
    liked: { url: "https://www.youtube.com/playlist?list=LL", count: 300, ttl: 5 * MIN },
  };
  const feed = (p, kind, opts) => {
    const f = FEEDS[kind];
    if (!f) throw new Error("Unknown feed.");
    return cached(p, `feed:${kind}`, f.ttl, async () => {
      const j = JSON.parse(await auth(p, ["-J", "--flat-playlist", "--playlist-items", `1-${f.count}`, "--extractor-args", "youtubetab:approximate_date", f.url]));
      return (j.entries ?? []).filter((e) => e.id && e.title).map((e) => ({
        id: e.id, title: e.title, duration: e.duration ?? null, views: e.view_count ?? null, timestamp: e.timestamp ?? null,
        live: e.live_status === "is_live", channel: e.channel ?? e.uploader ?? null, channelId: e.channel_id ?? null, thumbnail: best(e.thumbnails),
        tags: e.tags ?? [], categories: e.categories ?? [], description: e.description ?? null,
      }));
    }, opts);
  };

  /** Fetch the main lists for every connected profile at startup, so the first page load isn't cold. */
  async function warm() {
    const { readdir } = await import("node:fs/promises");
    for (const p of await readdir(ACCOUNTS).catch(() => [])) {
      if (!PROFILE_RE.test(p) || !(await status(p)).connected) continue;
      for (const load of [() => channels(p), () => feed(p, "subs"), () => feed(p, "home"), () => feed(p, "history"), () => feed(p, "later"), () => shorts(p)]) await load().catch(() => {});
    }
  }

  /**
   * Shorts from channels the account follows. YouTube's own Shorts feed isn't readable from outside the
   * app, so this takes the channels that posted most recently (from the subscriptions feed), reads each
   * one's public Shorts tab, and interleaves them so no single channel fills the page. No login is used.
   */
  const shorts = (p, opts) => cached(p, "shorts", 20 * MIN, async () => {
    const recent = await feed(p, "subs");
    const ids = [...new Set(recent.map((v) => v.channelId).filter(Boolean))].slice(0, 36);
    const lists = new Array(ids.length);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < ids.length) {
        const i = next++;
        try {
          const j = JSON.parse(await ytdlp(["-J", "--flat-playlist", "--playlist-items", "1-6", `https://www.youtube.com/channel/${ids[i]}/shorts`]));
          lists[i] = (j.entries ?? []).filter((e) => e.id).map((e) => ({ id: e.id, title: e.title, views: e.view_count ?? null, channel: j.channel ?? j.uploader ?? null, channelId: ids[i], short: true }));
        } catch { lists[i] = []; }
      }
    }));
    const out = [];
    for (let round = 0; out.length < 72; round++) {
      let any = false;
      for (const l of lists) if (l?.[round]) { out.push(l[round]); any = true; }
      if (!any) break;
    }
    return out;
  }, opts);

  return { status, connect, disconnect, auth, channels, feed, shorts, recommendations, forget, warm, BROWSERS };
}
