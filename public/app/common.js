// Shared logic for the three design drafts: data, formatting, routing and the pages every
// draft needs (watch, search, channel, library, shorts, manage). Drafts own the shell,
// the home composition and all styling.
import { icon } from "/icons.js";
import { mountPlayer } from "/player.js";
import { esc, compact, $, $$, fmtTime, ago, dayLabel, toast, copyText } from "./util.js";
import { store, is, profiles } from "./storage.js";
import { cache } from "./cache.js";
import { settings, playerPrefs } from "./settings.js";
import { extensions, setCurrentPlayer } from "./extensions.js";
import { avatar, installAvatarFallbacks } from "./avatars.js";
import { thumb, installThumbnailFallbacks } from "./thumbnails.js";
import { SEARCH_OPTIONS, SEARCH_CHIPS, normalizeSearchFilters, quickSearchFilter, filterWatched } from "./search-filters.js";
export { thumb };
installThumbnailFallbacks();
export { avatar };
installAvatarFallbacks();

export { icon, esc, compact, $, $$, fmtTime, ago, dayLabel, toast };

/** Signed-in data for the current profile: real subscriptions, their feed, and recommendations. */
async function fetchAccountRaw(pid) {
  const get = (path) => fetch(`/api/account/${path}${path.includes("?") ? "&" : "?"}p=${encodeURIComponent(pid)}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
  const [channels, subsFeed, home] = await Promise.all([get("channels"), get("feed?kind=subs"), get("feed?kind=home").catch(() => [])]);
  return { channels, subsFeed, home };
}

function buildAccountData({ channels: chs, subsFeed, home }, account) {
  const group = { id: "all", name: "Subscriptions", code: "ALL" };
  const channels = new Map(chs.map((c) => [c.id, c]));
  const byName = new Map(chs.map((c) => [c.name, c]));
  const attach = (v) => { const ch = channels.get(v.channelId) ?? byName.get(v.channel) ?? null; return { ...v, channelId: v.channelId ?? ch?.id ?? null, ch, group }; };
  const videos = subsFeed.map(attach).sort((a, b) => (b.live - a.live) || ((b.timestamp ?? 0) - (a.timestamp ?? 0)));
  const fresh = new Set(videos.filter((v) => v.live || (v.timestamp && Date.now() / 1000 - v.timestamp < 4 * 86400)).map((v) => v.channelId));
  const subs = chs.map((c) => ({ name: c.name, group, channelId: c.id, ch: c, fresh: fresh.has(c.id) })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { groups: [group], subs, videos, home: home.map(attach), shorts: [], channels, fresh, live: true, account };
}

/**
 * Stale-while-revalidate. If this device has seen the account's lists before, they are drawn from the
 * local copy straight away (no network wait) and `data.refresh()` brings them up to date; the app is
 * told through `data.onUpdate`. The first ever visit has nothing saved and waits for the server.
 */
async function loadAccountData(pid, account) {
  const key = `acct:${pid}`;
  const saved = await cache.get(key);
  const raw = saved?.raw ?? await fetchAccountRaw(pid);
  if (!saved?.raw) cache.set(key, { at: Date.now(), raw });
  const data = buildAccountData(raw, account), listeners = new Set();
  let current = JSON.stringify(raw), lastRefresh = saved?.raw ? 0 : Date.now();
  data.onUpdate = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  data.refresh = async () => {
    lastRefresh = Date.now();
    try {
      const next = await fetchAccountRaw(pid), text = JSON.stringify(next);
      if (text === current) return;
      current = text;
      cache.set(key, { at: Date.now(), raw: next });
      Object.assign(data, buildAccountData(next, data.account));   // same object, so everything holding it sees the new lists
      for (const fn of listeners) fn("updated");
    } catch (e) { for (const fn of listeners) fn("error", e); }
  };
  data.staleFor = () => Date.now() - lastRefresh;
  return data;
}

export async function loadData() {
  const pid = profiles.current().id;
  const account = await fetch(`/api/account?p=${encodeURIComponent(pid)}`).then((r) => (r.ok ? r.json() : { connected: false })).catch(() => ({ connected: false }));
  let failure = null;
  if (account.connected && !account.needsReconnect) {
    try { return await loadAccountData(pid, account); } catch (e) { failure = e.message; }
  }
  const data = await loadSampleData();
  data.account = { ...account, error: failure };
  return data;
}

async function loadSampleData() {
  const f = await (await fetch("/app/fixture.json")).json();
  const channels = new Map(f.channels.map((c) => [c.id, c]));
  const groups = new Map(f.groups.map((g) => [g.id, g]));
  const subs = f.subscriptions.map((s) => ({ ...s, ch: channels.get(s.channelId) ?? null, group: groups.get(s.group) }));
  const groupOf = new Map(subs.filter((s) => s.channelId).map((s) => [s.channelId, s.group]));
  const videos = f.videos.map((v) => ({ ...v, ch: channels.get(v.channelId), group: groupOf.get(v.channelId) })).sort((a, b) => b.timestamp - a.timestamp);
  const fresh = new Set(videos.filter((v) => Date.now() / 1000 - v.timestamp < 4 * 86400).map((v) => v.channelId));
  for (const s of subs) s.fresh = fresh.has(s.channelId);
  subs.sort((a, b) => a.name.localeCompare(b.name, "en"));
  const shorts = f.shorts.map((s) => ({ ...s, ch: channels.get(s.channelId) }));
  return { groups: f.groups, subs, videos, shorts, channels, fresh };
}

// --- local library: history, watch later, likes, pins, resume points ---------------------
const read = () => store.get("lib", {}, is.object);
export const lib = {
  list: (name) => read()[name] ?? [],
  has: (name, id) => (read()[name] ?? []).some((v) => v.id === id),
  add(name, item) { const all = read(); all[name] = [item, ...(all[name] ?? []).filter((v) => v.id !== item.id)].slice(0, 300); store.set("lib", all); },
  remove(name, id) { const all = read(); all[name] = (all[name] ?? []).filter((v) => v.id !== id); store.set("lib", all); },
  toggle(name, item) { const on = lib.has(name, item.id); on ? lib.remove(name, item.id) : lib.add(name, item); return !on; },
  clear(name) { const all = read(); all[name] = []; store.set("lib", all); },
};

// --- small building blocks ------------------------------------------------------------------
export const verified = (ch) => (ch?.verified ? `<span class="ok" title="Verified">${icon("verified", 14)}</span>` : "");
export const chanName = (v) => v.ch?.name ?? v.channel ?? "";
export const metaLine = (v) => [v.views != null ? `${compact(v.views)} views` : "", ago(v.timestamp)].filter(Boolean).join(" · ");

export const card = (v, { avatars = true } = {}) => `
<a class="card" href="#/watch/${v.id}">
  <span class="thumb">${thumb(v.id, "hq720", v.thumbnail)}${v.live ? `<span class="dur live">LIVE</span>` : v.duration ? `<span class="dur">${fmtTime(v.duration)}</span>` : ""}</span>
  <span class="cmeta">${avatars ? avatar({ ...v.ch, id: v.ch?.id ?? v.channelId, videoId: v.id }, chanName(v)) : ""}
    <span class="ctxt"><span class="ct">${esc(v.title)}</span>
    <span class="cc">${esc(chanName(v))}${verified(v.ch)}</span>
    <span class="cs">${metaLine(v)}</span></span></span>
</a>`;

export const chanHref = (s) => (s.channelId ? `#/channel/${s.channelId}` : `#/search/${encodeURIComponent(s.name)}`);
export const skeletonCards = (n = 8) => Array.from({ length: n }, () => `<div class="card sk-card"><span class="thumb sk"></span><span class="cmeta"><span class="av sk"></span><span class="ctxt"><span class="sk sk-l"></span><span class="sk sk-s"></span></span></span></div>`).join("");
export const empty = (title, body) => `<div class="empty"><h2>${esc(title)}</h2><p>${body}</p></div>`;

/** Opens a popover under `anchor`; closes on outside click or Escape. Returns the element. */
let openPopover = null; // { anchor, close }
export function closePopovers() { openPopover?.close(); }
export function popover(anchor, html, cls = "") {
  const reopening = openPopover?.anchor === anchor;   // clicking the same button again closes it
  closePopovers();
  if (reopening) return null;
  const pop = Object.assign(document.createElement("div"), { className: `pop ${cls}`, innerHTML: html });
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  const off = new AbortController();
  const close = () => { pop.remove(); off.abort(); if (openPopover?.close === close) openPopover = null; };
  openPopover = { anchor, close };
  setTimeout(() => document.addEventListener("pointerdown", (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); }, { signal: off.signal }));
  document.addEventListener("keydown", (e) => e.key === "Escape" && close(), { signal: off.signal });
  pop.addEventListener("click", (e) => e.target.closest("a, [data-close], [data-toast]") && close());
  return pop;
}

export function bellHtml(data) {
  return `<h3>Latest from your subscriptions</h3>${data.videos.slice(0, 6).map((v) =>
    `<a class="note" href="#/watch/${v.id}">${avatar(v.ch, chanName(v))}<span><b>${esc(chanName(v))}</b> uploaded ${esc(v.title)}<small>${ago(v.timestamp)}</small></span>${thumb(v.id, "mqdefault")}</a>`).join("")}`;
}
export const createHtml = () => `<button class="menuitem" data-toast="Uploading from this app isn\u2019t supported yet.">${icon("video")} Upload video</button><button class="menuitem" data-toast="Going live from this app isn\u2019t supported yet.">${icon("live")} Go live</button>`;
document.addEventListener("click", (e) => { const t = e.target.closest("[data-toast]"); if (t) toast(t.dataset.toast); });

// --- routing --------------------------------------------------------------------------------
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };  // a hand-typed "%" is not an error
export function parseRoute() {
  const h = location.hash.slice(2), i = h.indexOf("/");
  return i < 0 ? { page: h, arg: "" } : { page: h.slice(0, i), arg: safeDecode(h.slice(i + 1)) };
}
export function startRouter(render) {
  const run = () => render(parseRoute());
  addEventListener("hashchange", run);
  run();
}

