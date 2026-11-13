import type { PageElement, PlayerAPI, Video, VideoComment, VideoInfo } from "./types.js";
import { mountPlayer } from "../player.js";
import { icon } from "../icons.js";
import { esc, compact, $, $$, toast, copyText, targetOf } from "./util.js";
import { errorMessage } from "./errors.js";
import { thumb } from "./thumbnails.js";
import { playerPrefs } from "./settings.js";

/** The pieces of the app a Shorts feed needs but does not own. */
export interface ReelDeps {
  profile: string;
  isSaved: (list: "liked" | "later", id: string) => boolean;
  toggleSaved: (list: "liked" | "later", video: Video) => boolean;
  openChannel: (video: Video) => string;
  commentsHtml: (list: VideoComment[]) => string;
}

/**
 * Vertical, full-height Shorts feed. Each short is one snap-scroll page; the one in view plays and
 * loops, the rest hold a poster. Only one player exists at a time, so a long feed costs nothing.
 * Arrow keys, j/k and the on-screen arrows move between shorts; Space or a tap pauses.
 */
export function mountReels(main: PageElement, list: Video[], startId: string, deps: ReelDeps) {
  const videos = list.filter((v, i, all) => v.id && all.findIndex((x) => x.id === v.id) === i);
  if (startId && !videos.some((v) => v.id === startId)) videos.unshift({ id: startId, title: "" } as Video);
  const off = new AbortController();
  const prevCleanup = main._cleanup;
  main._cleanup = () => { off.abort(); stopPlayer(); prevCleanup?.(); };

  main.innerHTML = `<div class="reels-wrap"><section class="reels" tabindex="-1" aria-label="Shorts">
    ${videos.map((v) => `<article class="reel" data-id="${esc(v.id)}">
      <div class="reel-stage">
        ${thumb(v.id, "hq720", v.thumbnail, "reel-poster")}
        <div class="reel-player"></div>
        <div class="reel-shade"></div>
        <div class="reel-meta">
          <a class="reel-chan" href="${esc(deps.openChannel(v))}">${esc(v.channel ?? "")}</a>
          <p class="reel-title">${esc(v.title)}</p>
        </div>
        <div class="reel-status" role="status"></div>
      </div>
      <div class="reel-rail">
        <button type="button" data-act="comments" aria-label="Comments (c)" aria-expanded="false"><span class="rb">${icon("comment", 22)}</span><small data-count>Comments</small></button>
        <button type="button" data-act="like" aria-pressed="${deps.isSaved("liked", v.id)}" aria-label="Like"><span class="rb">${icon("like", 22)}</span><small>Like</small></button>
        <button type="button" data-act="later" aria-pressed="${deps.isSaved("later", v.id)}" aria-label="Watch later"><span class="rb">${icon("clock", 22)}</span><small>Save</small></button>
        <button type="button" data-act="share" aria-label="Share"><span class="rb">${icon("share", 22)}</span><small>Share</small></button>
        <button type="button" data-act="mute" aria-label="Mute (m)"><span class="rb">${icon("volume", 22)}</span><small>Sound</small></button>
      </div>
    </article>`).join("")}
    <nav class="reel-nav" aria-label="Move between Shorts">
      <button type="button" data-step="-1" aria-label="Previous short">${icon("up", 22)}</button>
      <button type="button" data-step="1" aria-label="Next short">${icon("down", 22)}</button>
    </nav></section>
    <aside class="reel-comments" aria-label="Comments" hidden>
      <header><h2>Comments</h2><button type="button" data-close aria-label="Close comments">${icon("x", 20)}</button></header>
      <div class="cm-list" tabindex="0"></div>
    </aside></div>`;

  const feed = $(".reels", main), slides = $$(".reel", feed);
  const panel = $(".reel-comments", main), cmList = $(".cm-list", panel), cmTitle = $("h2", panel);
  let player: PlayerAPI | null = null, active = -1, token = 0, ctoken = 0;
  const counts = new Map<string, number | null>();

  const setCount = (id: string) => {
    const n = counts.get(id), label = n != null ? compact(n) : "Comments";
    const b = slides.find((s) => s.dataset.id === id);
    if (b) $("[data-count]", b).textContent = label;
    if (videos[active]?.id === id) cmTitle.textContent = n != null ? `${compact(n)} comments` : "Comments";
  };
  /** Comments for the short in view; a fast scroll never lets an older answer land on a newer short. */
  async function loadComments(id: string) {
    const mine = ++ctoken;
    cmList.scrollTop = 0; cmList.setAttribute("aria-busy", "true");
    cmList.innerHTML = Array.from({ length: 4 }, () => `<div class="cm"><span class="av sk"></span><div><span class="sk sk-l"></span><span class="sk sk-s"></span></div></div>`).join("");
    try {
      const r = await fetch(`/api/comments?v=${id}`), j = await r.json();
      if (mine !== ctoken) return;
      cmList.innerHTML = r.ok ? deps.commentsHtml(j) : `<p class="muted">${esc(j.error)}</p>`;
    } catch { if (mine === ctoken) cmList.innerHTML = `<p class="muted">Comments didn’t load.</p>`; }
    if (mine === ctoken) cmList.removeAttribute("aria-busy");
  }
  function toggleComments(open: boolean = !!panel.hidden) {
    panel.hidden = !open;
    feed.parentElement?.classList.toggle("with-comments", open);
    $$('[data-act="comments"]', feed).forEach((b) => b.setAttribute("aria-expanded", String(open)));
    if (open && videos[active]) { setCount(videos[active].id); void loadComments(videos[active].id); }
    else { ctoken++; }
    // The stage changes width; keep the current short snapped in place.
    slides[active]?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  /** Tear the playing short down and put its poster back, so scrolling away never leaves a frozen video behind. */
  function stopPlayer() {
    player?.destroy(); player = null;
    for (const box of $$(".reel-player", feed)) { box.innerHTML = ""; box.classList.remove("pl"); }
  }

  async function activate(i: number) {
    if (i === active || i < 0 || i >= slides.length) return;
    active = i;
    const mine = ++token, slide = slides[i], id = slide.dataset.id ?? "";
    stopPlayer();
    slides.forEach((s, n) => s.classList.toggle("on", n === i));
    history.replaceState(null, "", `#/shorts/${id}`);
    if (!panel.hidden) { setCount(id); void loadComments(id); }
    const box = $(".reel-player", slide), status = $(".reel-status", slide);
    status.className = "reel-status busy"; status.innerHTML = `<span class="reel-ring" aria-hidden="true"></span><span class="sr-only">Loading short</span>`; status.hidden = false;
    try {
      const r = await fetch(`/api/info?v=${id}&p=${encodeURIComponent(deps.profile)}`);
      const info: VideoInfo & { error?: string } = await r.json();
      if (!r.ok) throw new Error(info.error ?? "Could not load this short");
      if (mine !== token || off.signal.aborted) return;
      const meta = videos[i];
      counts.set(id, info.comments ?? null); setCount(id);
      if (!meta.title) { $(".reel-title", slide).textContent = info.title; $(".reel-chan", slide).textContent = info.channel; Object.assign(meta, { title: info.title, channel: info.channel, channelId: info.channelId }); }
      const { prefs, save } = playerPrefs();
      status.hidden = true;
      const p: PlayerAPI = mountPlayer(box, info, { profile: deps.profile, prefs, savePrefs: save, autoplay: true });
      player = p;
      // Shorts loop: restart the picture (and its separate audio track) when it ends.
      const video = $("video", box);
      video.addEventListener("ended", () => { p.seek(0); void video.play().catch(() => {}); });
    } catch (e) {
      if (mine === token) { status.className = "reel-status"; status.hidden = false; status.textContent = errorMessage(e); }
    }
  }

  const go = (step: number) => {
    const next = Math.min(slides.length - 1, Math.max(0, (active < 0 ? 0 : active) + step));
    slides[next]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  // The slide that fills most of the viewport is the one that plays; settle before loading so a fast fling doesn't start six players.
  let settle: ReturnType<typeof setTimeout> | undefined;
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) {
      clearTimeout(settle);
      const i = slides.indexOf(e.target as HTMLElement);
      settle = setTimeout(() => void activate(i), 160);
    }
  }, { root: feed, threshold: [0.6] });
  slides.forEach((s) => seen.observe(s));
  off.signal.addEventListener("abort", () => { seen.disconnect(); clearTimeout(settle); });

  panel.addEventListener("click", (e) => { if (targetOf(e).closest("[data-close]")) toggleComments(false); }, { signal: off.signal });
  feed.addEventListener("click", (e) => {
    const t = targetOf(e);
    const step = t.closest<HTMLElement>("[data-step]"); if (step) return go(Number(step.dataset.step));
    const btn = t.closest<HTMLElement>("[data-act]");
    const slide = t.closest<HTMLElement>(".reel");
    if (btn && slide) {
      const v = videos[slides.indexOf(slide)];
      const act = btn.dataset.act;
      if (act === "comments") return toggleComments(!!panel.hidden);
      if (act === "share") return void copyText(`https://youtu.be/${v.id}`, "Link copied.");
      if (act === "mute") return void player?.key(new KeyboardEvent("keydown", { key: "m" }));
      if (act === "like" || act === "later") { const on = deps.toggleSaved(act === "like" ? "liked" : "later", v); btn.setAttribute("aria-pressed", String(on)); toast(act === "like" ? (on ? "Liked." : "Like removed.") : (on ? "Saved to Watch later." : "Removed from Watch later.")); }
      return;
    }
    if (t.closest("a, .pl-ui, .reel-rail")) return;
    if (t.closest(".reel-stage") && slide === slides[active]) player?.key(new KeyboardEvent("keydown", { key: "k" }));
  }, { signal: off.signal });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA)$/.test(targetOf(e).tagName)) return;
    const k = e.key;
    if (k === "c") { e.preventDefault(); return toggleComments(!!panel.hidden); }
    if (k === "Escape" && !panel.hidden) { e.preventDefault(); return toggleComments(false); }
    if (panel.contains(targetOf(e))) return;   // arrows scroll the comment list, not the feed
    if (k === "ArrowDown" || k === "j") { e.preventDefault(); go(1); }
    else if (k === "ArrowUp" || k === "k") { e.preventDefault(); go(-1); }
    else if (k === " " || k === "m") { e.preventDefault(); player?.key(new KeyboardEvent("keydown", { key: k === " " ? "k" : "m" })); }
  }, { signal: off.signal });

  const first = Math.max(0, videos.findIndex((v) => v.id === startId));
  requestAnimationFrame(() => { slides[first]?.scrollIntoView({ block: "start", behavior: "instant" }); void activate(first); });
  feed.focus({ preventScroll: true });
}
