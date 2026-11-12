import { errorMessage } from "./errors.js";
import type { PageElement, AppData, SettingValue } from "./types.js";
// Settings, Extensions and the account menu.
import { icon } from "../icons.js";
import { esc, $, toast, initial, targetOf } from "./util.js";
import { profiles } from "./storage.js";

const BROWSERS = [["chrome", "Google Chrome"], ["brave", "Brave"], ["edge", "Microsoft Edge"], ["firefox", "Firefox"], ["safari", "Safari"], ["vivaldi", "Vivaldi"], ["opera", "Opera"]];
const browserName = (id?: string) => BROWSERS.find(([k]) => k === id)?.[1] ?? id ?? "Browser";
import { settings } from "./settings.js";
import { extensions } from "./extensions.js";
import { cache } from "./cache.js";
import { lib, popover } from "./common.js";

let uid = 0;
/** A labelled on/off switch. `attrs` replaces data-set for switches that belong to an extension. */
const toggle = (path: string, on: SettingValue | undefined, label: string, hint = "", attrs = `data-set="${path}"`) => { const id = `sw${++uid}`; return `<div class="set-row"><div><label id="${id}">${label}</label>${hint ? `<p>${hint}</p>` : ""}</div><button class="switch" role="switch" aria-checked="${on}" aria-labelledby="${id}" ${attrs} data-type="toggle"><i></i></button></div>`; };
const select = (path: string, value: SettingValue, label: string, options: [SettingValue, string][], hint = "") => `<div class="set-row"><div><label for="s-${path}">${label}</label>${hint ? `<p>${hint}</p>` : ""}</div><select id="s-${path}" data-set="${path}" data-type="${typeof options[0][0]}">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${l}</option>`).join("")}</select></div>`;
const range = (path: string, value: number, label: string, min: number, max: number, step: number, unit = "%") => `<div class="set-row"><div><label for="s-${path}">${label}</label></div><div class="range"><input id="s-${path}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-set="${path}" data-type="number"><output>${value}${unit}</output></div></div>`;
const section = (title: string, body: string) => `<section class="set-sec"><h2>${title}</h2><div class="set-card">${body}</div></section>`;

function wireSettings(root: HTMLElement, onSet: (path: string, value: SettingValue) => void) {
  root.addEventListener("click", (e) => {
    const sw = targetOf(e).closest<HTMLElement>('[data-type="toggle"]'); if (!sw?.dataset.set!) return;
    const on = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(on)); onSet(sw.dataset.set!, on);
  });
  root.addEventListener("input", (e) => {
    const el = targetOf(e).closest<HTMLInputElement | HTMLSelectElement>("select[data-set], input[type=range][data-set]"); if (!el) return;
    if (el.type === "range") el.nextElementSibling!.textContent = `${el.value}%`;
    onSet(el.dataset.set!, el.dataset.type === "number" ? Number(el.value) : el.value);
  });
}