// --- filters for the home chips ----------------------------------------------------------------
export const FILTERS = [
  ["all", "All", () => true], ["today", "Today", (v) => Date.now() / 1000 - v.timestamp < 86400 * 1.5],
  ["week", "This week", (v) => Date.now() / 1000 - v.timestamp < 7 * 86400],
  ["long", "Over 20 min", (v) => v.duration > 1200], ["short", "Under 10 min", (v) => v.duration < 600],
];

// --- pages shared by every draft ------------------------------------------------------------------
const searchStates = new Map();
export function renderSearch(main, q, data) {
  if (!q.trim()) return (main.innerHTML = `<section class="page"><h1 class="ph">Search</h1>${empty("Type something to search", "Use the search box at the top.")}</section>`);
  let { filters, chip } = searchStates.get(q) ?? { filters: normalizeSearchFilters(), chip: "all" };
  let alive = true, controller, revision = 0, historyPromise;
  main.dataset.token = q;
  const select = (key, label) => `<label>${label}<select name="${key}">${SEARCH_OPTIONS[key].map(([id, text]) => `<option value="${id}" ${filters[key] === id ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
  main.innerHTML = `<section class="page search-page"><div class="search-controls"><div class="search-filter-row"><div class="search-chips" role="toolbar" aria-label="Search filters">${SEARCH_CHIPS.map(([id, label]) => `<button class="chip" data-search-filter="${id}" aria-pressed="${chip === id}">${label}</button>`).join("")}</div><button class="btn" data-search-advanced aria-controls="search-filter-panel" aria-expanded="false">Filters ${icon("filters", 18)}</button></div>
    <form id="search-filter-panel" class="search-filter-panel" hidden>${select("type", "Type")}${select("date", "Upload date")}${select("duration", "Duration")}${select("sort", "Sort by")}
    <fieldset><legend>Features</legend>${[["live", "Live"], ["uhd", "4K"], ["hd", "HD"], ["cc", "Subtitles/CC"]].map(([id, label]) => `<label><input type="checkbox" name="${id}" ${filters[id] ? "checked" : ""}> ${label}</label>`).join("")}</fieldset><div class="search-filter-actions"><button type="button" class="btn" data-search-reset>Reset</button><button class="btn" type="submit">Apply filters</button></div></form></div>
    <h1 class="ph">Results for “${esc(q)}”</h1><p class="search-history-note muted" hidden>Watched filters use this profile’s viewing history and the most recent YouTube history available.</p><div class="search-results"></div></section>`;
  const results = $(".search-results", main), panel = $("#search-filter-panel", main), advanced = $("[data-search-advanced]", main);
  main._cleanup = () => { alive = false; controller?.abort(); };
  const getHistory = async () => {
    if (!data.live) return [];
    historyPromise ??= fetch(`/api/account/feed?kind=history&p=${encodeURIComponent(profiles.current().id)}`).then(async (r) => r.ok ? r.json() : []).catch(() => []);
    return historyPromise;
  };
  const load = async () => {
    controller?.abort(); controller = new AbortController();
    const current = ++revision, requested = { ...filters };
    searchStates.set(q, { filters: requested, chip });
    if (searchStates.size > 50) searchStates.delete(searchStates.keys().next().value);
    $$("[data-search-filter]", main).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.searchFilter === chip)));
    advanced.classList.toggle("filters-active", JSON.stringify(requested) !== JSON.stringify(normalizeSearchFilters()));
    $(".search-history-note", main).hidden = requested.watched === "all";
    results.setAttribute("aria-busy", "true"); results.innerHTML = `<div class="grid">${skeletonCards(6)}</div>`;
    const params = new URLSearchParams({ q });
    for (const [key, value] of Object.entries(requested)) if (key !== "watched") params.set(key, typeof value === "boolean" ? value ? "1" : "0" : value);
    try {
      const [list, recent] = await Promise.all([
        fetch(`/api/search?${params}`, { signal: controller.signal }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; }),
        requested.watched === "all" ? [] : getHistory(),
      ]);
      if (!alive || revision !== current) return;
      const history = new Set([...lib.list("history"), ...recent].map((v) => v.id));
      const shown = filterWatched(list, requested, history);
      results.innerHTML = shown.length ? shown.map((v) => card(v)).join("") : empty("No results", "Try different filters or search terms.");
    } catch (e) { if (alive && revision === current && e.name !== "AbortError") results.innerHTML = empty("Search failed", esc(e.message)); }
    finally { if (alive && revision === current) results.removeAttribute("aria-busy"); }
  };
  const syncPanel = () => {
    for (const [key, value] of Object.entries(filters)) {
      const field = panel.elements.namedItem(key); if (!field) continue;
      if (field.type === "checkbox") field.checked = value; else field.value = value;
    }
  };
  $(".search-chips", main).onclick = (e) => {
    const button = e.target.closest("[data-search-filter]"); if (!button) return;
    chip = button.dataset.searchFilter; filters = quickSearchFilter(chip); syncPanel(); load();
  };
  advanced.onclick = () => { panel.hidden = !panel.hidden; advanced.setAttribute("aria-expanded", String(!panel.hidden)); };
  panel.onsubmit = (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(panel));
    for (const flag of ["live", "hd", "uhd", "cc"]) values[flag] = panel.elements.namedItem(flag).checked;
    filters = normalizeSearchFilters({ ...values, watched: filters.watched }); chip = "";
    panel.hidden = true; advanced.setAttribute("aria-expanded", "false"); load();
  };
  $("[data-search-reset]", main).onclick = () => { filters = normalizeSearchFilters(); chip = "all"; syncPanel(); load(); };
  load();
}

