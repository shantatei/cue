import type { Extension } from "../../app/types.js";
// Example extension: private notes on each video, with timestamps.
// Add it from the Extensions page with this URL:  /extensions/examples/watch-notes.js
// An extension is a module whose default export describes what it adds. See app/extensions.js
// for the full list of extension points. This one adds a panel under every video.
export default {
  id: "watch-notes",
  name: "Watch notes",
  version: "1.0.0",
  author: "Example",
  icon: "save",
  description: "Jot notes on a video. “Add timestamp” drops the current time into the note, and the time becomes a link that jumps back there.",
  permissions: ["Reads the video you're watching", "Stores notes in this profile's browser storage"],
  watchPanels: [{
    id: "notes",
    render({ info }, api) {
      const saved = api.storage.get(info.id, "");
      return `<section class="iq" style="display:grid;gap:10px"><h2>${api.icon("save", 16)} Notes</h2>
        <textarea data-notes rows="4" placeholder="Notes on this video" style="width:100%;resize:vertical;padding:10px;border-radius:8px;border:1px solid var(--line-2);background:var(--bg);color:inherit;font:inherit">${api.esc(saved)}</textarea>
        <div><button class="btn btn-s" data-stamp>Add timestamp</button></div>
        <div data-links style="display:flex;flex-wrap:wrap;gap:6px 12px"></div></section>`;
    },
    mount(el, { info }, api) {
      const box = el.querySelector<HTMLTextAreaElement>("[data-notes]")!, links = el.querySelector<HTMLElement>("[data-links]")!;
      // Every m:ss or h:mm:ss in the note becomes a button that jumps there.
      const drawLinks = () => {
        const times = [...new Set(box.value.match(/\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/g) ?? [])];
        links.replaceChildren(...times.map((t) => {
          const b = Object.assign(document.createElement("button"), { className: "ts", textContent: t, type: "button" });
          b.addEventListener("click", () => api.player()?.seek(t.split(":").reduce((n, x) => n * 60 + Number(x), 0)));
          return b;
        }));
      };
      box.addEventListener("input", () => { api.storage.set(info.id, box.value); drawLinks(); });
      el.querySelector("[data-stamp]")!.addEventListener("click", () => {
        const t = api.player()?.time ?? 0, before = box.value.slice(0, box.selectionStart);
        const lead = before && !/\s$/.test(before) ? "\n" : "";          // start the stamp on its own line
        box.setRangeText(`${lead}${api.fmtTime(t)} `, box.selectionStart, box.selectionEnd, "end");
        box.dispatchEvent(new Event("input")); box.focus();
      });
      drawLinks();
    },
  }],
} satisfies Extension;
