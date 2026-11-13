import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

type Environment = Record<string, string | undefined>;
function secret(value: string | undefined): string {
  if (!value || value.length < 32) throw new Error("CUE_WORKER_SECRET must contain at least 32 characters.");
  return value;
}
function integer(value: string | undefined, fallback: number, max = 65535): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error("Invalid hosted numeric setting.");
  return n;
}
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(canonical(dirname(path)), basename(path));
  }
}
export function workerConfig(env: Environment, project: string) {
  if (!env.CUE_MODE || env.CUE_MODE === "local") return null;
  if (env.CUE_MODE !== "worker") throw new Error("CUE_MODE must be local or worker.");
  const data = env.CUE_DATA_DIR;
  if (!data || !isAbsolute(data)) throw new Error("A private worker requires an absolute CUE_DATA_DIR.");
  const target = canonical(resolve(data)), root = canonical(resolve(project));
  if (target === dirname(target)) throw new Error("The worker data directory cannot be the filesystem root.");
  // Never share, contain, or rebuild the local installation's persistent data.
  for (const protectedPath of [canonical(resolve(root, "data")), canonical(resolve(root, "dist")), canonical(resolve(root, "public"))]) {
    if (target === protectedPath || target.startsWith(protectedPath + sep) || protectedPath.startsWith(target + sep)) {
      throw new Error("The worker data directory must be separate from local data and dist.");
    }
  }
  return { secret: secret(env.CUE_WORKER_SECRET), bind: env.CUE_WORKER_BIND || "127.0.0.1" };
}
export function matchesSecret(expected: string, supplied: string | string[] | undefined): boolean {
  if (typeof supplied !== "string") return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(expected), hash(supplied));
}
export function hostedConfig(env: Environment) {
  const origin = new URL(env.CUE_PUBLIC_ORIGIN || "http://localhost:8080");
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("CUE_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is only allowed on loopback).");
  }
  const worker = new URL(env.CUE_WORKER_URL || "http://127.0.0.1:3001");
  if (!["http:", "https:"].includes(worker.protocol) || worker.username || worker.password || worker.pathname !== "/" || worker.search || worker.hash) {
    throw new Error("CUE_WORKER_URL must be a fixed HTTP(S) origin.");
  }
  return {
    origin, worker, secret: secret(env.CUE_WORKER_SECRET),
    bind: env.CUE_WEB_BIND || "127.0.0.1", port: integer(env.CUE_WEB_PORT, 8080),
    trustProxy: env.CUE_TRUST_PROXY === "1",
    maxHeavy: integer(env.CUE_MAX_HEAVY, 4, 64), maxMedia: integer(env.CUE_MAX_MEDIA, 32, 256),
    requestsPerMinute: integer(env.CUE_REQUESTS_PER_MINUTE, 120, 10000),
  };
}
export type HostedConfig = ReturnType<typeof hostedConfig>;

// Both sides use the same small, read-only worker interface. No arbitrary URL forwarding.
export const WORKER_ROUTES = new Set([
  "/healthz",
  "/api/info", "/api/live", "/api/channel", "/api/comments", "/api/search",
  "/api/search-suggestions", "/api/channel-avatar", "/api/captions", "/api/img", "/stream",
]);