export async function renderChannel(main, id, data) {
  let ch = data.channels.get(id), vids, shorts = [];
  if (ch && !data.live) {
    vids = data.videos.filter((v) => v.channelId === id); shorts = data.shorts.filter((s) => s.channelId === id);
  } else {
    // A signed-in profile (or a channel outside the sample data): fetch the channel's own page.
    main.dataset.chan = id;
    main.innerHTML = `<section class="page"><header class="chead"><span class="av av-xl sk"></span><div><span class="sk sk-l" style="width:240px"></span></div></header><div class="grid">${skeletonCards(6)}</div></section>`;
    try {
      const r = await fetch(`/api/channel?id=${encodeURIComponent(id)}`), j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (main.dataset.chan !== id) return;
      ch = { ...(data.channels.get(id) ?? {}), ...j }; vids = j.videos.map((v) => ({ ...v, ch }));
    } catch (e) { if (main.dataset.chan === id) main.innerHTML = `<section class="page">${empty("Couldn't load this channel", esc(e.message))}</section>`; return; }
  }
  const subscribed = data.subs.some((s) => s.channelId === id);
  main.innerHTML = `<section class="page"><header class="chead">${avatar(ch, ch.name, "av-xl")}<div><h1 class="ph">${esc(ch.name)}${verified(ch)}</h1>
    <p class="muted">${esc(ch.handle ?? "")}${ch.subs != null ? ` · ${compact(ch.subs)} subscribers` : ""}</p></div><button class="btn btn-sub ${subscribed ? "on" : ""}" data-sub>${subscribed ? "Subscribed" : "Subscribe"}</button></header>
    <h2 class="sh">Latest videos</h2><div class="grid">${vids.map((v) => card(v, { avatars: false })).join("") || ""}</div>
    ${shorts.length ? `<h2 class="sh">Shorts</h2><div class="shorts">${shorts.map(shortTile).join("")}</div>` : ""}</section>`;
  const sub = $("[data-sub]", main);
  sub.onclick = () => { const on = sub.classList.toggle("on"); sub.textContent = on ? "Subscribed" : "Subscribe"; toast(on ? "Subscribed here only. Syncing to YouTube needs sign-in." : "Unsubscribed here only."); };
}

