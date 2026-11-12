import type Hls from "hls.js";
import type { PlayerAPI, PlayerOptions, VideoInfo } from "./types.js";
import { errorMessage } from "./errors.js";
import { icon } from "../icons.js";
import { fmtTime, targetOf } from "./util.js";

/** HLS owns audio/video synchronisation; broadcasts use the regular player's control styles. */
export function mountLivePlayer(root: HTMLElement, info: VideoInfo, options: PlayerOptions): PlayerAPI {
  root.classList.add("pl", "pl-live");
  root.tabIndex = 0;
  root.innerHTML = `<video playsinline preload="auto" aria-label="Live stream"></video>
    <div class="pl-busy" aria-hidden="true"></div>
    <button class="pl-big" type="button" aria-label="Play">${icon("play", 34)}</button>
    <div class="pl-error live-error" role="alert" hidden><p></p><button type="button" data-act="retry">Reconnect</button></div>
    <div class="pl-ui">
      <div class="pl-seek"><div class="pl-track"><div class="pl-buf"></div><div class="pl-fill"></div></div>
        <input class="pl-range" type="range" min="0" max="1" step="any" value="0" aria-label="Seek in live stream" disabled>
        <output class="pl-tip" hidden></output></div>
      <div class="pl-row">
        <button type="button" data-act="toggle" aria-label="Play (k)"></button>
        <button type="button" data-act="mute" aria-label="Mute (m)"></button>
        <input class="pl-vol" type="range" min="0" max="1" step="0.05" aria-label="Volume">
        <button type="button" class="pl-text live-edge" data-act="live" title="Jump to the live broadcast">● LIVE</button>
        <span class="live-state" role="status">Connecting…</span><span class="pl-gap"></span>
        <button type="button" class="pl-text" data-act="quality" aria-haspopup="menu" aria-expanded="false" aria-label="Quality" disabled>Auto</button>
        <button type="button" data-act="pip" aria-label="Picture in picture (i)">${icon("pip")}</button>
        <button type="button" data-act="theatre" aria-label="Theatre mode (t)">${icon("theatre")}</button>
        <button type="button" data-act="fullscreen" aria-label="Full screen (f)">${icon("maximize")}</button>
      </div>
      <div class="pl-menu" role="menu" aria-label="Live stream quality" hidden></div>
    </div>`;
  const video = root.querySelector("video")!;
  const btn = (action: string) => root.querySelector<HTMLButtonElement>(`[data-act="${action}"]`)!;
  const quality = btn("quality"), edge = btn("live"), big = root.querySelector<HTMLButtonElement>(".pl-big")!;
  const menu = root.querySelector<HTMLElement>(".pl-menu")!;
  const range = root.querySelector<HTMLInputElement>(".pl-range")!;
  const volume = root.querySelector<HTMLInputElement>(".pl-vol")!;
  const track = root.querySelector<HTMLElement>(".pl-seek")!;
  const tip = root.querySelector<HTMLOutputElement>(".pl-tip")!;
  const state = root.querySelector<HTMLElement>(".live-state")!;
  const error = root.querySelector<HTMLElement>(".live-error")!;
  const life = new AbortController();
  const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => video.addEventListener(type, fn, { signal: life.signal });
  let hls: Hls | undefined, generation = 0, retries = 0, mediaRecoveries = 0, selectedLevel = -1;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, loading = true, scrubbing = false;
  const prefs = options.prefs;
  video.volume = Math.min(1, Math.max(0, prefs?.volume ?? 1));
  video.muted = prefs?.muted ?? false;
  video.poster = info.thumbnail ?? "";
  const source = () => `/api/live?${new URLSearchParams({ v: info.id, p: options.profile ?? "" })}`;
  const play = () => video.play().catch(() => { if (!life.signal.aborted) { state.textContent = "Press play to watch"; loading = false; render(); wake(); } });
  const toggle = () => { if (video.paused) void play(); else { loading = false; video.pause(); } wake(); };
  const fail = (message: string) => {
    stopped = true; loading = false; hls?.stopLoad(); video.pause(); closeMenu();
    error.querySelector("p")!.textContent = message; error.hidden = false; state.textContent = "Disconnected"; render(); wake();
  };
  const liveTime = () => hls?.liveSyncPosition ?? (video.seekable.length ? Math.max(video.seekable.start(0), video.seekable.end(video.seekable.length - 1) - 2) : null);
  const seek = (time: number) => {
    if (!Number.isFinite(time) || !video.seekable.length) return;
    let nearest = video.seekable.start(0), distance = Infinity;
    for (let i = 0; i < video.seekable.length; i++) {
      const point = Math.max(video.seekable.start(i), Math.min(time, video.seekable.end(i) - 0.1));
      if (Math.abs(point - time) < distance) { nearest = point; distance = Math.abs(point - time); }
    }
    video.currentTime = nearest;
  };
  const goLive = () => { const time = liveTime(); if (time !== null) seek(time); video.playbackRate = 1; void play(); };
  const fullscreen = () => { if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {}); else void root.requestFullscreen().catch(() => {}); };
  const theatre = () => root.dispatchEvent(new CustomEvent("player:theatre", { bubbles: true }));
  const pip = () => { void (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture?.())?.catch(() => {}); };
  const label = (level: { height: number; frameRate: number }) => `${level.height}p${level.frameRate > 30 ? Math.round(level.frameRate) : ""}`;
  const badge = (height: number) => height >= 2160 ? "4K" : height >= 1440 ? "2K" : height >= 720 ? "HD" : "";
  const badgeHTML = (height: number) => badge(height) ? `<sup>${badge(height)}</sup>` : "";
  function renderQuality() {
    const level = hls?.levels[selectedLevel < 0 ? hls.currentLevel : selectedLevel];
    quality.innerHTML = selectedLevel < 0 ? `Auto${level?.height ? badgeHTML(level.height) : ""}` : level ? `${label(level)}${badgeHTML(level.height)}` : "Auto";
  }
  function wake() {
    root.classList.remove("pl-idle"); clearTimeout(idleTimer);
    if (!video.paused && menu.hidden && !root.querySelector(".pl-ui :focus-visible")) idleTimer = setTimeout(() => root.classList.add("pl-idle"), 2500);
  }
  function render() {
    root.classList.toggle("pl-playing", !video.paused);
    root.classList.toggle("pl-busy-on", loading && !stopped);
    big.hidden = stopped || (loading && video.paused);
    btn("toggle").innerHTML = icon(video.paused ? "play" : "pause");
    btn("toggle").setAttribute("aria-label", video.paused ? "Play (k)" : "Pause (k)");
    const silent = video.muted || video.volume === 0;
    btn("mute").innerHTML = icon(silent ? "muted" : "volume");
    btn("mute").setAttribute("aria-label", silent ? "Unmute (m)" : "Mute (m)");
    volume.value = String(video.muted ? 0 : video.volume); volume.style.setProperty("--v", `${Number(volume.value) * 100}%`);
    btn("fullscreen").innerHTML = icon(document.fullscreenElement === root ? "minimize" : "maximize");
  }
  function tick() {
    const live = liveTime(), behind = live !== null && live - video.currentTime > 8;
    edge.classList.toggle("behind", behind); edge.textContent = behind ? "● Go live" : "● LIVE";
    const start = video.seekable.length ? video.seekable.start(0) : 0;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    const span = end - start;
    range.disabled = span <= 0; range.min = String(start); range.max = String(end || 1);
    if (!scrubbing) range.value = String(Math.max(start, Math.min(end, video.currentTime)));
    let buffered = start;
    for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.5) buffered = Math.max(buffered, video.buffered.end(i));
    const percent = (time: number) => `${span > 0 ? Math.max(0, Math.min(100, (time - start) / span * 100)) : 0}%`;
    track.style.setProperty("--played", percent(Number(range.value))); track.style.setProperty("--buffered", percent(buffered));
    range.setAttribute("aria-valuetext", live !== null && live - Number(range.value) > 2 ? `${fmtTime(live - Number(range.value))} behind live` : "Live");
  }
  function closeMenu() { menu.hidden = true; quality.setAttribute("aria-expanded", "false"); wake(); }
  function openMenu() {
    if (!menu.hidden) return closeMenu();
    const item = (value: number, text: string, note = "") => `<button type="button" role="menuitemradio" aria-checked="${selectedLevel === value}" data-value="${value}"><span>${text}</span><small>${note}</small></button>`;
    const heights = new Set<number>();
    const choices = (hls?.levels ?? []).map((level, index) => ({ level, index }))
      .filter(({ level }) => level.height > 0)
      .sort((a, b) => b.level.height - a.level.height || b.level.frameRate - a.level.frameRate || b.level.bitrate - a.level.bitrate)
      .filter(({ level }) => { if (heights.has(level.height)) return false; heights.add(level.height); return true; });
    menu.innerHTML = item(-1, "Auto") + choices.map(({ level, index }) => item(index, `${label(level)}${badgeHTML(level.height)}`, `${(level.bitrate / 1e6).toFixed(level.bitrate < 1e7 ? 1 : 0)} Mbps`)).join("");
    menu.style.setProperty("--anchor", `${root.getBoundingClientRect().right - quality.getBoundingClientRect().right}px`);
    menu.hidden = false; quality.setAttribute("aria-expanded", "true"); wake();
  }
  function setVolume(value: number) { video.volume = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100; video.muted = false; }
  on("volumechange", () => { if (prefs) { prefs.volume = video.volume; prefs.muted = video.muted; options.savePrefs?.(); } render(); });
  on("play", () => { render(); wake(); });
  on("playing", () => { loading = false; state.textContent = ""; render(); wake(); });
  on("canplay", () => { loading = false; render(); });
  on("pause", () => { if (!stopped) state.textContent = "Paused"; render(); wake(); });
  on("waiting", () => { if (!stopped) { loading = true; state.textContent = "Buffering…"; render(); } });
  on("seeking", () => { loading = true; render(); });
  on("seeked", () => { loading = video.readyState < 3; render(); tick(); });
  on("ended", () => { state.textContent = "Broadcast ended"; render(); wake(); options.onEnded?.(); });
  on("error", () => { if (!hls && !life.signal.aborted) fail("The live stream could not load. Try reconnecting."); });
  for (const type of ["timeupdate", "progress", "durationchange", "loadedmetadata"] as const) on(type, tick);
  const actions = { toggle, live: goLive, mute: () => { if (!video.volume) setVolume(0.5); else video.muted = !video.muted; }, quality: openMenu, pip, theatre, fullscreen, retry: () => void connect() };
  root.addEventListener("click", (event) => {
    const target = targetOf(event), action = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (action && action in actions) { actions[action as keyof typeof actions](); wake(); return; }
    if (target === video || target.closest(".pl-big")) { if (!menu.hidden) closeMenu(); else toggle(); }
  }, { signal: life.signal });
  menu.addEventListener("click", (event) => {
    const value = targetOf(event).closest<HTMLElement>("[data-value]")?.dataset.value;
    if (value === undefined || !hls) return;
    selectedLevel = Number(value); hls.currentLevel = selectedLevel;
    if (selectedLevel >= 0 && prefs) { prefs.maxQuality = hls.levels[selectedLevel].height; options.savePrefs?.(); }
    renderQuality(); closeMenu(); quality.focus();
  }, { signal: life.signal });
  document.addEventListener("pointerdown", (event) => { if (!menu.hidden && !targetOf(event).closest(".pl-menu, [aria-haspopup]")) closeMenu(); }, { signal: life.signal });
  document.addEventListener("fullscreenchange", render, { signal: life.signal });
  video.addEventListener("dblclick", fullscreen, { signal: life.signal });
  root.addEventListener("pointermove", wake, { signal: life.signal });
  root.addEventListener("focusin", wake, { signal: life.signal });
  root.addEventListener("focusout", wake, { signal: life.signal });
  root.addEventListener("pointerleave", () => { if (!video.paused && menu.hidden && !root.querySelector(".pl-ui :focus-visible")) root.classList.add("pl-idle"); }, { signal: life.signal });
  volume.addEventListener("input", () => setVolume(Number(volume.value)), { signal: life.signal });
  range.addEventListener("input", () => { scrubbing = true; tick(); }, { signal: life.signal });
  range.addEventListener("change", () => { scrubbing = false; seek(Number(range.value)); }, { signal: life.signal });
  track.addEventListener("pointermove", (event) => {
    if (range.disabled) return;
    const box = track.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const time = Number(range.min) + ratio * (Number(range.max) - Number(range.min)), live = liveTime() ?? Number(range.max);
    tip.textContent = live - time > 2 ? `−${fmtTime(live - time)}` : "LIVE"; tip.hidden = false;
    tip.style.left = `${Math.max(tip.offsetWidth / 2, Math.min(box.width - tip.offsetWidth / 2, ratio * box.width))}px`;
  }, { signal: life.signal });
  track.addEventListener("pointerleave", () => { tip.hidden = true; }, { signal: life.signal });

  async function connect() {
    const attempt = ++generation;
    clearTimeout(reconnectTimer); hls?.destroy(); hls = undefined;
    video.removeAttribute("src"); video.load();
    error.hidden = true; stopped = false; loading = true; retries = 0; mediaRecoveries = 0; selectedLevel = -1;
    state.textContent = "Connecting…"; closeMenu(); quality.innerHTML = "Auto"; quality.disabled = true; render(); tick();
    try {
      const { default: Engine, Events, ErrorTypes } = await import("hls.js");
      if (life.signal.aborted || attempt !== generation) return;
      if (!Engine.isSupported()) {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          quality.title = "Your browser selects live quality automatically";
          video.src = source(); if (options.autoplay !== false) void play(); return;
        }
        return fail("This browser cannot play HLS live streams. Try a current version of Chrome, Edge, Firefox or Safari.");
      }
      const engine = hls = new Engine({
        lowLatencyMode: true, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6,
        backBufferLength: 30, maxLiveSyncPlaybackRate: 1.2,
      });
      engine.on(Events.MANIFEST_PARSED, () => {
        if (life.signal.aborted || attempt !== generation) return;
        selectedLevel = -1; closeMenu(); renderQuality();
        const videoRates = engine.levels.filter((level) => level.height > 0).map((level) => level.bitrate);
        if (videoRates.length) engine.config.minAutoBitrate = Math.min(...videoRates);
        const cap = engine.levels.reduce((best, level, index) => level.height <= (prefs?.maxQuality ?? 2160) ? index : best, -1);
        engine.autoLevelCapping = cap < 0 ? 0 : cap;
        quality.disabled = false;
        if (options.autoplay !== false) void play(); else state.textContent = "Press play to watch";
      });
      engine.on(Events.LEVEL_SWITCHED, renderQuality);
      engine.on(Events.FRAG_BUFFERED, () => { retries = 0; });
      engine.on(Events.ERROR, (_event, data) => {
        if (!data.fatal || life.signal.aborted || attempt !== generation) return;
        if (data.type === ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) { engine.recoverMediaError(); return; }
        if (data.type === ErrorTypes.NETWORK_ERROR && retries++ < 3) {
          state.textContent = "Reconnecting…";
          reconnectTimer = setTimeout(() => { if (!life.signal.aborted && attempt === generation) { engine.loadSource(source()); engine.startLoad(); } }, retries * 1000);
          return;
        }
        fail("The broadcast disconnected or ended. Reconnect to check for a fresh stream.");
      });
      engine.attachMedia(video); engine.loadSource(source());
    } catch (e) { if (!life.signal.aborted && attempt === generation) fail(`Live playback could not start. ${errorMessage(e)}`); }
  }
  function key(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = targetOf(event), tag = target.tagName;
    if ((tag === "INPUT" && !target.matches(".pl-range, .pl-vol")) || tag === "TEXTAREA" || target.isContentEditable || tag === "SELECT") return false;
    if ((tag === "BUTTON" || tag === "A") && (event.key === " " || event.key === "Enter")) return false;
    if (!menu.hidden && (target === quality || menu.contains(target)) && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const items = [...menu.querySelectorAll<HTMLButtonElement>("button")], at = items.indexOf(target as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : at < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus(); event.preventDefault(); return true;
    }
    switch (event.key.toLowerCase()) {
      case " ": case "k": toggle(); break;
      case "m": actions.mute(); break;
      case "f": fullscreen(); break;
      case "t": theatre(); break;
      case "i": pip(); break;
      case "j": seek(video.currentTime - 10); break;
      case "l": seek(video.currentTime + 10); break;
      case "arrowleft": seek(video.currentTime - 5); break;
      case "arrowright": seek(video.currentTime + 5); break;
      case "arrowup": setVolume(video.volume + 0.05); break;
      case "arrowdown": setVolume(video.volume - 0.05); break;
      case "end": goLive(); break;
      case "escape": if (menu.hidden) return false; closeMenu(); quality.focus(); break;
      default: return false;
    }
    event.preventDefault(); wake(); return true;
  }
  root.addEventListener("keydown", (event) => { if (key(event)) event.stopPropagation(); }, { signal: life.signal });
  render(); tick(); void connect();
  return {
    key, seek,
    get time() { return video.currentTime; },
    async captions() {},
    get quality() { return selectedLevel < 0 ? "Auto" : hls?.levels[selectedLevel] ? label(hls.levels[selectedLevel]) : "Auto"; },
    destroy() {
      generation++; life.abort(); clearTimeout(reconnectTimer); clearTimeout(idleTimer); hls?.destroy();
      video.pause(); video.removeAttribute("src"); video.load(); root.innerHTML = "";
    },
  };
}
