import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { DownloadOption } from "../public/app/types.js";
import type { RawFormat } from "./yt-types.js";

const TIER_NAMES: Record<number, string> = { 4320: "8K", 2160: "4K", 1440: "1440p (2K)" };
const MAX_JOBS = 2, KEEP_MS = 60 * 60 * 1000;

/** A stream's size: YouTube's figure when it gives one, otherwise bitrate times duration. */
const bytes = (f: RawFormat, seconds: number) => f.filesize ?? f.filesize_approx ?? (f.tbr && seconds ? Math.round((f.tbr * 1000 / 8) * seconds) : null);
const tier = (f: RawFormat) => Number(/^(\d+)p/.exec(f.format_note ?? "")?.[1]) || f.height || 0;

/**
 * Every quality the video offers, highest first, taken from all of YouTube's streams
 * (including HDR and the codecs the player skips). The estimate is the best stream for that
 * tier plus the best audio.
 */
export function downloadOptions(formats: RawFormat[], seconds = 0): DownloadOption[] {
  const audio = formats.filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none");
  const audioSize = Math.max(0, ...audio.map((f) => bytes(f, seconds) ?? 0)) || null;
  const video = formats.filter((f) => f.vcodec && f.vcodec !== "none" && !f.has_drm && tier(f) > 0);
  const options: DownloadOption[] = [];
  for (const q of [...new Set(video.map(tier))].sort((a, b) => b - a)) {
    const best = video.filter((f) => tier(f) === q).sort((a, b) => (b.fps ?? 0) - (a.fps ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0];
    const hdr = (best.dynamic_range ?? "SDR") !== "SDR";
    const videoSize = bytes(best, seconds), size = videoSize != null ? videoSize + (audioSize ?? 0) : null;
    const fps = Math.round(best.fps ?? 30);
    options.push({
      id: String(q), label: `${TIER_NAMES[q] ?? `${q}p`}${fps > 30 ? ` ${fps}fps` : ""}${hdr ? " HDR" : ""}`,
      detail: `${best.width ?? "?"}×${best.height ?? "?"}`, size,
    });
  }
  if (audio.length) options.push({ id: "audio", label: "Audio only", detail: "Best available (m4a or opus)", size: audioSize });
  return options;
}

type State = "running" | "done" | "error";
interface Job { child?: ChildProcess; cancelled?: boolean; state: State; stage: string; progress: number; dir: string; file?: string; name?: string; size?: number; error?: string; at: number }

export interface DownloadDeps {
  /** Folder for in-progress files (inside the app's data folder). */
  tmp: string;
  /** A private copy of the profile's cookies inside `dir`, for videos that need a login; null when not available. */
  cookies: (profile: string, dir: string) => Promise<string | null>;
  /** Estimated size of the audio track, which the progress bar adds to the video stream's real size. */
  audioBytes: (id: string) => Promise<number | null>;
}

const safeName = (title: string) => title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "video";

export function createDownloads(deps: DownloadDeps) {
  const jobs = new Map<string, Job>();
  // Files from a previous run of the server are never served again.
  void readdir(deps.tmp).then((names) => Promise.all(names.filter((n) => n.startsWith("dl-")).map((n) => rm(`${deps.tmp}${n}`, { recursive: true, force: true })))).catch(() => {});

  async function discard(id: string) {
    const j = jobs.get(id); if (!j) return;
    jobs.delete(id); await rm(j.dir, { recursive: true, force: true });
  }
  const sweep = setInterval(() => { for (const [id, j] of jobs) if (j.state !== "running" && Date.now() - j.at > KEEP_MS) void discard(id); }, 5 * 60 * 1000);
  sweep.unref();

  async function start(video: string, option: string, title: string, profile: string | null) {
    if ([...jobs.values()].filter((j) => j.state === "running").length >= MAX_JOBS) throw Object.assign(new Error("Two downloads are already running. Wait for one to finish."), { status: 429 });
    const id = randomBytes(9).toString("base64url"), dir = `${deps.tmp}dl-${id}`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const job: Job = { state: "running", stage: "Starting", progress: 0, dir, at: Date.now() };
    jobs.set(id, job);
    const audioOnly = option === "audio";
    const height = Number(option);
    const selector = audioOnly ? "ba/b" : `bv*[height<=${height}]+ba/b[height<=${height}]`;
    const args = [
      ...(profile ? await deps.cookies(profile, `${dir}/cookies.txt`).then((c) => (c ? ["--cookies", c] : [])) : []), "--no-playlist", "--newline", "--no-part", "--no-mtime", "-f", selector,
      ...(audioOnly ? [] : ["-S", "res,fps,hdr:12,vcodec:h264,acodec:aac", "--merge-output-format", "mp4/mkv"]),
      "--progress-template", "download:DL %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
      "-o", `${dir}/%(id)s.%(ext)s`, `https://www.youtube.com/watch?v=${video}`,
    ];
    const audioEstimate = audioOnly ? 0 : (await deps.audioBytes(video).catch(() => null)) ?? 0;
    // YouTube sometimes answers 403 to a stream URL issued a moment ago; one fresh attempt clears it.
    const run = (attempt: number) => {
      const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
      job.child = child;
      let base = 0, last = 0, streams = 0, errText = "";
      const onLine = (line: string) => {
        const m = /^DL (\d+) (\S+) (\S+)/.exec(line);
        if (m) {
          const done = Number(m[1]);
          if (done < last) { base += last; streams++; }
          last = done;
          const known = Number(m[2]) || Number(m[3]) || 0;
          const all = known ? (streams === 0 ? known + audioEstimate : base + known) : 0;
          job.stage = audioOnly ? "Downloading audio" : streams === 0 ? "Downloading video" : "Downloading audio";
          if (all) job.progress = Math.min(0.97, (base + done) / all);
        } else if (/\[(Merger|ExtractAudio|VideoRemuxer)\]/.test(line)) { job.stage = "Merging video and audio"; job.progress = 0.98; }
      };
      let buf = "";
      child.stdout.on("data", (d: Buffer) => { buf += d.toString(); const lines = buf.split("\n"); buf = lines.pop() ?? ""; lines.forEach(onLine); });
      child.stderr.on("data", (d: Buffer) => { errText = (errText + d.toString()).slice(-2000); });
      child.on("error", (e) => { job.state = "error"; job.error = `Couldn't start yt-dlp: ${e.message}`; job.at = Date.now(); });
      child.on("close", async (code) => {
        job.at = Date.now();
        if (job.cancelled) return void discard(id);
        const out = (await readdir(dir).catch(() => [])).filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl") && f !== "cookies.txt");
        const file = out.sort().at(-1);
        const retry = code !== 0 && /403/.test(errText) && attempt < 2;
        if (!retry) await rm(`${dir}/cookies.txt`, { force: true });
        if (code === 0 && file) {
          const ext = file.split(".").pop() ?? "mp4";
          job.file = file; job.name = `${safeName(title)} [${audioOnly ? "audio" : `${height}p`}].${ext}`;
          job.size = (await stat(`${dir}/${file}`)).size; job.progress = 1; job.stage = "Ready"; job.state = "done";
        } else {
          if (retry) { job.progress = 0; job.stage = "Retrying"; return run(attempt + 1); }
          job.state = "error";
          const line = errText.trim().split("\n").filter((l) => /ERROR/.test(l)).pop() ?? errText.trim().split("\n").pop() ?? "Download failed";
          job.error = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?(?:[\w-]{11}:\s*)?/, "").slice(0, 300);
        }
      });
    };
    run(1);
    return id;
  }

  /** Stops a running download and deletes everything it had saved so far. */
  async function cancel(id: string) {
    const j = jobs.get(id);
    if (!j) return false;
    if (j.state === "running" && j.child) { j.cancelled = true; j.child.kill("SIGTERM"); j.state = "error"; j.error = "Cancelled"; }
    else await discard(id);
    return true;
  }

  const status = (id: string) => {
    const j = jobs.get(id);
    return j ? { state: j.state, stage: j.stage, progress: j.progress, name: j.name, size: j.size, error: j.error } : null;
  };
  const file = (id: string) => { const j = jobs.get(id); return j?.state === "done" && j.file ? { path: `${j.dir}/${j.file}`, name: j.name ?? j.file, size: j.size ?? 0 } : null; };
  return { start, status, file, discard, cancel };
}
