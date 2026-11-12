import { settings } from "./settings.js";

export function liveChatURL(video: string, hostname: string, dark = true): string {
  const url = new URL("https://www.youtube.com/live_chat");
  url.search = new URLSearchParams({ v: video, embed_domain: hostname, ...(dark ? { dark_theme: "1" } : {}) }).toString();
  return url.href;
}

/** YouTube renders and moderates its own chat. The app never reads or submits messages. */
export function mountLiveChat(root: HTMLElement, video: string, signal: AbortSignal): void {
  root.classList.add("live-chat");
  root.innerHTML = `<header><h2>Live chat</h2><a target="_blank" rel="noopener noreferrer">Open chat ↗</a>
    <button type="button" aria-expanded="true">Hide chat</button></header><div class="live-chat-body"></div>
    <p class="live-chat-hint">Chat uses your YouTube browser sign-in. If it doesn’t appear here, use Open chat.</p>`;
  const link = root.querySelector("a")!;
  link.href = `https://www.youtube.com/live_chat?${new URLSearchParams({ v: video, is_popout: "1" })}`;
  const button = root.querySelector("button")!;
  const body = root.querySelector<HTMLElement>(".live-chat-body")!;
  let open = true;
  const render = () => {
    body.replaceChildren(); body.hidden = !open;
    root.querySelector<HTMLElement>(".live-chat-hint")!.hidden = !open;
    button.textContent = open ? "Hide chat" : "Show chat"; button.setAttribute("aria-expanded", String(open));
    if (!open || signal.aborted) return;
    const frame = document.createElement("iframe");
    frame.title = "YouTube live chat";
    frame.src = liveChatURL(video, location.hostname, document.documentElement.dataset.theme !== "light");
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    body.append(frame);
  };
  button.addEventListener("click", () => { open = !open; render(); }, { signal });
  const unsubscribe = settings.onChange((_settings, path) => { if (path === "theme" || path === "*") render(); });
  signal.addEventListener("abort", () => { unsubscribe(); body.replaceChildren(); }, { once: true });
  render();
}
