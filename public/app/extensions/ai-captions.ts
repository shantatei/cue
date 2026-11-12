import type { Extension, CaptionRequest, AIStatus } from "../types.js";
// Captions for videos that have none, or whose YouTube captions are poor. Whisper runs on this
// machine (via the local server); only the audio download touches the network.
const poll = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "ai-captions",
  name: "AI captions",
  version: "1.0.0",
  author: "Built in",
  icon: "captions",
  description: "When a video has no uploaded captions, transcribe the speech on this Mac with Whisper large-v3-turbo, in the language spoken. Can also translate to English. Usually a lot closer than YouTube's auto-generated captions, especially outside English.",
  permissions: ["Downloads the video's audio through the local server", "Runs Whisper on this machine; no audio is uploaded anywhere"],
  settings: [
    { key: "auto", type: "toggle", label: "When captions are on by default, generate them for videos that have none", default: true },
    { key: "beforeAuto", type: "toggle", label: "Prefer AI captions over YouTube's auto-generated ones", default: true },
    { key: "translate", type: "toggle", label: "Offer an English translation for other languages", default: true },
  ],
  async captionRequests({ info }, api) {
    const id = info.id, lang = (info.language ?? "").split("-")[0];
    const english = lang === "en";
    const hasManual = info.captions.some((c) => c.kind === "manual");
    const tasks: [CaptionRequest["task"], string][] = [["transcribe", "AI captions"], ...(api.settings.get("translate") && !english ? [["translate", "AI captions, translated to English"] as [CaptionRequest["task"], string]] : [])];
    const out: CaptionRequest[] = [];
    for (const [task, label] of tasks) {
      const q = `v=${id}&task=${task}`;
      const status: AIStatus = await fetch(`/api/ai-captions?${q}`).then((r) => r.json()).catch(() => ({ available: false }));
      if (!status.available) continue;
      out.push({
        id: `ai:${task}`, task, label, cached: status.state === "done", beforeAuto: Boolean(api.settings.get("beforeAuto")),
        auto: Boolean(api.settings.get("auto")) && !hasManual,
        note: status.state === "done" ? "Ready" : status.state === "running" ? "Working…" : "Generate on this Mac",
        async start(report) {
          let s = status.state === "done" ? status : await fetch(`/api/ai-captions?${q}&lang=${encodeURIComponent(info.language ?? "auto")}`, { method: "POST" }).then((r) => r.json());
          while (s.state !== "done") {
            if (s.state === "error") throw new Error(s.error ?? "Transcription failed");
            if (s.state === "idle" && s.error) throw new Error(s.error);
            report(s.state === "queued" ? "Waiting for another transcription…" : `${s.stage ?? "Working"}${s.progress ? ` ${s.progress}%` : "…"}`);
            await poll(1500);
            s = await fetch(`/api/ai-captions?${q}`).then((r) => r.json());
          }
          return `/api/ai-captions.vtt?${q}`;
        },
      });
    }
    return out;
  },
} satisfies Extension;
