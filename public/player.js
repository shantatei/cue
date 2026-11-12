import { icon } from "/icons.js";

const PREFS = "player.prefs"; // { maxQuality, volume, muted, rate }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const loadPrefs = () => {
  try { return { maxQuality: 2160, volume: 1, muted: false, ...JSON.parse(localStorage.getItem(PREFS)) }; }
  catch { return { maxQuality: 2160, volume: 1, muted: false }; }
};
const savePrefs = (prefs) => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch {} };

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

const TEMPLATE = `
  <video playsinline preload="auto"></video>
  <audio preload="auto"></audio>
  <div class="pl-busy" aria-hidden="true"></div>
  <div class="pl-cc" aria-live="off"></div>
  <div class="pl-note" role="status" hidden></div>
  <button class="pl-big" type="button" aria-label="Play">${icon("play", 34)}</button>
  <div class="pl-error" role="alert" hidden><p></p><button type="button" data-act="retry">Try again</button></div>
  <div class="pl-ui">
    <div class="pl-seek">
      <svg class="pl-heat" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path/></svg>
      <div class="pl-track"><div class="pl-buf"></div><div class="pl-fill"></div><div class="pl-marks"></div></div>
      <input class="pl-range" type="range" min="0" max="1" step="any" value="0" aria-label="Seek">
      <output class="pl-tip" hidden></output>
    </div>
    <div class="pl-row">
      <button type="button" data-act="toggle" aria-label="Play (k)"></button>
      <button type="button" data-act="mute" aria-label="Mute (m)"></button>
      <input class="pl-vol" type="range" min="0" max="1" step="0.05" aria-label="Volume">
      <span class="pl-time"><span data-cur>0:00</span> / <span data-dur>0:00</span></span>
      <span class="pl-chapter"></span>
      <span class="pl-gap"></span>
      <button type="button" class="pl-text" data-act="speed" aria-haspopup="menu" aria-label="Playback speed">1×</button>
      <button type="button" class="pl-text" data-act="quality" aria-haspopup="menu" aria-label="Quality"></button>
      <button type="button" data-act="captions" aria-haspopup="menu" aria-label="Captions (c)">${icon("captions")}</button>
      <button type="button" data-act="pip" aria-label="Picture in picture (i)">${icon("pip")}</button>
      <button type="button" data-act="theatre" aria-label="Theatre mode (t)">${icon("theatre")}</button>
      <button type="button" data-act="fullscreen" aria-label="Full screen (f)"></button>
    </div>
    <div class="pl-menu" role="menu" hidden></div>
  </div>`;

// One entry per quality tier, highest first, using the codec this machine decodes best.
async function rankVideo(formats) {
  const probe = document.createElement("video");
  const scored = await Promise.all(formats.map(async (f) => {
    let cap = { supported: probe.canPlayType(f.mime) !== "", smooth: true, powerEfficient: false };
    try {
      cap = await navigator.mediaCapabilities.decodingInfo({
        type: "file",
        video: { contentType: f.mime, width: f.width, height: f.height, bitrate: f.bitrate, framerate: f.fps },
      });
    } catch {}
    return cap.supported ? { ...f, score: (cap.powerEfficient ? 2 : 0) + (cap.smooth ? 1 : 0) } : null;
  }));
  const best = new Map();
  for (const f of scored.filter(Boolean).sort((a, b) => b.fps - a.fps || b.score - a.score || a.bitrate - b.bitrate)) {
    if (!best.has(f.quality)) best.set(f.quality, f);
  }
  return [...best.values()].sort((a, b) => b.quality - a.quality);
}

const stamp = (t) => t.replace(",", ".").split(":").reduce((n, x) => n * 60 + parseFloat(x), 0);
/** WebVTT or SRT text -> [{ start, end, text }]. Inline tags are dropped. */
export function parseCaptions(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n"), at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->").map((x) => x.trim().split(/\s/)[0]);
    const body = lines.slice(at + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (body) cues.push({ start: stamp(a), end: stamp(b), text: body });
  }
  return cues;
}

