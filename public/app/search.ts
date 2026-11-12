import { isAbortError } from "./errors.js";
import { esc, targetOf } from "./util.js";

export function mountSearch(form: HTMLFormElement, { icon, onSearch }: { icon: (name: string, size?: number) => string; onSearch: (query: string) => void }) {
  const input = form.elements.namedItem("q") as HTMLInputElement, wrap = form.parentElement!;
  const list = document.createElement("div");
  list.id = "search-suggestions"; list.className = "search-suggestions";
  list.role = "listbox"; list.setAttribute("aria-label", "Search suggestions"); list.hidden = true;
  wrap.append(list);
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id); input.setAttribute("aria-expanded", "false");
  input.maxLength = 200;
  const clear = document.createElement("button");
  clear.type = "button"; clear.className = "search-clear"; clear.textContent = "×";
  clear.setAttribute("aria-label", "Clear search"); clear.hidden = !input.value;
  form.insertBefore(clear, form.querySelector("button"));
  let items: string[] = [], active = -1, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, version = 0, composing = false;
  const cache = new Map<string, string[]>();
  const cancel = () => {
    version++; clearTimeout(timer); controller?.abort();
    active = -1; input.removeAttribute("aria-activedescendant");
    [...list.children].forEach((option) => option.setAttribute("aria-selected", "false"));
    list.setAttribute("aria-busy", "false");
  };
  const close = () => {
    cancel();
    items = []; active = -1; list.hidden = true; list.innerHTML = "";
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
  };
  const show = (suggestions: string[]) => {
    items = suggestions; active = -1;
    list.innerHTML = items.map((text, i) => `<div id="search-option-${i}" class="search-option" role="option" aria-selected="false" data-suggestion="${i}">${icon("search", 18)}<span>${esc(text)}</span></div>`).join("");
    if (!items.length) list.innerHTML = `<div class="search-option" role="status">No suggestions. Press Enter to search.</div>`;
    list.hidden = false; list.setAttribute("aria-busy", "false"); input.setAttribute("aria-expanded", "true");
  };
  const suggest = () => {
    cancel(); clear.hidden = !input.value;
    const query = input.value.trim();
    if (!query) { close(); return; }
    if (composing) return;
    list.setAttribute("aria-busy", "true");
    const current = version;
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        let suggestions = cache.get(query);
        if (!suggestions) {
          const response = await fetch(`/api/search-suggestions?q=${encodeURIComponent(query)}`, { signal: controller.signal });
          if (!response.ok) throw new Error("Suggestions unavailable");
          const result = await response.json();
          suggestions = Array.isArray(result) ? result.filter((s) => typeof s === "string").slice(0, 12) : [];
          cache.set(query, suggestions);
          if (cache.size > 100) cache.delete(cache.keys().next().value!);
        }
        if (current === version && document.activeElement === input) show(suggestions);
      } catch (error) {
        if (current === version && !isAbortError(error)) {
          list.setAttribute("aria-busy", "false");
          if (list.hidden) show([]);
        }
      }
    }, 180);
  };
  const submit = (query: string) => {
    query = query.trim(); if (!query) return;
    input.value = query; clear.hidden = false; close(); onSearch(query);
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault(); if (!composing) submit(active >= 0 ? items[active] : input.value);
  });
  input.addEventListener("input", suggest);
  input.addEventListener("focus", () => { if (list.hidden) suggest(); });
  input.addEventListener("compositionstart", () => { composing = true; cancel(); });
  input.addEventListener("compositionend", () => { composing = false; suggest(); });
  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    if (!items.length) { suggest(); return; }
    active = (active + (event.key === "ArrowDown" ? 1 : active < 0 ? 0 : -1) + items.length) % items.length;
    input.value = items[active];
    [...list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", `search-option-${active}`);
    list.children[active].scrollIntoView({ block: "nearest" });
  });
  list.addEventListener("pointerdown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const option = targetOf(event).closest<HTMLElement>("[data-suggestion]");
    if (option) submit(items[Number(option.dataset.suggestion)]);
  });
  clear.addEventListener("click", () => { input.value = ""; close(); clear.hidden = true; input.focus(); });
  document.addEventListener("pointerdown", (event) => { if (!wrap.contains(event.target as Node | null)) close(); });
  wrap.addEventListener("focusout", (event) => { if (!wrap.contains(event.relatedTarget as Node | null)) close(); });
  addEventListener("hashchange", close);
}
