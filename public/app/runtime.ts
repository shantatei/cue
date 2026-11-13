// Injected only into the hosted HTML by the public gateway. Local mode needs no network bootstrap.
export const hosted = typeof document !== "undefined" && document.querySelector('meta[name="cue-mode"]')?.getAttribute("content") === "hosted";
