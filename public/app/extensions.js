// Extension host. An extension is an ES module whose default export describes what it adds:
//
//   id, name, version, author, description, icon, permissions: [strings shown to the user]
//   settings:        [{ key, type: "toggle" | "select", label, default, options? }]
//   topbar:          { icon, label, title, onClick(api) }            a button in the top bar
//   watchPanels:     [{ id, render(ctx, api) -> html, mount?(el, ctx, api) }]   panels under a video
//   captionRequests: async (ctx, api) -> [{ id, task, label, note, cached, auto, beforeAuto, start(report) -> url }]
//
// Every extension is off until the user turns it on. Built-ins ship with the app; others are added
// by URL and run with the app's full access, so the Extensions page says so.
import { store, is } from "./storage.js";
import { icon } from "/icons.js";
import { esc, compact, fmtTime, ago, toast } from "./util.js";
import insights from "./extensions/insights.js";
import aiCaptions from "./extensions/ai-captions.js";

const builtins = [insights, aiCaptions];
let installed = []; // user-added, loaded from their URLs
const listeners = new Set();
const errors = new Map();

const enabledMap = () => store.get("ext.enabled", {}, is.object);
const settingsOf = (id) => store.get(`ext.settings.${id}`, {}, is.object);

export const extensions = {
  all: () => [...builtins.map((e) => ({ ...e, builtin: true })), ...installed.map((e) => ({ ...e, builtin: false }))],
  /** Installed extensions whose module failed to load stay listed (marked broken) so they can be removed. */
  errors: () => errors,
  isEnabled: (id) => !!enabledMap()[id],
  setEnabled(id, on) { store.set("ext.enabled", { ...enabledMap(), [id]: on }); emit(); },
  getSetting(ext, key) { return settingsOf(ext.id)[key] ?? ext.settings?.find((s) => s.key === key)?.default; },
  setSetting(ext, key, value) { store.set(`ext.settings.${ext.id}`, { ...settingsOf(ext.id), [key]: value }); emit(); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  active: () => extensions.all().filter((e) => !e.broken && extensions.isEnabled(e.id)),

  async add(url) {
    url = String(url ?? "").trim();
    if (!url) throw new Error("Enter the address of an extension module.");
    const u = new URL(url, location.href);
    const mod = await import(/* @vite-ignore */ u.href);
    const ext = mod.default;
    if (!ext?.id || !ext?.name) throw new Error("That module doesn't export an extension (needs a default export with id and name).");
    if (extensions.all().some((e) => e.id === ext.id)) throw new Error(`An extension with the id “${ext.id}” is already added.`);
    store.set("ext.installed", [...store.get("ext.installed", [], is.strings), u.href]);
    installed.push({ ...ext, url: u.href });
    emit();
    return ext;
  },
  remove(id) {
    const ext = installed.find((e) => e.id === id);
    if (!ext) return;
    store.set("ext.installed", store.get("ext.installed", [], is.strings).filter((u) => u !== ext.url));
    installed = installed.filter((e) => e.id !== id);
    errors.delete(id);
    const { [id]: _gone, ...rest } = enabledMap();
    store.set("ext.enabled", rest);
    store.remove(`ext.settings.${id}`);
    store.removePrefix(`ext.data.${id}.`);      // its notes and other saved data go with it
    emit();
  },

  // --- extension points, each guarded so one broken extension can't take the page down ---
  topbarItems: () => extensions.active().filter((e) => e.topbar).map((e) => ({ ext: e, ...e.topbar })),
  watchPanels(ctx) {
    return extensions.active().flatMap((e) => (e.watchPanels ?? []).map((p) => {
      try { return { ext: e, id: `${e.id}-${p.id}`, html: p.render(ctx, apiFor(e)), mount: p.mount }; }
      catch (err) { return fail(e, err); }
    })).filter(Boolean);
  },
  async captionRequests(ctx) {
    const out = await Promise.all(extensions.active().filter((e) => e.captionRequests).map(async (e) => {
      try { return await e.captionRequests(ctx, apiFor(e)); } catch (err) { fail(e, err); return []; }
    }));
    return out.flat();
  },
  api: apiFor,
};

function fail(ext, err) { console.error(`Extension ${ext.id}:`, err); errors.set(ext.id, String(err.message ?? err)); return null; }
function emit() { for (const fn of listeners) fn(); }

let currentPlayer = null;
export const setCurrentPlayer = (p) => { currentPlayer = p; };

/** What an extension may touch. Storage and settings are scoped to the extension and profile. */
function apiFor(ext) {
  return {
    id: ext.id,
    settings: { get: (key) => extensions.getSetting(ext, key), set: (key, v) => extensions.setSetting(ext, key, v) },
    storage: { get: (k, d) => store.get(`ext.data.${ext.id}.${k}`, d), set: (k, v) => store.set(`ext.data.${ext.id}.${k}`, v) },
    player: () => currentPlayer,
    toast, icon, esc, compact, fmtTime, ago,
  };
}

// Load previously added extensions. One that no longer loads (offline URL, bad module) stays in the
// list as a broken entry, so the user can see why and remove it.
await Promise.all(store.get("ext.installed", [], is.strings).map(async (url) => {
  try {
    const ext = (await import(/* @vite-ignore */ url)).default;
    if (!ext?.id || !ext?.name) throw new Error("it doesn't export an extension");
    installed.push({ ...ext, url });
  } catch (err) {
    installed.push({ id: url, name: "Extension that couldn't be loaded", description: url, broken: true, url });
    errors.set(url, `Couldn't load it: ${err.message}`);
  }
}));