const tierLabel = (f) => `${f.quality}p${f.fps > 30 ? f.fps : ""}`;
const tierTag = (f) => (f.quality >= 2160 ? "4K" : f.quality >= 1440 ? "2K" : f.quality >= 720 ? "HD" : "");

/**
 * Mounts a player for `info` (the /api/info payload) inside `root`.
 * Video and audio arrive as separate streams, so a <video> and an <audio> are kept in sync.
 */
export function mountPlayer(root, info, { autoplay = true, startAt = 0, onTime, onEnded, prefs: given, savePrefs: givenSave, captions: ccOpts } = {}) {
  root.classList.add("pl");
  root.tabIndex = 0;
  root.innerHTML = TEMPLATE;
  const $ = (s) => root.querySelector(s);
  const v = $("video"), a = $("audio");
  const seek = $(".pl-seek"), range = $(".pl-range"), tip = $(".pl-tip"), menu = $(".pl-menu"), vol = $(".pl-vol");
  const btn = (act) => $(`[data-act="${act}"]`);
  const life = new AbortController();
  const on = (target, type, fn) => target.addEventListener(type, fn, { signal: life.signal });
  const prefs = given ?? loadPrefs();
  const persist = givenSave ?? (() => savePrefs(prefs));
  const src = (f) => `/stream?v=${info.id}&f=${encodeURIComponent(f.id)}`;

  let tiers = [], tier = null, audio = null, sound = v, separate = false;
  let lastState = "", wantPlay = false, holding = false, switching = false, scrubbing = false, idleTimer = 0, lastReport = 0;

  // --- playback and sync -----------------------------------------------------------------
  const blocked = (e) => {
    if (e.name !== "NotAllowedError") return;
    wantPlay = false; v.pause(); a.pause(); render(); // autoplay refused: wait for a click
  };
  /**
   * One place decides whether picture and sound should be running. While either one is still
   * loading (after a seek, a quality switch, a stall) both are held; the moment both can play
   * they start together. Every media event and a short timer call this, so no sequence of seeks
   * can leave the two waiting on each other.
   */
  function reconcile() {
    if (!wantPlay || switching) return render();
    const seeking = v.seeking || (separate && a.seeking);
    const ready = v.readyState >= 3 && (!separate || a.readyState >= 3) && !seeking;
    if (ready) {
      holding = false;
      if (separate && Math.abs(a.currentTime - v.currentTime) > 0.25) a.currentTime = v.currentTime;
      if (v.paused) v.play().catch(blocked);
      if (separate && a.paused) a.play().catch(blocked);
    } else {
      holding = true;
      if (separate && !a.paused) a.pause();
      if (!v.paused && v.readyState >= 3) v.pause(); // the picture is ready but the sound isn't: wait for it
    }
    if (stateKey() !== lastState) render();
  }
  function play() {
    wantPlay = true;
    if (v.ended) seekTo(0);
    // Start inside the user gesture so the browser allows it, then let reconcile() take over.
    v.play().catch(blocked);
    if (separate) a.play().catch(blocked);
    reconcile();
    wake();                                   // start the auto-hide timer even if the pointer never moves
  }
  function pause() { wantPlay = false; holding = false; v.pause(); a.pause(); render(); }
  const toggle = () => (wantPlay ? pause() : play());
  function seekTo(t) {
    t = Math.min(Math.max(0, t), (v.duration || info.duration) - 0.1);
    v.currentTime = t;
    if (separate) a.currentTime = t;
    tick();
    reconcile();
  }

  for (const el of [v, a]) for (const type of ["waiting", "seeking", "seeked", "canplay", "canplaythrough", "playing", "stalled", "loadeddata"]) on(el, type, reconcile);
  on(v, "pause", () => { // paused from outside: media keys, the picture-in-picture window
    if (holding || switching || !wantPlay || v.ended) return;
    wantPlay = false; a.pause(); render();
  });
  on(v, "play", () => { if (!wantPlay) { wantPlay = true; reconcile(); } });
  on(v, "ended", () => { wantPlay = false; holding = false; a.pause(); render(); onEnded?.(); });
  for (const el of [v, a]) on(el, "error", () => { if (el.error && el.getAttribute("src")) fail("The stream stopped loading."); });
  const watchdog = setInterval(() => { if (wantPlay) reconcile(); }, 250);
  life.signal.addEventListener("abort", () => clearInterval(watchdog));

  // Small drift is corrected by nudging the audio rate; large drift by jumping.
  const drift = setInterval(() => {
    if (!separate || !wantPlay || v.paused || a.paused || v.seeking) return;
    const d = a.currentTime - v.currentTime;
    if (Math.abs(d) > 0.35) a.currentTime = v.currentTime;
    else a.playbackRate = v.playbackRate * (Math.abs(d) < 0.04 ? 1 : d > 0 ? 0.96 : 1.04);
  }, 400);
  life.signal.addEventListener("abort", () => clearInterval(drift));

  // --- quality, speed, volume --------------------------------------------------------------
  function setTier(next, remember) {
    if (next === tier) return;
    const at = v.currentTime, resume = wantPlay, first = !tier;
    tier = next;
    if (remember) { prefs.maxQuality = next.quality; persist(); }
    switching = true;
    a.pause();
    v.src = src(next);
    if (!first) v.currentTime = at;
    v.addEventListener("loadedmetadata", () => {
      switching = false;
      if (!first && Math.abs(v.currentTime - at) > 1) v.currentTime = at;
      v.playbackRate = prefs.rate ?? 1;
      if (resume) play();
    }, { once: true, signal: life.signal });
    btn("quality").innerHTML = `${tierLabel(next)}${tierTag(next) ? `<sup>${tierTag(next)}</sup>` : ""}`;
  }
  function setRate(r) {
    prefs.rate = r; persist();
    v.playbackRate = r; a.playbackRate = r;
    btn("speed").textContent = `${r}×`;
  }
  function setVolume(volume, muted = false) {
    prefs.volume = Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100; prefs.muted = muted; persist();
    sound.volume = prefs.volume; sound.muted = muted;
    render();
  }

  // --- interface ----------------------------------------------------------------------------
  const stateKey = () => `${wantPlay}|${holding}|${v.readyState >= 3}|${v.seeking}|${switching}`;
  function render() {
    lastState = stateKey();
    const busy = wantPlay && (holding || v.readyState < 3 || v.seeking || switching);
    root.classList.toggle("pl-playing", wantPlay);
    root.classList.toggle("pl-busy-on", busy);
    btn("toggle").innerHTML = icon(wantPlay ? "pause" : "play");
    btn("toggle").setAttribute("aria-label", wantPlay ? "Pause (k)" : "Play (k)");
    btn("speed").textContent = `${prefs.rate ?? 1}×`;
    const silent = prefs.muted || prefs.volume === 0;
    btn("mute").innerHTML = icon(silent ? "muted" : "volume");
    btn("mute").setAttribute("aria-label", silent ? "Unmute (m)" : "Mute (m)");
    vol.value = prefs.muted ? 0 : prefs.volume;
    vol.style.setProperty("--v", `${vol.value * 100}%`);
    btn("fullscreen").innerHTML = icon(document.fullscreenElement === root ? "minimize" : "maximize");
    if (!wantPlay) wake();
  }
  function tick() {
    const dur = v.duration || info.duration || 0, t = scrubbing ? Number(range.value) : v.currentTime;
    let buffered = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) > buffered) buffered = v.buffered.end(i);
    }
    range.max = dur;
    if (!scrubbing) range.value = t;
    seek.style.setProperty("--played", `${dur ? (t / dur) * 100 : 0}%`);
    seek.style.setProperty("--buffered", `${dur ? (buffered / dur) * 100 : 0}%`);
    $("[data-cur]").textContent = fmtTime(t);
    $("[data-dur]").textContent = fmtTime(dur);
    $(".pl-chapter").textContent = chapterAt(t)?.title ?? "";
    if (onTime && Math.abs(t - lastReport) >= 5) { lastReport = t; onTime(t, dur); }
  }
  const chapterAt = (t) => info.chapters.findLast?.((c) => c.start_time <= t);
  function fail(message) {
    wantPlay = false; holding = false; v.pause(); a.pause();
    $(".pl-error p").textContent = message;
    $(".pl-error").hidden = false;
    render();
  }
  function wake() {
    root.classList.remove("pl-idle");
    clearTimeout(idleTimer);
    if (wantPlay && menu.hidden) idleTimer = setTimeout(() => root.classList.add("pl-idle"), 2500);
  }

  function openMenu(kind) {
    if (!menu.hidden && menu.dataset.kind === kind) return closeMenu();
    menu.dataset.kind = kind;
    const item = (value, label, note, active) =>
      `<button type="button" role="menuitemradio" aria-checked="${active}" data-value="${value}"><span>${label}</span><small>${note}</small></button>`;
    menu.innerHTML = kind === "quality"
      ? tiers.map((f, i) => item(i, `${tierLabel(f)}${tierTag(f) ? ` <sup>${tierTag(f)}</sup>` : ""}`, `${(f.bitrate / 1e6).toFixed(f.bitrate < 1e7 ? 1 : 0)} Mbps`, f === tier)).join("")
      : kind === "captions"
        ? [item("off", "Off", "", !ccId), ...(cc.tracks ?? []).map((t) => item(t.id, esc(t.label), esc(t.note ?? ""), t.id === ccId)), ...(cc.requests ?? []).map((r) => item(r.id, esc(r.label), esc(r.note ?? ""), r.id === ccId))].join("")
        : RATES.map((r) => item(r, r === 1 ? "Normal" : `${r}×`, "", r === v.playbackRate)).join("");
    menu.style.setProperty("--anchor", `${root.getBoundingClientRect().right - btn(kind).getBoundingClientRect().right}px`);
    menu.hidden = false;
    wake();
  }
  function closeMenu() { menu.hidden = true; wake(); }
  on(menu, "click", (e) => {
    const value = e.target.closest("button")?.dataset.value;
    if (value === undefined) return;
    if (menu.dataset.kind === "quality") setTier(tiers[value], true);
    else if (menu.dataset.kind === "captions") chooseCaptions(value === "off" ? null : value);
    else setRate(Number(value));
    closeMenu();
  });

  // --- captions -----------------------------------------------------------------------------------
  // tracks load from a URL; requests (e.g. AI transcription) produce a URL when they finish.
  const cc = ccOpts ?? {};
  const ccBox = $(".pl-cc"), note = $(".pl-note");
  let cues = [], ccId = null, ccLast = null, ccAt = -1, noteTimer = 0, ccToken = 0;
  const styleCaptions = () => {
    root.style.setProperty("--cc-scale", (cc.size ?? 100) / 100);
    root.style.setProperty("--cc-bg", (cc.background ?? 70) / 100);
  };
  styleCaptions();
  function say(text, ms = 0) {
    clearTimeout(noteTimer);
    note.textContent = text; note.hidden = !text;
    if (text && ms) noteTimer = setTimeout(() => { note.hidden = true; }, ms);
  }
  function showCue() {
    if (!cues.length) return ccBox.replaceChildren();
    const t = v.currentTime;
    if (ccAt < 0 || t < cues[ccAt].start || t >= cues[ccAt].end) {
      ccAt = cues.findIndex((c) => t >= c.start && t < c.end);
    }
    const text = ccAt >= 0 ? cues[ccAt].text : "";
    if (ccBox.textContent !== text) { ccBox.replaceChildren(); if (text) { const s = document.createElement("span"); s.textContent = text; ccBox.append(s); } }
  }
  async function chooseCaptions(id) {
    const token = ++ccToken;
    cues = []; ccAt = -1; ccBox.replaceChildren(); say("");
    ccId = id;
    if (id) ccLast = id;
    root.classList.toggle("pl-cc-on", !!id);
    btn("captions").setAttribute("aria-pressed", !!id);
    if (!id) return;
    const track = cc.tracks?.find((t) => t.id === id), req = cc.requests?.find((r) => r.id === id);
    try {
      say(req ? `${req.label}…` : "Loading captions…");
      const url = track ? track.url : await req.start((msg) => token === ccToken && say(msg));
      if (token !== ccToken) return;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`captions ${r.status}`);
      const text = await r.text();
      if (token !== ccToken) return; // a newer choice replaced this one while it loaded
      const parsed = parseCaptions(text);
      if (!parsed.length) throw new Error("This track has no text.");
      cues = parsed;
      say("");
      cc.onChoose?.(id, track ?? req);
      showCue();
    } catch (e) {
      if (token !== ccToken) return;
      ccId = null; root.classList.remove("pl-cc-on"); btn("captions").setAttribute("aria-pressed", "false");
      say(`Captions failed: ${e.message}`, 5000);
    }
  }
  const toggleCaptions = () => {
    if (ccId) return chooseCaptions(null);
    const first = ccLast ?? cc.initial ?? cc.tracks?.[0]?.id ?? cc.requests?.[0]?.id;
    return first ? chooseCaptions(first) : say("This video has no captions.", 3000);
  };
  on(v, "timeupdate", showCue);
  on(v, "seeked", () => { ccAt = -1; showCue(); });
  const ccTimer = setInterval(() => { if (cues.length && !v.paused) showCue(); }, 120);
  life.signal.addEventListener("abort", () => clearInterval(ccTimer));

  const actions = {
    toggle,
    captions: () => ((cc.tracks?.length || cc.requests?.length) ? openMenu("captions") : say("This video has no captions.", 3000)),
    mute: () => setVolume(prefs.volume || 0.5, !(prefs.muted || prefs.volume === 0)),
    speed: () => openMenu("speed"),
    quality: () => openMenu("quality"),
    pip: () => (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture?.())?.catch?.(() => {}),
    theatre: () => root.dispatchEvent(new CustomEvent("player:theatre", { bubbles: true })),
    fullscreen: () => (document.fullscreenElement === root ? document.exitFullscreen() : root.requestFullscreen()),
    retry: () => {
      const at = v.currentTime, same = tier;
      $(".pl-error").hidden = true;
      tier = null;
      setTier(same);
      if (separate) a.src = src(audio);
      seekTo(at);
      play();
    },
  };
  on(root, "click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act) return actions[act]();
    if (e.target === v || e.target.closest(".pl-big")) { if (!menu.hidden) return closeMenu(); toggle(); }
  });
  on(v, "dblclick", actions.fullscreen);
  on(document, "pointerdown", (e) => { if (!menu.hidden && !e.target.closest(".pl-menu, [aria-haspopup]")) closeMenu(); });
  on(document, "fullscreenchange", render);
  on(root, "pointermove", wake);
  on(root, "pointerleave", () => { if (wantPlay && menu.hidden) root.classList.add("pl-idle"); });
  on(v, "timeupdate", tick);
  on(v, "progress", tick);
  on(v, "durationchange", tick);

  on(range, "input", () => { scrubbing = true; tick(); });
  on(range, "change", () => { scrubbing = false; seekTo(Number(range.value)); });
  on(seek, "pointermove", (e) => {
    const box = seek.getBoundingClientRect(), dur = v.duration || info.duration || 0;
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), t = ratio * dur;
    const chapter = chapterAt(t)?.title;
    tip.textContent = chapter ? `${fmtTime(t)} · ${chapter}` : fmtTime(t);
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(box.width - half, Math.max(half, ratio * box.width))}px`;
  });
  on(seek, "pointerleave", () => { tip.hidden = true; });
  on(vol, "input", () => setVolume(Number(vol.value)));

  /** Handles a player shortcut. Returns true when the key was used. */
  function key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const tag = e.target.tagName;
    const ownSlider = e.target.matches?.(".pl-range, .pl-vol");   // the seek and volume sliders keep focus after a click
    if ((tag === "INPUT" && !ownSlider) || tag === "TEXTAREA" || e.target.isContentEditable) return false;
    if (tag === "BUTTON" && (e.key === " " || e.key === "Enter")) return false;
    const by = (d) => seekTo(v.currentTime + d);
    const rate = (d) => setRate(RATES[Math.min(RATES.length - 1, Math.max(0, RATES.indexOf(v.playbackRate) + d))] ?? 1);
    const map = {
      " ": toggle, k: toggle, j: () => by(-10), l: () => by(10), ArrowLeft: () => by(-5), ArrowRight: () => by(5),
      ArrowUp: () => setVolume(prefs.volume + 0.05), ArrowDown: () => setVolume(prefs.volume - 0.05),
      c: toggleCaptions, m: actions.mute, f: actions.fullscreen, t: actions.theatre, i: actions.pip,
      ">": () => rate(1), "<": () => rate(-1), Escape: () => !menu.hidden && closeMenu(),
    };
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;   // Caps Lock and Shift must not disable shortcuts
    const fn = map[k] ?? (/^\d$/.test(k) ? () => seekTo(((v.duration || 0) * Number(k)) / 10) : null);
    if (!fn) return false;
    e.preventDefault();
    fn();
    wake();
    return true;
  }
  on(root, "keydown", (e) => { if (key(e)) e.stopPropagation(); });

  // --- static decoration: most-replayed curve and chapter marks -------------------------------
  const dur = info.duration || 1;
  if (info.heatmap.length) {
    const pts = info.heatmap.map((h) => `${(((h.start_time + h.end_time) / 2 / dur) * 1000).toFixed(1)},${(100 - h.value * 92).toFixed(1)}`);
    $(".pl-heat path").setAttribute("d", `M0,100 L${pts.join(" L")} L1000,100 Z`);
  } else $(".pl-heat").remove();
  $(".pl-marks").innerHTML = info.chapters.slice(1).map((c) => `<i style="left:${(c.start_time / dur) * 100}%"></i>`).join("");

  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: info.title, artist: info.channel, artwork: [{ src: info.thumbnail }] });
    for (const [name, fn] of [["play", play], ["pause", pause], ["seekbackward", () => seekTo(v.currentTime - 10)], ["seekforward", () => seekTo(v.currentTime + 10)]]) {
      try { navigator.mediaSession.setActionHandler(name, fn); } catch {}
    }
  }

  // --- start --------------------------------------------------------------------------------
  v.poster = info.thumbnail ?? "";   // the video's own frame behind the play button until it starts
  render();
  tick();
  rankVideo(info.video).then((ranked) => {
    if (life.signal.aborted) return;
    audio = info.audio.find((f) => a.canPlayType(f.mime) !== "");
    separate = ranked.length > 0 && !!audio;
    tiers = separate ? ranked : info.muxed.slice(0, 1);
    if (!tiers.length) return fail("This browser can't play any of this video's formats.");
    sound = separate ? a : v;
    if (separate) a.src = src(audio);
    setVolume(prefs.volume, prefs.muted);
    setTier(tiers.find((f) => f.quality <= prefs.maxQuality) ?? tiers.at(-1));
    if (startAt) seekTo(startAt);
    if (autoplay) play();
    if (cc.initial) chooseCaptions(cc.initial);
  });

  return {
    key,
    seek: seekTo,
    get time() { return v.currentTime; },
    captions: chooseCaptions,
    get quality() { return tier && tierLabel(tier); },
    destroy() {
      life.abort();
      clearTimeout(idleTimer);
      if ("mediaSession" in navigator) {
        for (const name of ["play", "pause", "seekbackward", "seekforward"]) { try { navigator.mediaSession.setActionHandler(name, null); } catch {} }
        navigator.mediaSession.metadata = null;
      }
      for (const el of [v, a]) { el.pause(); el.removeAttribute("src"); el.load(); }
    },
  };
}