export const shortTile = (s) => `<a class="short" href="#/watch/${s.id}"><span class="thumb">${thumb(s.id, "hq720", s.thumbnail)}</span><span class="ct">${esc(s.title)}</span><span class="cs">${[s.channel, s.views != null ? `${compact(s.views)} views` : ""].filter(Boolean).map(esc).join(" · ")}</span></a>`;
export async function renderShorts(main, data) {
  if (data.live) {
    // Signed in: Shorts from the channels you follow. The last list this device saw is drawn first.
    const pid = profiles.current().id, key = `shorts:${pid}`;
    main.dataset.shorts = pid;
    const page = (inner) => `<section class="page"><h1 class="ph">Shorts</h1><p class="lede">From channels you subscribe to that posted recently.</p>${inner}</section>`;
    const paint = (list) => page(list.length ? `<div class="shorts">${list.map(shortTile).join("")}</div>` : empty("No Shorts found", "None of the channels you follow have posted Shorts lately."));
    const saved = await cache.get(key);
    if (main.dataset.shorts !== pid) return;
    main.innerHTML = saved?.items ? paint(saved.items)
      : page(`<div class="shorts" aria-busy="true">${Array.from({ length: 12 }, () => `<div class="short"><span class="thumb sk"></span><span class="sk sk-l"></span></div>`).join("")}</div>`);
    try {
      const r = await fetch(`/api/account/shorts?p=${encodeURIComponent(pid)}`), list = await r.json();
      if (!r.ok) throw new Error(list.error);
      if (main.dataset.shorts !== pid) return;
      cache.set(key, { at: Date.now(), items: list });
      if (JSON.stringify(list) !== JSON.stringify(saved?.items)) main.innerHTML = paint(list);
    } catch (e) { if (main.dataset.shorts === pid && !saved) main.innerHTML = page(empty("Couldn't load Shorts", esc(e.message))); }
    return;
  }
  main.innerHTML = `<section class="page"><h1 class="ph">Shorts</h1><div class="shorts">${data.shorts.map(shortTile).join("")}</div></section>`;
}

