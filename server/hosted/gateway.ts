import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { WORKER_ROUTES, type HostedConfig } from "./config.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2",
};
const HEAVY = new Set(["/api/info", "/api/search", "/api/channel", "/api/comments", "/api/captions", "/api/discover", "/api/shorts"]);
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/** Fixed-window, bounded, process-local admission control. No trust in client forwarding headers by default. */
export function createAdmission(config: Pick<HostedConfig, "requestsPerMinute" | "maxHeavy" | "maxMedia">, now = Date.now) {
  const visitors = new Map<string, { until: number; count: number; active: number; heavy: number }>();
  let active = 0, heavy = 0;
  return (ip: string, expensive: boolean): (() => void) | null => {
    for (const [key, value] of visitors) if (value.until <= now() && !value.active) visitors.delete(key);
    let visitor = visitors.get(ip);
    if (!visitor) {
      if (visitors.size >= 10000) return null;
      visitor = { until: now() + 60_000, count: 0, active: 0, heavy: 0 }; visitors.set(ip, visitor);
    }
    if (visitor.until <= now()) { visitor.until = now() + 60_000; visitor.count = 0; }
    const cost = expensive ? 4 : 1;
    if (visitor.count + cost > config.requestsPerMinute || active >= config.maxMedia || visitor.active >= 8 ||
        (expensive && (heavy >= config.maxHeavy || visitor.heavy >= 2))) return null;
    visitor.count += cost; visitor.active++; active++;
    if (expensive) { visitor.heavy++; heavy++; }
    let released = false;
    return () => {
      if (released) return; released = true;
      visitor.active--; active--;
      if (expensive) { visitor.heavy--; heavy--; }
    };
  };
}

function clientIP(req: IncomingMessage, trusted: boolean): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : undefined;
  return trusted && last && isIP(last) ? last : req.socket.remoteAddress ?? "unknown";
}

/** This is deliberately a read-only interface, not a general reverse proxy. */
async function proxy(req: IncomingMessage, res: ServerResponse, config: HostedConfig, url: URL) {
  const target = new URL(config.worker);
  target.pathname = url.pathname; target.search = url.search;
  // Local profile identifiers are never an authority on a public server.
  target.searchParams.delete("p");
  if (target.pathname === "/api/live") target.searchParams.set("p", "public");
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const headers: Record<string, string> = { host: `localhost:${port}`, "x-cue-worker-secret": config.secret };
  if (req.headers.range && /^bytes=\d+-\d*$/.test(req.headers.range)) headers.range = req.headers.range;
  await new Promise<void>((done) => {
    const remote = (target.protocol === "https:" ? https : http).request(target, { method: "GET", headers }, (source) => {
      if (source.headers["x-cue-worker-version"] !== "1") {
        source.destroy();
        json(res, 503, { error: "The private playback worker is unavailable or incompatible." });
        done(); return;
      }
      const allowed: Record<string, string> = { "cache-control": "private, no-store" };
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = source.headers[name]; if (typeof value === "string") allowed[name] = value;
      }
      res.writeHead(source.statusCode ?? 502, allowed);
      void pipeline(source, res).catch(() => res.destroy()).finally(done);
    });
    const close = () => remote.destroy();
    res.once("close", close);
    remote.setTimeout(60_000, () => remote.destroy(new Error("Worker timeout")));
    remote.once("error", () => {
      res.off("close", close);
      if (!res.headersSent && !res.destroyed) json(res, 503, { error: "Playback is temporarily unavailable. Try again shortly." });
      else res.destroy();
      done();
    });
    remote.end();
  });
}

export async function createHostedServer(config: HostedConfig, publicDir: string) {
  const root = await realpath(publicDir);
  const html = (await readFile(resolve(root, "index.html"), "utf8")).replace('name="cue-mode" content="local"', 'name="cue-mode" content="hosted"');
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!importMap || !html.includes('name="cue-mode" content="hosted"')) throw new Error("The hosted web bundle is missing its runtime marker or import map.");
  const hash = createHash("sha256").update(importMap).digest("base64");
  const csp = `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.ytimg.com https://*.ggpht.com https://*.googleusercontent.com; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src https://www.youtube.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
  const admit = createAdmission(config);
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("content-security-policy", csp);
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (config.origin.protocol === "https:") res.setHeader("strict-transport-security", "max-age=31536000");
    if (req.headers.host !== config.origin.host) return json(res, 403, { error: "Unrecognised host." });
    if ((req.url?.length ?? 0) > 4096) return json(res, 414, { error: "Address is too long." });
    let url: URL;
    try { url = new URL(req.url ?? "/", config.origin); } catch { return json(res, 400, { error: "Invalid address." }); }
    if (url.origin !== config.origin.origin) return json(res, 400, { error: "Invalid origin." });
    if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("allow", "GET, HEAD"); return json(res, 405, { error: "Guest hosting is read-only." }); }
    if (url.pathname === "/healthz") return json(res, 200, { ok: true, mode: "hosted" });
    const api = url.pathname.startsWith("/api/") || url.pathname === "/stream" || url.pathname === "/readyz";
    if (api) {
      if (req.method !== "GET") return json(res, 405, { error: "GET only." });
      const site = req.headers["sec-fetch-site"];
      if ((req.headers.origin && req.headers.origin !== config.origin.origin) || (site && site !== "same-origin" && site !== "none")) {
        return json(res, 403, { error: "Open this request from Cue." });
      }
      if (url.pathname === "/api/account") return json(res, 200, { connected: false });
      if (url.pathname === "/api/discover") { url.pathname = "/api/search"; url.search = new URLSearchParams({ q: "science technology music", type: "videos" }).toString(); }
      if (url.pathname === "/api/shorts") { url.pathname = "/api/search"; url.search = new URLSearchParams({ q: "science music", type: "shorts" }).toString(); }
      if (url.pathname === "/readyz") url.pathname = "/healthz";
      if (!WORKER_ROUTES.has(url.pathname)) return json(res, 404, { error: "This feature is available in local Cue only." });
      const release = admit(clientIP(req, config.trustProxy), HEAVY.has(url.pathname));
      if (!release) { res.setHeader("retry-after", "60"); return json(res, 429, { error: "Cue is busy. Please wait a moment and try again." }); }
      try { await proxy(req, res, config, url); }
      catch { if (!res.headersSent && !res.destroyed) json(res, 503, { error: "Playback is temporarily unavailable." }); else res.destroy(); }
      finally { release(); }
      return;
    }
    try {
      const path = decodeURIComponent(url.pathname);
      const name = path === "/" ? "index.html" : path.slice(1);
      // The public build ships no cookie tools, maps, fixture of the owner's subscriptions, or server files.
      if (!TYPES[extname(name)] || name.endsWith(".map") || name === "app/fixture.json") return json(res, 404, { error: "Not found." });
      const file = await realpath(resolve(root, name));
      if (!file.startsWith(root + sep)) return json(res, 404, { error: "Not found." });
      const body = name === "index.html" ? Buffer.from(html) : await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(name)], "cache-control": "no-cache", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch { json(res, 404, { error: "Not found." }); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 50;
  return server;
}
