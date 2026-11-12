import type { Profile } from "./types.js";
// Everything the app remembers is keyed by the active profile, so switching profiles swaps
// history, likes, pins, settings and extensions together. Profiles themselves are global.
// Stored data is untrusted: anything with the wrong shape is ignored in favour of the default,
// and a failed write (quota, private mode) never throws.
import { toast } from "./util.js";

const GLOBAL = "own.profiles";
const COLORS = ["#ffb020", "#4cc9f0", "#ff6b81", "#7bd88f", "#b79cff", "#ff9f6b"];

const readJSON = <T>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const is = {
  object: isObject,
  array: Array.isArray,
  strings: (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"),
};

let warned = false;
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); return true; }
  catch {
    if (!warned) { warned = true; toast("Couldn't save to this browser's storage. Changes last until the tab closes."); }
    return false;
  }
}

function loadProfiles() {
  const g = readJSON<unknown>(GLOBAL, null);
  const profiles: Profile[] = isObject(g) && Array.isArray(g.profiles)
    ? g.profiles.filter((p): p is Record<string, unknown> => isObject(p) && typeof p.id === "string" && !!p.id && typeof p.name === "string")
      .map((p) => ({ id: String(p.id), name: String(p.name), color: typeof p.color === "string" ? p.color : COLORS[0] }))
    : [];
  if (!profiles.length) {
    const first = { profiles: [{ id: "k", name: "K", color: COLORS[0] }], current: "k" };
    write(GLOBAL, first);
    return first;
  }
  return { profiles, current: profiles.some((p) => p.id === (isObject(g) ? g.current : undefined)) ? String(isObject(g) ? g.current : profiles[0].id) : profiles[0].id };
}
const save = (g: { profiles: Profile[]; current: string }) => write(GLOBAL, g);

export const profiles = {
  list: () => loadProfiles().profiles,
  current() { const g = loadProfiles(); return g.profiles.find((p) => p.id === g.current) ?? g.profiles[0]; },
  switchTo(id: string) { const g = loadProfiles(); if (g.profiles.some((p) => p.id === id)) { g.current = id; save(g); } },
  add(name: string, color?: string) {
    const g = loadProfiles();
    let base = name.trim().slice(0, 40) || "New profile", unique = base;
    for (let n = 2; g.profiles.some((p) => p.name === unique); n++) unique = `${base} ${n}`;
    const p = { id: `p${Date.now().toString(36)}`, name: unique, color: color ?? COLORS[g.profiles.length % COLORS.length] };
    g.profiles.push(p); g.current = p.id; save(g); return p;
  },
  rename(id: string, name: string) { const g = loadProfiles(); const p = g.profiles.find((x) => x.id === id); if (p && name.trim()) { p.name = name.trim().slice(0, 40); save(g); } },
  remove(id: string) {
    const g = loadProfiles();
    if (g.profiles.length < 2) return false;
    g.profiles = g.profiles.filter((p) => p.id !== id);
    if (g.current === id) g.current = g.profiles[0].id;
    save(g);
    for (const k of Object.keys(localStorage)) if (k.startsWith(`own.${id}.`)) localStorage.removeItem(k);
    return true;
  },
  colors: COLORS,
};

const key = (name: string) => `own.${profiles.current().id}.${name}`;
export const store = {
  /** Reads a value; `valid` rejects stored data of the wrong shape. */
  get<T>(name: string, fallback: T, valid?: (value: unknown) => boolean): T { const v = readJSON(key(name), fallback); return valid && !valid(v) ? fallback : v; },
  set: (name: string, value: unknown) => write(key(name), value),
  remove: (name: string) => localStorage.removeItem(key(name)),
  /** Removes every stored value whose name starts with `prefix` (for the current profile). */
  removePrefix(prefix: string) { const p = key(prefix); for (const k of Object.keys(localStorage)) if (k.startsWith(p)) localStorage.removeItem(k); },
  raw: { get: (name: string) => localStorage.getItem(key(name)), set: (name: string, v: unknown) => write(key(name), String(v)), remove: (name: string) => localStorage.removeItem(key(name)) },
};

// One-time move of the prototype's unscoped data into the first profile.
for (const [from, to] of [["proto.lib", "own.k.lib"], ["proto.pins", "own.k.pins"]]) {
  const old = localStorage.getItem(from);
  if (old == null) continue;
  if (localStorage.getItem(to) == null) write(to, old);
  localStorage.removeItem(from);
}