const LIBS = {
  history: ["History", "Videos you watch here show up in this list. Watch history from youtube.com can’t be read without signing in."],
  later: ["Watch later", "Press Watch later on a video and it lands here."],
  liked: ["Liked videos", "Videos you like here are collected in this list."],
  playlists: ["Playlists", "Playlists live in your YouTube account, which isn’t connected yet."],
  mine: ["Your videos", "Your uploads live in your YouTube account, which isn’t connected yet."],
  downloads: ["Downloads", "Use the Download button on a video; the file goes to your browser’s downloads."],
  channel: ["Your channel", "Your channel lives in your YouTube account, which isn’t connected yet."],
};
const LIB_FEEDS = { history: "history", later: "later", liked: "liked" };
export async function renderLib(main, name, data) {
  const [title, hint] = LIBS[name] ?? ["Library", ""];
  const local = ["history", "later", "liked"].includes(name) ? lib.list(name) : null;
  const connected = data?.live && LIB_FEEDS[name];
  const page = (inner) => `<section class="page"><h1 class="ph">${title}</h1>${inner}</section>`;
  const grid = (list) => `<div class="grid">${list.map((v) => card({ ...v, ch: data?.channels.get(v.channelId) ?? null }, { avatars: false })).join("")}</div>`;
  if (!connected) {
    const live = data?.live;   // signed in, but this page has no feed to read
    main.innerHTML = page(local?.length ? grid(local) : empty(local ? "Nothing here yet" : live ? "Not available here yet" : "Not available yet", live && !local ? "This list isn't readable from outside YouTube yet." : hint));
    return;
  }
  main.dataset.lib = name;
  const pid = profiles.current().id, key = `lib:${pid}:${name}`;
  const paint = (remote) => {
    const mine = local?.filter((v) => !remote.some((x) => x.id === v.id)) ?? [];
    main.innerHTML = page(`${remote.length ? grid(remote) : empty("Nothing here", "YouTube returned an empty list.")}${mine.length ? `<h2 class="sh">Also saved in this app</h2>${grid(mine)}` : ""}`);
  };
  // Show what this device saved last time at once, then replace it if YouTube's list has changed.
  const saved = await cache.get(key);
  if (main.dataset.lib !== name) return;
  saved?.items ? paint(saved.items) : (main.innerHTML = page(`<div class="grid" aria-busy="true">${skeletonCards(8)}</div>`));
  try {
    // fresh=1: a video watched on youtube.com a moment ago must show up, so skip the server's saved copy.
    const r = await fetch(`/api/account/feed?kind=${LIB_FEEDS[name]}&fresh=1&p=${encodeURIComponent(pid)}`), remote = await r.json();
    if (!r.ok) throw new Error(remote.error);
    if (main.dataset.lib !== name) return;
    const changed = JSON.stringify(remote) !== JSON.stringify(saved?.items);
    cache.set(key, { at: Date.now(), items: remote });
    if (changed) paint(remote);
  } catch (e) { if (main.dataset.lib === name && !saved) main.innerHTML = page(empty("Couldn't load this list", esc(e.message))); }
}

