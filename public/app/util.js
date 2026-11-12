export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const compact = (n) => (n == null ? "" : nf.format(n));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
// Old uploads read as absolute dates after a week ("340 days ago" is noise).
export function ago(ts) {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
export function dayLabel(ts) {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts * 1000).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
/** First visible character of a name; Array.from keeps emoji whole. */
export const initial = (name) => (Array.from(String(name ?? "").trim())[0] ?? "?").toUpperCase();

/** Copy to the clipboard and say what happened, instead of claiming success blindly. */
export async function copyText(text, okMessage) {
  try { await navigator.clipboard.writeText(text); toast(okMessage); }
  catch { toast("Couldn't copy. Allow clipboard access for this page and try again."); }
}

let toastTimer;
export function toast(msg) {
  document.querySelector(".toast")?.remove();
  const el = Object.assign(document.createElement("div"), { className: "toast", role: "status", textContent: msg });
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}
