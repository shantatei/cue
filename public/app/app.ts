import { errorMessage } from "./errors.js";
import type { Subscription, Video } from "./types.js";
import * as C from "./common.js";
import { buildTopics, matchesTopic } from "./topics.js";
import { createHomeFeed } from "./home-feed.js";
import { mountSearch } from "./search.js";
import { extensions } from "./extensions.js";
import { profiles, store, is } from "./storage.js";
import { renderSettings, renderExtensions, accountMenu } from "./pages.js";
const { icon, esc, $, $$, card, avatar, chanHref } = C;
import { targetOf } from "./util.js";
const { initial } = await import("./util.js");
const data = await C.loadData();
const app = $("#app");
const pins = new Set<string>(store.get<string[]>("pins", [], is.strings));
const closedGroups = new Set<string>(store.get<string[]>("closedGroups", [], is.strings));
const savePins = () => store.set("pins", [...pins]);

const NAV = [["", "home", "Home"], ["shorts", "shorts", "Shorts"], ["subs", "subs", "Subscriptions"]];
const YOU = [["channel", "user", "Your channel"], ["history", "history", "History"], ["playlists", "playlist", "Playlists"], ["later", "clock", "Watch later"], ["liked", "like", "Liked videos"], ["mine", "video", "Your videos"], ["downloads", "download", "Downloads"]];

app.innerHTML = `
<header class="top">
  <button class="ic" data-mini aria-label="Collapse sidebar">${icon("menu", 22)}</button>
  <a class="logo" href="#/" aria-label="Cue home"><svg viewBox="0 0 152 64" aria-hidden="true" focusable="false"><use href="/brand/cue-mark.svg#cue-mark"/><text x="61" y="54" fill="currentColor" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="76" letter-spacing="-5">ue</text></svg></a>
  <div class="search-wrap"><form class="search" role="search"><input name="q" placeholder="Search" aria-label="Search" autocomplete="off"><button aria-label="Search">${icon("search", 20)}</button></form></div>
  <div class="top-r">
    <span class="ext-bar"></span>
    <button class="btn" data-create>${icon("plus", 18)} Create</button>
    <button class="ic" data-bell aria-label="Notifications">${icon("bell", 22)}<i class="dot"></i></button>
    <button class="me" data-me aria-label="Account menu"></button>
  </div>
</header>
<nav class="rail" aria-label="Sidebar">
  ${NAV.map(([h, i, l]) => `<a class="navi" data-nav="${h}" href="#/${h}">${icon(i, 22)}<span>${l}</span></a>`).join("")}
  <section class="subs" aria-label="Subscriptions">
    <div class="subs-h"><h2>Subscriptions</h2><a href="#/manage">Manage</a></div>
    <label class="subs-q">${icon("search", 16)}<input placeholder="Filter channels" aria-label="Filter channels" autocomplete="off"><kbd>/</kbd></label>
    <div class="subs-list"></div>
  </section>
  <section class="you"><h2>You ${icon("right", 16)}</h2><div class="you-g">${YOU.map(([h, i, l]) => `<a class="navi" data-nav="you:${h}" href="#/you/${h}">${icon(i, 18)}<span>${l}</span></a>`).join("")}</div>
    <div class="you-g foot"><a class="navi" data-nav="settings" href="#/settings">${icon("settings", 18)}<span>Settings</span></a><a class="navi" data-nav="extensions" href="#/extensions">${icon("puzzle", 18)}<span>Extensions</span></a></div></section>
</nav>
<main class="main" id="main"></main>`;
const main = $("#main"), q = $(".subs-q input"), list = $(".subs-list");
function setBanner(html: string) {
  $(".banner")?.remove();
  if (!html) return;
  $(".top").after(Object.assign(document.createElement("div"), { className: "banner", role: "status", innerHTML: html }));
}
if (data.account?.needsReconnect || data.account?.error) {
  setBanner(data.account.needsReconnect
    ? `YouTube no longer accepts the saved login, so you're seeing sample data. <a href="#/settings">Reconnect in Settings</a>`
    : `Couldn't read your YouTube account (${esc(data.account.error)}), so you're seeing sample data. <a href="#/settings">Check Settings</a>`);
}

