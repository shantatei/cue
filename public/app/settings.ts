import type { AppSettings, SettingValue } from "./types.js";
import { store, is } from "./storage.js";

export const DEFAULTS: AppSettings = {
  theme: "dark",                       // dark | light | system
  playback: { autoplay: true, maxQuality: 2160, rate: 1, volume: 1, muted: false, resume: true },
  captions: { show: "off", language: "original", size: 100, background: 70 },
};

// Stored values only count when they have the type of the default; anything else is ignored.
const merge = <T extends object>(base: T, over: unknown): T => {
  const raw = is.object(over) ? over : {};
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key,
    value && typeof value === "object" ? merge(value, raw[key]) : typeof raw[key] === typeof value ? raw[key] : value,
  ])) as T;
};

let current = merge(DEFAULTS, store.get<unknown>("settings", {}, is.object));
if (!["dark", "light", "system"].includes(current.theme)) current.theme = DEFAULTS.theme;
if (!["off", "on"].includes(current.captions.show)) current.captions.show = DEFAULTS.captions.show;
const listeners = new Set<(settings: AppSettings, path: string) => void>();

export const settings = {
  get: () => current,
  set(path: string, value: SettingValue) {
    // Mutate in place: the player holds a reference to settings.playback.
    const keys = path.split(".");
    const last = keys.pop();
    if (!last) return;
    let section = current as unknown as Record<string, unknown>;
    for (const key of keys) {
      const next = section[key]; if (!is.object(next)) return; section = next;
    }
    if (typeof section[last] !== typeof value) return;
    section[last] = value;
    applyTheme();                       // apply first: a failed save must not leave the UI out of step
    store.set("settings", current);
    for (const fn of listeners) fn(current, path);
  },
  reset() {
    const fresh = structuredClone(DEFAULTS);
    fresh.playback.volume = current.playback.volume;   // volume and mute live in the player, not on the Settings page
    fresh.playback.muted = current.playback.muted;
    const assign = (to: Record<string, unknown>, from: Record<string, unknown>) => {
      for (const key of Object.keys(from)) {
        const value = from[key], dest = to[key];
        if (is.object(value) && is.object(dest)) assign(dest, value); else to[key] = value;
      }
    };
    assign(current as unknown as Record<string, unknown>, fresh as unknown as Record<string, unknown>);
    store.set("settings", current); applyTheme();
    for (const fn of listeners) fn(current, "*");
  },
  onChange(fn: (settings: AppSettings, path: string) => void) { listeners.add(fn); return () => listeners.delete(fn); },
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