export function renderSettings(main: PageElement) {
  const s = settings.get();
  const quality: [SettingValue, string][] = [[2160, "4K (2160p)"], [1440, "1440p"], [1080, "1080p"], [720, "720p"], [480, "480p"], [360, "360p"]];
  const rates: [SettingValue, string][] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => [r, r === 1 ? "Normal" : `${r}×`]);
  main.innerHTML = `<section class="page settings"><h1 class="ph">Settings</h1>
    ${section("Appearance", select("theme", s.theme, "Theme", [["dark", "Dark"], ["light", "Light"], ["system", "Match this device"]]))}
    ${section("Playback",
      toggle("playback.autoplay", s.playback.autoplay, "Start playing when a video opens")
      + toggle("playback.resume", s.playback.resume, "Resume where you left off", "Videos you stopped partway reopen at that point.")
      + select("playback.maxQuality", s.playback.maxQuality, "Highest quality", quality, "Used when the video has it and this browser can decode it. Choosing a quality in the player updates this.")
      + select("playback.rate", s.playback.rate, "Default speed", rates))}
    ${section("Captions",
      select("captions.show", s.captions.show, "Show captions", [["off", "Only when I turn them on"], ["on", "On by default"]], "Press C in the player to toggle them.")
      + select("captions.language", s.captions.language, "Language", [["original", "The language spoken"], ["en", "English when available"]], "English uses an uploaded English track, or an AI translation if the AI captions extension is on.")
      + range("captions.size", s.captions.size, "Text size", 70, 200, 10)
      + range("captions.background", s.captions.background, "Background darkness", 0, 100, 10)
      + `<p class="set-note">${icon("puzzle", 16)} Captions for videos that have none come from the <a href="#/extensions">AI captions extension</a>.</p>`)}
    ${section("YouTube account", `<div id="yt"></div>`)}
    ${section("Profiles", `<div id="acct"></div>`)}
    ${section("Data on this device", `
      <div class="set-row"><div><label>Watch history</label><p>${lib.list("history").length} videos</p></div><button class="btn" data-clear="history">Clear</button></div>
      <div class="set-row"><div><label>Watch later and likes</label><p>${lib.list("later").length} saved, ${lib.list("liked").length} liked</p></div><button class="btn" data-clear="saved">Clear</button></div>
      <div class="set-row"><div><label>AI caption cache</label><p>Transcripts made on this Mac, for every profile. They're regenerated when needed.</p></div><button class="btn" data-clear="captions">Clear</button></div>
      <div class="set-row"><div><label>Reset settings</label><p>Puts every setting on this page back to its default. Extensions stay as they are.</p></div><button class="btn" data-clear="settings">Reset</button></div>`)}
  </section>`;
  const root = main.firstElementChild as HTMLElement;
  wireSettings(root, (path, value) => settings.set(path, value));
  drawAccounts();
  drawYouTube(root);
  root.addEventListener("click", async (e) => {
    const c = targetOf(e).closest<HTMLElement>("[data-clear]")?.dataset.clear; if (!c) return;
    if (c === "history") lib.clear("history");
    else if (c === "saved") { lib.clear("later"); lib.clear("liked"); }
    else if (c === "captions") await fetch("/api/ai-captions/clear", { method: "POST" });
    else if (c === "settings") settings.reset();
    toast(c === "settings" ? "Settings reset." : "Cleared.");
    renderSettings(main);
  });

  function drawAccounts() {
    const cur = profiles.current(), list = profiles.list();
    $("#acct", root).innerHTML = `${list.map((p) => `<div class="set-row acct-row"><span class="me" style="background:${p.color}">${esc(initial(p.name))}</span>
      <input class="acct-name" value="${esc(p.name)}" data-rename="${p.id}" aria-label="Profile name" maxlength="40">
      ${p.id === cur.id ? `<span class="badge">In use</span>` : `<button class="btn btn-s" data-use="${p.id}">Switch</button>`}
      <button class="btn btn-s" data-del="${p.id}" ${list.length < 2 ? "disabled" : ""}>Remove</button></div>`).join("")}
      <div class="set-row"><div><label>Add a profile</label><p>Profiles keep their own history, saved videos, pins, settings and extensions. They share the subscriptions list until a YouTube account is connected.</p></div><button class="btn" data-addp>${icon("plus", 16)} Add</button></div>`;
  }
  root.addEventListener("change", (e) => { const r = targetOf(e).closest<HTMLInputElement>("[data-rename]"); if (r) { profiles.rename(r.dataset.rename!, r.value); drawAccounts(); document.dispatchEvent(new CustomEvent("profiles:change")); } });
  root.addEventListener("click", (e) => {
    const use = targetOf(e).closest<HTMLElement>("[data-use]"); if (use) { profiles.switchTo(use.dataset.use!); location.reload(); return; }
    const del = targetOf(e).closest<HTMLElement>("[data-del]");
    if (del && confirm("Remove this profile and everything saved in it?")) { const wasCurrent = del.dataset.del === profiles.current().id; const gone = del.dataset.del!; Promise.all([cache.clear(`acct:${gone}`), cache.clear(`lib:${gone}:`)]); profiles.remove(gone); wasCurrent ? location.reload() : drawAccounts(); return; }
    if (targetOf(e).closest<HTMLElement>("[data-addp]")) addProfileDialog();
  });
}

/** Sign out: deletes the saved login and this device's saved copy of the lists. Nothing happens on youtube.com. */
export async function signOutYouTube() {
  if (!confirm("Sign out of YouTube here?\n\nThe saved login is deleted from this Mac and this profile goes back to sample data. You stay signed in on youtube.com in your browser.")) return;
  const pid = profiles.current().id;
  await fetch(`/api/account/disconnect?p=${encodeURIComponent(pid)}`, { method: "POST" });
  await Promise.all([cache.clear(`acct:${pid}`), cache.clear(`lib:${pid}:`), cache.clear(`shorts:${pid}`)]);
  location.hash = "#/"; location.reload();
}