function drawSubs() {
  const term = q.value.trim().toLowerCase();
  const match = (s: Subscription) => !term || s.name.toLowerCase().includes(term);
  const row = (s: Subscription) => `<div class="sub"><a class="sub-link" href="${chanHref(s)}">${avatar(s.ch, s.name)}<span>${esc(s.name)}</span>${s.fresh ? `<i class="dot" title="New upload"></i>` : ""}</a><button class="pin ${pins.has(s.name) ? "on" : ""}" data-pin="${esc(s.name)}" aria-label="${pins.has(s.name) ? "Unpin" : "Pin"} ${esc(s.name)}" aria-pressed="${pins.has(s.name)}">${icon("pin", 14)}</button></div>`;
  const section = (key: string, label: string, subs: Subscription[]) => subs.length ? `<details class="grp" ${closedGroups.has(key) && !term ? "" : "open"} data-g="${key}"><summary>${label} <b>${subs.length}</b>${icon("down", 14)}</summary>${subs.map(row).join("")}</details>` : "";
  const shown = data.subs.filter(match);
  const fresh = (a: Subscription, b: Subscription) => Number(b.fresh) - Number(a.fresh);
  list.innerHTML = section("pins", "Pinned", shown.filter((s) => pins.has(s.name)))
    + data.groups.map((g) => section(g.id, g.name, shown.filter((s) => s.group.id === g.id && !pins.has(s.name)).sort(fresh))).join("")
    || `<p class="none">No channel matches “${esc(q.value)}”.</p>`;
}
drawSubs();
q.addEventListener("input", drawSubs);
q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; drawSubs(); q.blur(); } });
// A group's collapsed state is remembered, so filtering or pinning doesn't re-open it.
list.addEventListener("toggle", (e) => {
  const g = targetOf(e).closest<HTMLDetailsElement>("details.grp"); if (!g || q.value.trim()) return;
  g.open ? closedGroups.delete(g.dataset.g!) : closedGroups.add(g.dataset.g!);
  store.set("closedGroups", [...closedGroups]);
}, true);
list.addEventListener("click", (e) => {
  const pin = targetOf(e).closest<HTMLElement>("[data-pin]"); if (!pin) return;
  e.preventDefault(); const n = pin.dataset.pin!; pins.has(n) ? pins.delete(n) : pins.add(n); savePins();
  const top = list.scrollTop; drawSubs(); list.scrollTop = top;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/INPUT|TEXTAREA/.test(targetOf(e).tagName) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); q.focus(); }
});

$("[data-mini]").onclick = () => app.classList.toggle("mini");
mountSearch($(".search"), { icon, onSearch: (query) => { location.hash = `#/search/${encodeURIComponent(query)}`; } });
$("[data-create]").onclick = (e) => C.popover((e.currentTarget as HTMLElement), C.createHtml());
$("[data-bell]").onclick = (e) => { (e.currentTarget as HTMLElement).querySelector(".dot")?.remove(); C.popover((e.currentTarget as HTMLElement), C.bellHtml(data)); };
const drawAvatar = () => { const me = $("[data-me]"), p = profiles.current(); me.style.background = p.color; me.textContent = initial(p.name); };
drawAvatar();
document.addEventListener("profiles:change", drawAvatar);
$("[data-me]").onclick = (e) => accountMenu((e.currentTarget as HTMLElement), data);

/* Extensions can add buttons to the top bar. */
function drawExtBar() {
  const items = extensions.topbarItems();
  $(".ext-bar").innerHTML = items.map((it, i) => `<button class="btn" data-ext-btn="${i}" title="${esc(it.title ?? it.label)}">${icon(it.icon ?? "puzzle", 18)} ${esc(it.label)}</button>`).join("");
  $$("[data-ext-btn]").forEach((b) => b.onclick = () => items[Number(b.dataset.extBtn)].onClick?.(extensions.api(items[Number(b.dataset.extBtn)].ext)));
}
drawExtBar();
extensions.onChange(() => { drawExtBar(); if (C.parseRoute().page === "watch") route(); });

