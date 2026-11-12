import { store, is } from "./storage.js";

export const DEFAULTS = {
  theme: "dark",                       // dark | light | system
  playback: { autoplay: true, maxQuality: 2160, rate: 1, volume: 1, muted: false, resume: true },
  captions: { show: "off", language: "original", size: 100, background: 70 },
};

// Stored values only count when they have the type of the default; anything else is ignored.
const merge = (base, over) => Object.fromEntries(Object.entries(base).map(([k, v]) =>
  [k, v && typeof v === "object" ? merge(v, over?.[k]) : typeof over?.[k] === typeof v ? over[k] : v]));

let current = merge(DEFAULTS, store.get("settings", {}, is.object));
const listeners = new Set();

export const settings = {
  get: () => current,
  set(path, value) {
    // Mutate in place: the player holds a reference to settings.playback.
    const keys = path.split(".");
    const last = keys.pop();
    keys.reduce((o, k) => o[k], current)[last] = value;
    applyTheme();                       // apply first: a failed save must not leave the UI out of step
    store.set("settings", current);
    for (const fn of listeners) fn(current, path);
  },
  reset() {
    const fresh = structuredClone(DEFAULTS);
    fresh.playback.volume = current.playback.volume;   // volume and mute live in the player, not on the Settings page
    fresh.playback.muted = current.playback.muted;
    const assign = (to, from) => { for (const k of Object.keys(from)) from[k] && typeof from[k] === "object" ? assign(to[k], from[k]) : (to[k] = from[k]); };
    assign(current, fresh);
    store.set("settings", current); applyTheme();
    for (const fn of listeners) fn(current, "*");
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

const media = matchMedia("(prefers-color-scheme: light)");
export function applyTheme() {
  const t = current.theme === "system" ? (media.matches ? "light" : "dark") : current.theme;
  document.documentElement.dataset.theme = t;
}
media.addEventListener("change", applyTheme);
applyTheme();

/** The player reads and writes its prefs through this object so Settings and the player agree. */
export const playerPrefs = () => ({
  prefs: current.playback,
  save: () => store.set("settings", current),
});