export function renderManage(main, data) {
  let sort = ["name", 1];
  const keys = { name: (s) => s.name.toLowerCase(), group: (s) => s.group.name, subs: (s) => s.ch?.subs ?? -1, latest: (s) => data.videos.find((v) => v.channelId === s.channelId)?.timestamp ?? 0 };
  const draw = () => {
    const rows = [...data.subs].sort((a, b) => { const x = keys[sort[0]](a), y = keys[sort[0]](b); return (x > y ? 1 : x < y ? -1 : 0) * sort[1]; });
    const grouped = data.groups.length > 1;
    main.innerHTML = `<section class="page"><h1 class="ph">All subscriptions <span class="muted">${rows.length}</span></h1><table class="tbl"><thead><tr>
      ${[["name", "Channel"], grouped && ["group", "Group"], ["subs", "Subscribers"], ["latest", "Latest upload"]].filter(Boolean).map(([k, l]) => `<th aria-sort="${sort[0] === k ? (sort[1] > 0 ? "ascending" : "descending") : "none"}"><button data-sort="${k}">${l}${sort[0] === k ? icon(sort[1] > 0 ? "up" : "down", 14) : ""}</button></th>`).join("")}
      </tr></thead><tbody>${rows.map((s) => { const last = keys.latest(s); return `<tr><td><a class="rowlink" href="${chanHref(s)}">${avatar(s.ch, s.name)}${esc(s.name)}${s.fresh ? `<i class="dot" title="New upload"></i>` : ""}</a></td>${grouped ? `<td>${esc(s.group.name)}</td>` : ""}<td>${s.ch?.subs != null ? compact(s.ch.subs) : "–"}</td><td>${last ? ago(last) : "–"}</td></tr>`; }).join("")}</tbody></table></section>`;
    $$("[data-sort]", main).forEach((b) => b.onclick = () => { sort = sort[0] === b.dataset.sort ? [sort[0], -sort[1]] : [b.dataset.sort, 1]; draw(); });
  };
  draw();
}