/** Connect, reconnect and disconnect the current profile's YouTube account. */
async function drawYouTube(root: HTMLElement) {
  const el = $("#yt", root), pid = profiles.current().id;
  el.innerHTML = `<div class="set-row"><p>Checking…</p></div>`;
  const st = await fetch(`/api/account?p=${encodeURIComponent(pid)}`).then((r) => r.json()).catch(() => ({ connected: false }));
  const since = st.since ? new Date(st.since * 1000).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : "";
  el.innerHTML = st.connected
    ? `<div class="set-row"><div class="acct-status"><label>${st.needsReconnect ? "YouTube no longer accepts the saved login" : "Connected"}</label>
        <p>Through ${esc(browserName(st.browser))}${since ? `, since ${since}` : ""}. Your subscriptions, recommendations, history, Watch later and Liked videos come from YouTube. Likes and saves you make in this app stay in this app.</p></div>
        <div class="acct-btns">${st.needsReconnect ? `<button class="btn btn-pri" data-yt-connect="${esc(st.browser)}">Reconnect</button>` : ""}<button class="btn" data-yt-disconnect>Sign out</button></div></div>
      <p class="connect-note">${icon("help", 16)} The login is kept in a file only your user can read, in this project's data/accounts folder. Signing out deletes it. You stay signed in on youtube.com.</p><p class="connect-err" role="alert" hidden></p>`
    : `<div class="set-row"><div><label for="yt-browser">Connect your YouTube account</label><p>Copies your YouTube login from a browser where you're already signed in, so this app can show your real subscriptions and lists. Only YouTube and Google cookies are copied.</p></div>
        <div class="acct-btns"><select id="yt-browser" aria-label="Browser">${BROWSERS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select><button class="btn btn-pri" data-yt-connect>Connect</button></div></div>
      <p class="connect-note">${icon("help", 16)} This uses your browser's own login session, which goes against YouTube's terms, and YouTube can restrict accounts that are used with tools like this. Videos play without your login unless one needs it (age-restricted, members-only). macOS may ask to use the Keychain: choose Allow. Arc isn't supported.</p><p class="connect-err" role="alert" hidden></p>`;
  const fail = (m: string) => { const e = $(".connect-err", el); e.textContent = m; e.hidden = false; };
  el.onclick = async (e) => {
    const connect = targetOf(e).closest<HTMLButtonElement>("[data-yt-connect]"), disconnect = targetOf(e).closest<HTMLElement>("[data-yt-disconnect]");
    if (connect) {
      const browser = connect.dataset.ytConnect || $("#yt-browser", el).value;
      connect.disabled = true; connect.textContent = "Waiting for the browser…"; $(".connect-err", el).hidden = true;
      try {
        const r = await fetch(`/api/account/connect?p=${encodeURIComponent(pid)}&browser=${encodeURIComponent(browser)}`, { method: "POST" }), j = await r.json();
        if (!r.ok) throw new Error(j.error);
        location.hash = "#/"; location.reload();
      } catch (err) { connect.disabled = false; connect.textContent = connect.dataset.ytConnect ? "Reconnect" : "Connect"; fail(errorMessage(err)); }
    }
    if (disconnect) await signOutYouTube();
  };
}

