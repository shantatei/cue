import type Hls from "hls.js";
import type { PlayerAPI, PlayerOptions, VideoInfo } from "./types.js";
import { errorMessage } from "./errors.js";

/** HLS owns audio/video synchronisation and the sliding live window. Loaded only for broadcasts. */
export function mountLivePlayer(root: HTMLElement, info: VideoInfo, options: PlayerOptions): PlayerAPI {
  root.classList.add("pl", "pl-live");
  root.tabIndex = 0;
  root.innerHTML = `<video controls playsinline preload="auto" aria-label="Live stream"></video>
    <div class="live-tools"><button type="button" class="live-edge" title="Jump to the live broadcast">● LIVE</button>
      <span class="live-state" role="status">Connecting…</span><span class="live-gap"></span>
      <label>Quality <select aria-label="Live stream quality"><option value="-1">Auto</option></select></label>
      <button type="button" data-theatre aria-label="Theatre mode (t)">Theatre</button></div>
    <div class="live-error" role="alert" hidden><p></p><button type="button" data-retry>Reconnect</button></div>`;
  const video = root.querySelector("video")!;
  const quality = root.querySelector("select")!;
  const state = root.querySelector<HTMLElement>(".live-state")!;
  const edge = root.querySelector<HTMLButtonElement>(".live-edge")!;
  const error = root.querySelector<HTMLElement>(".live-error")!;
  const life = new AbortController();
  const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => video.addEventListener(type, fn, { signal: life.signal });
  let hls: Hls | undefined, generation = 0, retries = 0, mediaRecoveries = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const prefs = options.prefs;
  video.volume = Math.min(1, Math.max(0, prefs?.volume ?? 1));
  video.muted = prefs?.muted ?? false;
  const source = () => `/api/live?${new URLSearchParams({ v: info.id, p: options.profile ?? "" })}`;
  const play = () => video.play().catch(() => { if (!life.signal.aborted) state.textContent = "Press play to watch"; });
  const fail = (message: string) => {
    stopped = true; hls?.stopLoad(); video.pause();
    error.querySelector("p")!.textContent = message; error.hidden = false; state.textContent = "Disconnected";
  };
  const liveTime = () => hls?.liveSyncPosition ?? (video.seekable.length ? Math.max(video.seekable.start(0), video.seekable.end(video.seekable.length - 1) - 2) : null);
  const seek = (time: number) => {
    if (!Number.isFinite(time) || !video.seekable.length) return;
    // Seekable may contain discontinuities; choose the nearest valid interval.
    let nearest = video.seekable.start(0), distance = Infinity;
    for (let i = 0; i < video.seekable.length; i++) {
      const point = Math.max(video.seekable.start(i), Math.min(time, video.seekable.end(i) - 0.1));
      if (Math.abs(point - time) < distance) { nearest = point; distance = Math.abs(point - time); }
    }
    video.currentTime = nearest;
  };
  const goLive = () => { const time = liveTime(); if (time !== null) seek(time); video.playbackRate = 1; void play(); };
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else void root.requestFullscreen().catch(() => {}); };
  const theatre = () => root.dispatchEvent(new CustomEvent("player:theatre"));
  on("volumechange", () => { if (prefs) { prefs.volume = video.volume; prefs.muted = video.muted; options.savePrefs?.(); } });
  on("playing", () => { state.textContent = ""; });
  on("pause", () => { if (!stopped) state.textContent = "Paused"; });
  on("waiting", () => { if (!stopped) state.textContent = "Buffering…"; });
  on("ended", () => { state.textContent = "Broadcast ended"; options.onEnded?.(); });
  on("error", () => { if (!hls && !life.signal.aborted) fail("The live stream could not load. Try reconnecting."); });
  on("timeupdate", () => {
    const live = liveTime(), behind = live !== null && live - video.currentTime > 8;
    edge.classList.toggle("behind", behind); edge.textContent = behind ? "● Go live" : "● LIVE";
  });
  edge.addEventListener("click", goLive, { signal: life.signal });
  root.querySelector("[data-theatre]")!.addEventListener("click", theatre, { signal: life.signal });
  quality.addEventListener("change", () => { if (hls) hls.currentLevel = Number(quality.value); }, { signal: life.signal });

  async function connect() {
    const attempt = ++generation;
    clearTimeout(reconnectTimer); hls?.destroy(); hls = undefined;
    video.removeAttribute("src"); video.load();
    error.hidden = true; stopped = false; retries = 0; mediaRecoveries = 0;
    state.textContent = "Connecting…";
    quality.innerHTML = `<option value="-1">Auto</option>`; quality.disabled = true;
    try {
      const { default: Engine, Events, ErrorTypes } = await import("hls.js");
      if (life.signal.aborted || attempt !== generation) return;
      if (!Engine.isSupported()) {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
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
        quality.innerHTML = `<option value="-1">Auto</option>`;
        for (const [index, level] of engine.levels.entries()) {
          if (!level.height) continue; // Some masters include an audio-only rendition as a level.
          const option = document.createElement("option"); option.value = String(index);
          option.textContent = `${level.height}p${level.frameRate > 30 ? Math.round(level.frameRate) : ""}`; quality.append(option);
        }
        const videoRates = engine.levels.filter((level) => level.height > 0).map((level) => level.bitrate);
        if (videoRates.length) engine.config.minAutoBitrate = Math.min(...videoRates);
        const cap = engine.levels.reduce((best, level, index) => level.height <= (prefs?.maxQuality ?? 2160) ? index : best, -1);
        engine.autoLevelCapping = cap < 0 ? 0 : cap;
        quality.disabled = false;
        if (options.autoplay !== false) void play(); else state.textContent = "Press play to watch";
      });
      engine.on(Events.FRAG_BUFFERED, () => { retries = 0; });
      engine.on(Events.ERROR, (_event, data) => {
        if (!data.fatal || life.signal.aborted || attempt !== generation) return;
        if (data.type === ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) { engine.recoverMediaError(); return; }
        if (data.type === ErrorTypes.NETWORK_ERROR && retries++ < 3) {
          state.textContent = "Reconnecting…";
          // Reload the root, so an expired rendition token or signed URL gets refreshed too.
          reconnectTimer = setTimeout(() => { if (!life.signal.aborted && attempt === generation) { engine.loadSource(source()); engine.startLoad(); } }, retries * 1000);
          return;
        }
        fail("The broadcast disconnected or ended. Reconnect to check for a fresh stream.");
      });
      engine.attachMedia(video); engine.loadSource(source());
    } catch (e) { if (!life.signal.aborted && attempt === generation) fail(`Live playback could not start. ${errorMessage(e)}`); }
  }
  root.querySelector("[data-retry]")!.addEventListener("click", () => void connect(), { signal: life.signal });
  void connect();
  return {
    key(event) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof Element && event.target.closest("input, textarea, select, button, a, [contenteditable=true]"))) return false;
      switch (event.key.toLowerCase()) {
        case " ": case "k": video.paused ? void play() : video.pause(); break;
        case "m": video.muted = !video.muted; break;
        case "f": fullscreen(); break;
        case "t": theatre(); break;
        case "j": seek(video.currentTime - 10); break;
        case "l": seek(video.currentTime + 10); break;
        case "arrowleft": seek(video.currentTime - 5); break;
        case "arrowright": seek(video.currentTime + 5); break;
        case "end": goLive(); break;
        default: return false;
      }
      event.preventDefault(); return true;
    },
    seek,
    get time() { return video.currentTime; },
    async captions() {},
    get quality() { return quality.selectedOptions[0]?.textContent ?? "Auto"; },
    destroy() {
      generation++; life.abort(); clearTimeout(reconnectTimer); hls?.destroy();
      video.pause(); video.removeAttribute("src"); video.load(); root.innerHTML = "";
    },
  };
}
