// vidIQ-style numbers for the video you're watching. Everything is computed from data the app
// already has; nothing is sent anywhere.
import { esc, compact, fmtTime, copyText } from "../util.js";
import { icon } from "/icons.js";

export default {
  id: "video-insights",
  name: "Video insights",
  version: "1.0.0",
  author: "Built in",
  icon: "chart",
  description: "A vidIQ-style panel under every video: views per day or hour, like and comment rates, reach against subscribers, the most-replayed moment, and the video's tags with one-click copy.",
  permissions: ["Reads the video you're watching", "No network access of its own"],
  settings: [
    { key: "tags", type: "toggle", label: "Show tags", default: true },
    { key: "replayed", type: "toggle", label: "Show the most-replayed moment", default: true },
  ],
  topbar: {
    icon: "chart", label: "Insights", title: "Jump to this video's insights",
    onClick(api) { const t = document.getElementById("insights"); t ? t.scrollIntoView({ behavior: "smooth", block: "center" }) : api.toast("Open a video to see its insights."); },
  },
  watchPanels: [{
    id: "panel",
    render({ info, data }, api) {
      const ageH = info.timestamp ? Math.max(1, (Date.now() / 1000 - info.timestamp) / 3600) : null;
      const subs = data.channels.get(info.channelId)?.subs ?? info.subscribers;
      const peak = api.settings.get("replayed") && info.heatmap.length ? info.heatmap.reduce((a, b) => (b.value > a.value ? b : a)) : null;
      const rows = [
        ageH && info.views != null ? [ageH > 24 * 30 ? "Views per day" : "Views per hour", compact(info.views / (ageH > 24 * 30 ? ageH / 24 : ageH))] : null,
        info.likes != null && info.views ? ["Likes per view", `${((info.likes / info.views) * 100).toFixed(1)}%`] : null,
        info.comments != null && info.views ? ["Comments per 1K views", ((info.comments / info.views) * 1000).toFixed(1)] : null,
        subs && info.views != null ? ["Views vs. subscribers", `${(info.views / subs).toFixed(2)}×`] : null,
        ["Length", fmtTime(info.duration)], info.categories[0] ? ["Category", esc(info.categories[0])] : null,
        info.timestamp ? ["Published", new Date(info.timestamp * 1000).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })] : null,
        peak ? ["Most replayed", `<button class="ts" data-t="${Math.round((peak.start_time + peak.end_time) / 2)}">${fmtTime((peak.start_time + peak.end_time) / 2)}</button>`] : null,
      ].filter(Boolean);
      const tags = api.settings.get("tags") && info.tags.length
        ? `<div class="tags">${info.tags.slice(0, 14).map((t) => `<span>${esc(t)}</span>`).join("")}<button class="btn btn-s" data-copytags>Copy ${info.tags.length} tags</button></div>` : "";
      return `<section class="iq" id="insights"><h2>${icon("chart", 16)} Video insights</h2><dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${tags}</section>`;
    },
    mount(el, { info }, api) {
      el.querySelector("[data-copytags]")?.addEventListener("click", () => copyText(info.tags.join(", "), "Tags copied."));
    },
  }],
};