export function addProfileDialog() {
  document.querySelector("dialog.addp")?.remove();
  const d = Object.assign(document.createElement("dialog"), { className: "addp" });
  d.innerHTML = `<form method="dialog"><h2>Add a profile</h2><label for="pn">Name</label><input id="pn" name="name" maxlength="40" placeholder="e.g. Work" autocomplete="off" required pattern=".*\\S.*" title="Enter a name">
    <fieldset><legend>Colour</legend>${profiles.colors.map((c, i) => `<label class="sw" style="--c:${c}"><input type="radio" name="color" value="${c}" ${i === 0 ? "checked" : ""}><span></span></label>`).join("")}</fieldset>
    <div class="dlg-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn btn-pri" value="ok">Add and switch</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", () => {
    const f = new FormData(d.querySelector("form")!);
    if (d.returnValue === "ok" && String(f.get("name")).trim()) { profiles.add(String(f.get("name")), String(f.get("color"))); location.reload(); } else d.remove();
  });
  d.showModal(); $("#pn", d).focus();
}

export function accountMenu(anchor: HTMLElement, data: AppData) {
  const cur = profiles.current();
  const pop = popover(anchor, `<div class="acct-head"><span class="me big" style="background:${cur.color}">${esc(initial(cur.name))}</span><div><b>${esc(cur.name)}</b><small>${data?.account?.connected ? "YouTube account connected" : "Local profile"}</small></div></div>
    <h3>Switch account</h3>${profiles.list().map((p) => `<button class="menuitem" data-use="${p.id}"><span class="me sm" style="background:${p.color}">${esc(initial(p.name))}</span><span class="grow">${esc(p.name)}</span>${p.id === cur.id ? icon("check", 18) : ""}</button>`).join("")}
    <button class="menuitem" data-addp>${icon("plus", 18)} Add account</button><hr>
    <a class="menuitem" href="#/settings">${icon("settings", 18)} Settings</a><a class="menuitem" href="#/extensions">${icon("puzzle", 18)} Extensions</a>
    ${data?.account?.connected
      ? `<a class="menuitem" href="#/settings">${icon("user", 18)} YouTube account: connected</a><button class="menuitem" data-signout>${icon("x", 18)} Sign out of YouTube</button>`
      : `<a class="menuitem" href="#/settings">${icon("user", 18)} Connect a YouTube account</a>`}`, "acct-pop");
  if (!pop) return;
  pop.addEventListener("click", (e) => {
    const use = targetOf(e).closest<HTMLElement>("[data-use]"); if (use && use.dataset.use !== cur.id) { profiles.switchTo(use.dataset.use!); location.reload(); }
    if (targetOf(e).closest<HTMLElement>("[data-addp]")) { pop.remove(); addProfileDialog(); }
    if (targetOf(e).closest<HTMLElement>("[data-signout]")) { pop.remove(); signOutYouTube(); }
  });
}

export function renderExtensions(main: PageElement) {
  main.innerHTML = "<div></div>";
  const root = main.firstElementChild as HTMLElement;
  const draw = () => {
    const keep = $(".ext-form input", root), typed = keep?.value ?? "", hadFocus = !!keep && document.activeElement === keep;
    const list = extensions.all(), errs = extensions.errors();
    root.innerHTML = `<section class="page settings"><h1 class="ph">Extensions</h1>
      <p class="lede">Extensions add features on top of YouTube. They are all off until you turn them on, and each profile keeps its own choices.</p>
      <div class="ext-list">${list.map((e) => {
        const on = !e.broken && extensions.isEnabled(e.id);
        return `<article class="ext ${on ? "on" : ""} ${e.broken ? "broken" : ""}" data-ext="${esc(e.id)}"><span class="ext-ic">${icon(e.broken ? "help" : e.icon ?? "puzzle", 22)}</span>
          <div class="ext-body"><h2>${esc(e.name)} <small>${esc(e.version ?? "")}${e.author ? ` · ${esc(e.author)}` : ""}</small></h2><p>${esc(e.description ?? "")}</p>
            ${e.permissions?.length ? `<ul class="perm">${e.permissions.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
            ${errs.get(e.id) ? `<p class="err">${esc(errs.get(e.id))}</p>` : ""}
            ${on && e.settings?.length ? `<div class="ext-set">${e.settings.map((f) => toggle("", extensions.getSetting(e, f.key), esc(f.label), "", `data-ext-id="${esc(e.id)}" data-ext-key="${esc(f.key)}"`)).join("")}</div>` : ""}</div>
          <div class="ext-act">${e.broken ? "" : `<button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(e.name)}" data-toggle="${esc(e.id)}"><i></i></button>`}${e.builtin ? "" : `<button class="btn btn-s" data-remove="${esc(e.id)}">Remove</button>`}</div></article>`;
      }).join("")}</div>
      <section class="ext-add"><h2>Add an extension</h2><p>Paste the address of an extension module. An example is included: <button class="linkish" data-example>/extensions/examples/watch-notes.js</button></p>
        <form class="ext-form"><input name="url" type="text" inputmode="url" required placeholder="https://… or /extensions/…" aria-label="Extension address"><button class="btn btn-pri">Add</button></form>
        <p class="warn">${icon("help", 16)} An extension is code that runs inside this app with full access to everything in it, including this profile's saved data. Only add ones you trust. New extensions start off.</p></section></section>`;
    const input = $(".ext-form input", root);   // a re-render (from toggling something) must not eat what was typed
    input.value = typed;
    if (hadFocus) input.focus();
  };
  draw();
  root.addEventListener("click", (e) => {
    const t = targetOf(e).closest<HTMLElement>("[data-toggle]");
    if (t) { extensions.setEnabled(t.dataset.toggle!, t.getAttribute("aria-checked") !== "true"); return; }
    const r = targetOf(e).closest<HTMLElement>("[data-remove]");
    if (r && confirm("Remove this extension and the data it saved?")) extensions.remove(r.dataset.remove!);
    if (targetOf(e).closest<HTMLElement>("[data-example]")) $(".ext-form input", root).value = "/extensions/examples/watch-notes.js";
    const sw = targetOf(e).closest<HTMLElement>("[data-ext-id]");
    if (sw) {
      const ext = extensions.all().find((x) => x.id === sw.dataset.extId);
      if (ext) extensions.setSetting(ext, sw.dataset.extKey!, sw.getAttribute("aria-checked") !== "true");
    }
  });
  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { const ext = await extensions.add(new FormData(targetOf<HTMLFormElement>(e)).get("url")); toast(`Added “${ext.name}”. It's off until you turn it on.`); $(".ext-form input", root).value = ""; }
    catch (err) { toast(errorMessage(err)); }
  });
  return extensions.onChange(draw);
}
