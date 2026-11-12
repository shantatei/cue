import type { WorkerPage, RecommendationPage } from "../public/app/types.js";
export interface RecommendationWorker { close: () => void; next: () => Promise<WorkerPage> }
interface Session {
  profile: string; index: number; worker: Promise<RecommendationWorker>; timer?: ReturnType<typeof setTimeout>;
  ended?: boolean; last?: { index: number; result: RecommendationPage };
  pending?: { index: number; result: Promise<RecommendationPage> } | null;
}
import { SCRIPTS } from "./paths.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const expired = () => Object.assign(new Error("Recommendations expired. Load them again."), { status: 410 });

/** Profile-bound cursors; retries of the latest page share its result instead of skipping videos. */
export function createRecommendationPager({ start, idleMs = 10 * 60 * 1000 }: { start: (profile: string) => Promise<RecommendationWorker>; idleMs?: number }) {
  const sessions = new Map<string, Session>();
  const close = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id); clearTimeout(s.timer);
    s.worker.then((w) => w.close(), () => {});
  };
  const touch = (id: string, s: Session) => { clearTimeout(s.timer); s.timer = setTimeout(() => close(id), idleMs); s.timer.unref?.(); };
  return {
    closeProfile(profile: string) { for (const [id, s] of sessions) if (s.profile === profile) close(id); },
    async page(profile: string, cursor = ""): Promise<RecommendationPage> {
      let id: string, index: number;
      if (cursor) {
        const match = /^([\da-f-]{36}):(\d+)$/.exec(cursor);
        if (!match) throw expired();
        [, id] = match; index = Number(match[2]);
      } else {
        // A few tabs can each keep their own iterator. Bound idle processes per profile.
        const own = [...sessions].filter(([, s]) => s.profile === profile);
        if (own.length >= 3) close(own[0][0]);
        id = randomUUID(); index = 0;
        sessions.set(id, { profile, index: 0, worker: Promise.resolve().then(() => start(profile)) });
      }
      const s = sessions.get(id);
      if (!s || s.profile !== profile) throw expired();
      touch(id, s);
      if (s.last?.index === index) return s.last.result;
      if (s.pending?.index === index) return s.pending.result;
      if (index !== s.index || s.ended) throw expired();
      const result = s.worker.then((w) => w.next()).then(({ videos, hasMore }) => {
        if (!sessions.has(id)) throw expired();
        s.index++; s.ended = !hasMore;
        const result = { videos, nextCursor: hasMore ? `${id}:${s.index}` : null };
        s.last = { index, result }; s.pending = null;
        if (!hasMore) s.worker.then((w) => w.close());
        touch(id, s);
        return result;
      }).catch((error) => { close(id); throw error; });
      s.pending = { index, result };
      return result;
    },
  };
}

export async function startRecommendationWorker(python: string, cookiefile: string): Promise<RecommendationWorker> {
  const dir = await mkdtemp(join(tmpdir(), "own-recommendations-"));
  await chmod(dir, 0o700);
  const snapshot = join(dir, "cookies.txt");
  try { await copyFile(cookiefile, snapshot); await chmod(snapshot, 0o600); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const child = spawn(python, [`${SCRIPTS}recommendations.py`, snapshot], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  let pending: { timer: ReturnType<typeof setTimeout>; resolve: (page: WorkerPage) => void; reject: (error: Error) => void } | null = null, closed = false;
  const fail = (error: Error) => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
  const close = () => {
    closed = true; fail(new Error("Recommendations closed."));
    child.kill(); lines.close();
    rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  child.on("error", () => { fail(new Error("Couldn't start recommendations.")); close(); });
  child.on("exit", () => { fail(new Error("YouTube stopped sending recommendations. Try again.")); close(); });
  child.stdin.on("error", () => { fail(new Error("Recommendations connection closed.")); close(); });
  lines.on("line", (line) => {
    if (!pending) return;
    const current = pending; pending = null; clearTimeout(current.timer);
    try {
      const result = JSON.parse(line) as WorkerPage & { error?: string };
      if (result.error) { current.reject(new Error(result.error)); close(); }
      else if (!Array.isArray(result.videos)) { current.reject(new Error("Invalid recommendation page.")); close(); }
      else current.resolve(result);
    } catch { current.reject(new Error("Invalid recommendation page.")); close(); }
  });
  return {
    close,
    next() {
      if (closed) return Promise.reject(expired());
      if (pending) return Promise.reject(new Error("Recommendations are already loading."));
      return new Promise<WorkerPage>((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error("YouTube took too long to load recommendations. Try again.")); close(); }, 45_000);
        pending = { resolve, reject, timer }; child.stdin.write("next\n");
      });
    },
  };
}