// --- watch page --------------------------------------------------------------------------------------
const linkify = (text) => esc(text)
  .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${u.length > 48 ? `${u.slice(0, 46)}…` : u}</a>`)
  .replace(/(^|\s)((?:\d{1,2}:)?\d{1,2}:\d{2})(?=\s|$)/g, (_, pre, t) => `${pre}<button class="ts" data-t="${t.split(":").reduce((a, n) => a * 60 + +n, 0)}">${t}</button>`);

function commentsHtml(list) {
  if (!list.length) return `<p class="muted">No comments to show.</p>`;
  return list.map((c) => `<article class="cm">${avatar({ avatar: c.avatar }, c.author)}<div><header><b>${esc(c.author)}</b>${c.byUploader ? `<span class="badge">Creator</span>` : ""}${c.pinned ? `<span class="badge">${icon("pin", 12)} Pinned</span>` : ""}<small>${ago(c.timestamp)}</small></header>
    <p>${esc(c.text)}</p><footer>${icon("like", 15)} ${compact(c.likes)}${c.hearted ? ` <span class="heart" title="Liked by creator">♥</span>` : ""}</footer></div></article>`).join("");
}

/**
 * Caption tracks and requests for the player, plus which one to start with.
 * Uploaded captions always win; after that AI captions (when that extension is on) and
 * YouTube's auto-generated track, in the order the extension asks for.
 */
const languages = new Intl.DisplayNames(["en"], { type: "language" });
const langName = (c) => { if (c.name && c.name !== c.lang && !/^[a-z]{2,3}(-|$)/i.test(c.name)) return c.name; try { return languages.of(c.lang) ?? c.name; } catch { return c.name; } };
function captionOptions(info, requests) {
  const s = settings.get().captions;
  const tracks = info.captions.map((c) => ({
    id: c.id, lang: c.lang, kind: c.kind, url: `/api/captions?v=${info.id}&c=${encodeURIComponent(c.id)}`,
    label: c.kind === "auto" ? `${langName(c)} (auto-generated)` : langName(c), note: c.kind === "auto" ? "YouTube" : "Uploaded",
  }));
  const manual = tracks.filter((t) => t.kind === "manual"), auto = tracks.find((t) => t.kind === "auto");
  const lang = (info.language ?? "").split("-")[0];
  const ownLang = manual.find((t) => lang && t.lang.split("-")[0] === lang) ?? (lang ? null : manual[0]);
  const english = manual.find((t) => t.lang.startsWith("en"));
  const ai = (task) => requests.find((r) => r.task === task && (r.cached || r.auto));
  const aiFirst = requests.some((r) => r.beforeAuto);
  const order = s.language === "en"
    ? [english, ai("translate"), ownLang, aiFirst && ai("transcribe"), auto, !aiFirst && ai("transcribe")]
    : [ownLang, aiFirst && ai("transcribe"), auto, !aiFirst && ai("transcribe")];
  const initial = s.show === "on" ? order.find(Boolean)?.id ?? null : null;
  const hint = extensions.isEnabled("ai-captions") ? "This video has no captions." : "This video has no captions. Turn on the AI captions extension to generate them.";
  return { tracks, requests, initial, size: s.size, background: s.background, emptyHint: hint };
}

const LOADING_STEPS = ["Contacting YouTube…", "Finding the best quality…", "Preparing the video and audio…", "Almost there…"];

// Likes and saves are kept in this app only; say so once per session so nobody expects YouTube to change.
let toldLocal = false;
function savedLocally() { if (toldLocal) return; toldLocal = true; toast("Saved in this app only. Your YouTube account isn't changed."); }

/** Renders the watch page into `main`; the draft's CSS decides the layout. */
export async function renderWatch(main, id, data) {
  main._off?.abort();
  const off = (main._off = new AbortController());
  main.dataset.watch = id;
  const stale = () => off.signal.aborted || main.dataset.watch !== id;
  const known = data.videos.find((v) => v.id === id);
  main.innerHTML = `<section class="watch"><div class="w-main"><div class="w-player pl sk-player" aria-busy="true">
      ${thumb(id, "hq720", known?.thumbnail, "sk-poster")}
      <div class="sk-scrim"></div>
      <div class="sk-status" role="status"><span class="sk-ring"></span><span class="sk-text">${LOADING_STEPS[0]}</span><span class="sk-bar"></span></div></div>
    <h1 class="w-title">${esc(known?.title ?? "")}</h1></div><aside class="w-side"></aside></section>`;
  // Resolving a video takes a few seconds; say what is happening instead of sitting on one label.
  let step = 0;
  const stepper = setInterval(() => { const t = $(".sk-text", main); if (!t || step >= LOADING_STEPS.length - 1) return clearInterval(stepper); t.textContent = LOADING_STEPS[++step]; }, 1700);
  off.signal.addEventListener("abort", () => clearInterval(stepper));
  let info;
  try {
    const r = await fetch(`/api/info?v=${id}&p=${encodeURIComponent(profiles.current().id)}`);
    info = await r.json();
    if (!r.ok) throw new Error(info.error);
  } catch (e) {
    clearInterval(stepper);
    if (!stale()) $(".w-player", main).innerHTML = `<div class="sk-msg"><p>${esc(e.message)}</p><p><button class="btn btn-s" data-retry>Try again</button> <a class="btn btn-s" href="#/">Back to Home</a></p></div>`;
    $("[data-retry]", main)?.addEventListener("click", () => renderWatch(main, id, data));
    return;
  }
  clearInterval(stepper);
  if (stale()) return;

  const chan = data.channels.get(info.channelId) ?? null;
  const chip = { id, title: info.title, channel: info.channel, duration: info.duration, timestamp: info.timestamp, views: info.views };
  const side = data.videos.filter((v) => v.id !== id).sort((a, b) => (b.channelId === info.channelId) - (a.channelId === info.channelId) || (b.group === known?.group) - (a.group === known?.group) || (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, 10);
  let player = null;
  const ctx = { info, data, get player() { return player; } };
  const panels = extensions.watchPanels(ctx);
  const subscribed = data.subs.some((s) => s.channelId === info.channelId);
  const likes = lib.has("liked", id);
  const shape = info.video.find((f) => f.width && f.height) ?? info.muxed.find((f) => f.width && f.height);
  const portrait = !!shape && shape.height > shape.width;
  main.innerHTML = `<section class="watch ${portrait ? "portrait" : ""}"><div class="w-main">
    <div class="w-player"></div>
    <h1 class="w-title">${esc(info.title)}</h1>
    <div class="w-bar"><div class="w-chan"><a href="${chan ? `#/channel/${chan.id}` : `#/search/${encodeURIComponent(info.channel)}`}">${avatar(chan, info.channel, "av-l")}</a>
      <div><a class="w-cname" href="${chan ? `#/channel/${chan.id}` : "#"}">${esc(info.channel)}${info.verified ? `<span class="ok">${icon("verified", 14)}</span>` : ""}</a><small>${compact(info.subscribers)} subscribers</small></div>
      <button class="btn btn-sub ${subscribed ? "on" : ""}" data-sub>${subscribed ? "Subscribed" : "Subscribe"}</button></div>
      <div class="w-acts"><span class="seg"><button class="${likes ? "on" : ""}" data-like aria-pressed="${likes}">${icon("like", 18)}<span>${compact((info.likes ?? 0) + (likes ? 1 : 0))}</span></button><button data-dislike aria-label="Dislike">${icon("dislike", 18)}</button></span>
        <button class="btn" data-share>${icon("share", 18)} Share</button>
        <button class="btn ${lib.has("later", id) ? "on" : ""}" data-later>${icon("clock", 18)} <span>${lib.has("later", id) ? "Saved" : "Watch later"}</span></button>
        <a class="btn" href="/stream?v=${id}&f=18" download="${esc(info.title)}.mp4" ${info.muxed.some((f) => f.id === "18") ? "" : "hidden"}>${icon("download", 18)} Download</a></div></div>
    <section class="w-desc"><p class="w-stats"><b>${compact(info.views)} views</b> <b>${ago(info.timestamp)}</b></p><div class="w-text clamp">${linkify(info.description || "No description.")}</div><button class="more" data-more>Show more</button></section>
    ${info.chapters.length ? `<section class="w-chap"><h2>Chapters</h2><ol>${info.chapters.map((c) => `<li><button class="ts" data-t="${c.start_time}"><span>${fmtTime(c.start_time)}</span>${esc(c.title)}</button></li>`).join("")}</ol></section>` : ""}
    ${panels.map((p) => `<div class="w-ext" data-ext="${p.id}">${p.html}</div>`).join("")}
    <section class="w-comments"><h2>${compact(info.comments)} comments</h2><div class="cm-list" aria-busy="true">${Array.from({ length: 3 }, () => `<div class="cm"><span class="av sk"></span><div><span class="sk sk-l"></span><span class="sk sk-s"></span></div></div>`).join("")}</div></section>
  </div><aside class="w-side"><h2>From your subscriptions</h2>${side.map((v) => card(v)).join("")}</aside></section>`;

  const watch = $(".watch", main), box = $(".w-player", main);
  const resumeKey = `resume.${id}`;
  const at = Number(store.raw.get(resumeKey)) || 0;
  const { prefs, save } = playerPrefs();
  const captions = captionOptions(info, await extensions.captionRequests(ctx));
  if (stale()) return;
  player = mountPlayer(box, info, {
    prefs, savePrefs: save, autoplay: prefs.autoplay, captions,
    startAt: prefs.resume && at > 5 && at < info.duration - 15 ? at : 0,
    onTime: (t) => store.raw.set(resumeKey, Math.floor(t)), onEnded: () => store.raw.remove(resumeKey),
  });
  setCurrentPlayer(player);
  lib.add("history", chip);
  for (const p of panels) {
    try { p.mount?.($(`[data-ext="${p.id}"]`, main), ctx, extensions.api(p.ext)); } catch (err) { console.error(`Extension ${p.ext.id}:`, err); }
  }
  const onKey = (e) => player.key(e);
  document.addEventListener("keydown", onKey, { signal: off.signal });
  off.signal.addEventListener("abort", () => { player.destroy(); setCurrentPlayer(null); });
  box.addEventListener("player:theatre", () => watch.classList.toggle("theatre"));

  watch.addEventListener("click", (e) => {
    const t = e.target.closest("[data-t]"); if (t) { player.seek(Number(t.dataset.t)); box.scrollIntoView({ block: "nearest", behavior: "smooth" }); box.focus(); return; }
    if (e.target.closest("[data-more]")) { const on = $(".w-text", watch).classList.toggle("clamp"); e.target.textContent = on ? "Show more" : "Show less"; return; }
    const sub = e.target.closest("[data-sub]"); if (sub) { const on = sub.classList.toggle("on"); sub.textContent = on ? "Subscribed" : "Subscribe"; toast(on ? "Subscribed here only. Syncing to YouTube needs sign-in." : "Unsubscribed here only."); return; }
    const like = e.target.closest("[data-like]"); if (like) { if (data.live) savedLocally(); const on = lib.toggle("liked", chip); like.classList.toggle("on", on); like.setAttribute("aria-pressed", on); $("span", like).textContent = compact((info.likes ?? 0) + (on ? 1 : 0)); return; }
    if (e.target.closest("[data-dislike]")) return toast("Dislikes sync to YouTube once you sign in.");
    const later = e.target.closest("[data-later]"); if (later) { if (data.live) savedLocally(); const on = lib.toggle("later", chip); later.classList.toggle("on", on); $("span", later).textContent = on ? "Saved" : "Watch later"; return; }
    if (e.target.closest("[data-share]")) return copyText(`https://youtu.be/${id}`, "Link copied.");
  }, { signal: off.signal });

  const list = $(".cm-list", main);
  new IntersectionObserver(async ([en], io) => {
    if (!en.isIntersecting) return; io.disconnect();
    try { const r = await fetch(`/api/comments?v=${id}`); const j = await r.json(); if (!stale()) { list.innerHTML = r.ok ? commentsHtml(j) : `<p class="muted">${esc(j.error)}</p>`; list.removeAttribute("aria-busy"); } }
    catch { if (!stale()) list.innerHTML = `<p class="muted">Comments didn’t load.</p>`; }
  }, { rootMargin: "300px" }).observe(list);
}