let filter = "all";
const homeFeed = createHomeFeed(async (cursor) => {
  const params = new URLSearchParams({ p: profiles.current().id, cursor });
  const response = await fetch(`/api/account/recommendations?${params}`);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? "Couldn't load recommendations."), { status: response.status });
  return result;
});
function home() {
  main._cleanup?.();
  homeFeed.merge(data.live && data.home?.length ? data.home : data.videos);
  const source = homeFeed.videos;
  const allTopics = buildTopics(source, Infinity);
  const topics = allTopics.slice(0, 12);
  const selected = allTopics.find((t) => t.id === filter);
  if (selected && !topics.includes(selected)) topics.push(selected);
  if (!C.FILTERS.some(([id]) => id === filter) && !topics.some((t) => t.id === filter)) filter = "all";
  const test = C.FILTERS.find((f) => f[0] === filter)?.[2] ?? (() => true);
  const activeFilter = filter;
  const matches: (v: Video) => boolean = filter.startsWith("topic:") || filter.startsWith("hashtag:") ? (v) => matchesTopic(v, activeFilter) : test;
  const vids = source.filter(matches);
  main.innerHTML = `<div class="chips" role="toolbar" aria-label="Filters">${C.FILTERS.map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join("")}${topics.length ? `<span class="chip-sep" aria-hidden="true"></span>` : ""}${topics.map((t) => `<button class="chip" data-f="${esc(t.id)}" aria-pressed="${filter === t.id}" title="${t.videoIds.size} videos · Based on available video information">${esc(t.label)}</button>`).join("")}</div>
    <div class="feed"><div class="grid">${vids.map((v) => card(v)).join("")}</div>${!vids.length ? C.empty("Nothing matches yet", data.live ? "Load more recommendations or try another filter." : "Try another filter.") : ""}${data.live ? `<div class="home-more" data-home-more></div>` : ""}</div>`;
  $(".chips", main).onclick = (e) => {
    const b = targetOf(e).closest<HTMLElement>("[data-f]"); if (!b) return;
    const left = $(".chips", main).scrollLeft;
    filter = b.dataset.f!; main.scrollTop = 0; home();
    const chips = $(".chips", main); chips.scrollLeft = left;
    [...chips.querySelectorAll<HTMLElement>("[data-f]")].find((button) => button.dataset.f === filter)?.focus({ preventScroll: true });
  };
  if (!data.live) return;
  const tail = $("[data-home-more]", main), grid = $(".grid", main);
  const shown = new Set<string>(vids.map((v) => v.id));
  let alive = true, observer: IntersectionObserver | undefined, loading = false, error = "";
  const drawTail = () => {
    tail.innerHTML = homeFeed.ended
      ? `<p role="status">You’re caught up with the recommendations YouTube sent.</p>`
      : `<p role="status">${esc(error || (loading ? "Loading more recommendations…" : ""))}</p><button class="btn" data-load-home ${loading ? "disabled" : ""}>${error ? "Try again" : "Load more videos"}</button>`;
  };
  const load = async () => {
    if (!alive || loading || homeFeed.ended) return;
    loading = true; error = ""; drawTail();
    let added = 0;
    try {
      await homeFeed.loadMore(matches);
    } catch (e) { error = errorMessage(e); }
    finally {
      loading = false;
      if (alive) {
        // Keep any successful pages even if a later page in this scan failed.
        const fresh = homeFeed.videos.filter((v) => !shown.has(v.id) && matches(v));
        for (const v of fresh) shown.add(v.id);
        added = fresh.length;
        grid.insertAdjacentHTML("beforeend", fresh.map((v) => card(v)).join(""));
        if (added) $(".empty", main)?.remove();
        else if (homeFeed.ended && $(".empty p", main)) $(".empty p", main).textContent = "Try another filter.";
        drawTail();
        if (added && !error && !homeFeed.ended) { observer?.unobserve(tail); observer?.observe(tail); }
      }
    }
  };
  tail.onclick = (event) => { if (targetOf(event).closest<HTMLElement>("[data-load-home]")) load(); };
  drawTail();
  observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) load(); }, { root: main, rootMargin: "600px" });
  observer.observe(tail);
  main._cleanup = () => { alive = false; observer.disconnect(); };
}

function subsFeed() {
  const days = Map.groupBy(data.videos, (v) => (v.live ? "Live now" : v.timestamp ? C.dayLabel(v.timestamp) : "Earlier"));
  main.innerHTML = `<div class="feed">${[...days].map(([d, vids]) => `<header class="day"><h2>${d}</h2><small>${vids.length} ${d === "Live now" ? "streaming" : "new"}</small></header><div class="grid">${vids.map((v) => card(v)).join("")}</div>`).join("")}</div>`;
}

let route: (value?: ReturnType<typeof C.parseRoute>) => void;
C.startRouter(route = ({ page, arg } = C.parseRoute()) => {
  main._off?.abort(); main._cleanup?.(); main._cleanup = null; delete main.dataset.watch; delete main.dataset.token; delete main.dataset.lib; delete main.dataset.chan; delete main.dataset.shorts;
  C.closePopovers();
  const [p, a] = page === "you" ? ["lib", arg] : [page, arg];
  $$(".navi", app).forEach((n) => n.classList.toggle("on", n.dataset.nav === (p === "lib" ? `you:${a}` : p)));
  main.scrollTop = 0;
  ({ "": home, subs: subsFeed, shorts: () => C.renderShorts(main, data), manage: () => C.renderManage(main, data), watch: () => C.renderWatch(main, a, data),
    search: () => C.renderSearch(main, a, data), channel: () => C.renderChannel(main, a, data), lib: () => C.renderLib(main, a, data),
    settings: () => renderSettings(main), extensions: () => { main._cleanup = renderExtensions(main); } }[p] ?? home)();
});

/* Signed in: the lists above came from this device's saved copy. Bring them up to date in the
   background, and keep doing so while the tab is open. A feed the person is reading is never swapped
   out from under them; a small button offers the new version instead. */
if (data.live) {
  const showPill = () => {
    if ($(".refresh-pill")) return;
    const b = Object.assign(document.createElement("button"), { className: "refresh-pill", textContent: "New videos. Show them" });
    b.onclick = () => { b.remove(); route(); };
    app.append(b);
  };
  data.onUpdate?.((kind, err) => {
    if (kind === "error") { if (/no longer accepts|Reconnect/.test(err?.message ?? "Unknown account error")) setBanner(`${esc(err?.message ?? "Unknown account error")} <a href="#/settings">Open Settings</a>`); return; }
    drawSubs();
    if (!["", "subs", "manage"].includes(C.parseRoute().page)) return;
    main.scrollTop < 40 ? route() : showPill();
  });
  data.refresh?.();
  setInterval(() => { if (!document.hidden) data.refresh?.(); }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && (data.staleFor?.() ?? Infinity) > 2 * 60 * 1000) data.refresh?.(); });
  addEventListener("hashchange", () => $(".refresh-pill")?.remove());
}
