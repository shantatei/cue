import test from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostedConfig, workerConfig, matchesSecret } from "../server/hosted/config.js";
import { createAdmission, createHostedServer } from "../server/hosted/gateway.js";

const secret = randomBytes(32).toString("hex");
const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return address.port;
};
const close = (server: Server) => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });

test("hosted configuration fails closed and local mode stays the default", () => {
  assert.equal(workerConfig({}, "/project"), null);
  for (const value of [undefined, "short"]) assert.throws(() => hostedConfig({ CUE_WORKER_SECRET: value }));
  for (const origin of ["http://cue.example", "https://cue.example/path", "https://user@cue.example", "https://cue.example/?x=1"]) {
    assert.throws(() => hostedConfig({ CUE_WORKER_SECRET: secret, CUE_PUBLIC_ORIGIN: origin }));
  }
  assert.throws(() => hostedConfig({ CUE_WORKER_SECRET: secret, CUE_WORKER_URL: "file:///etc/passwd" }));
  for (const dir of [undefined, "relative", "/", "/project/data", "/project/data/accounts", "/project", "/project/dist/cache", "/project/public/cache"]) {
    assert.throws(() => workerConfig({ CUE_MODE: "worker", CUE_WORKER_SECRET: secret, CUE_DATA_DIR: dir }, "/project"));
  }
  assert.ok(workerConfig({ CUE_MODE: "worker", CUE_WORKER_SECRET: secret, CUE_DATA_DIR: "/isolated-worker" }, "/project"));
  assert.ok(matchesSecret(secret, secret)); assert.ok(!matchesSecret(secret, "wrong")); assert.ok(!matchesSecret(secret, [secret]));
});

test("admission bounds expensive work, simultaneous media and per-IP requests", () => {
  let now = 0;
  const admit = createAdmission({ maxHeavy: 1, maxMedia: 2, requestsPerMinute: 8 }, () => now);
  const first = admit("a", true); assert.ok(first);
  assert.equal(admit("b", true), null);
  const second = admit("b", false); assert.ok(second);
  assert.equal(admit("c", false), null);
  first(); first(); second();
  const third = admit("a", true); assert.ok(third); third();
  assert.equal(admit("a", false), null);
  now = 60_001;
  const reset = admit("a", false); assert.ok(reset); reset();
});

test("worker data isolation also rejects symlinks into the local account directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cue-worker-paths-"));
  try {
    await mkdir(join(root, "data", "accounts"), { recursive: true });
    await symlink(join(root, "data"), join(root, "alias"));
    assert.throws(() => workerConfig({ CUE_MODE: "worker", CUE_WORKER_SECRET: secret, CUE_DATA_DIR: join(root, "alias", "new-cache") }, root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gateway proxies only the guest contract, strips credentials and preserves media ranges", async (t) => {
  const calls: { url: string; cookie?: string; authorization?: string; secret?: string | string[]; range?: string }[] = [];
  const worker = http.createServer((req, res) => {
    calls.push({ url: req.url ?? "", cookie: req.headers.cookie, authorization: req.headers.authorization, secret: req.headers["x-cue-worker-secret"], range: req.headers.range });
    res.setHeader("x-cue-worker-version", "1"); res.setHeader("set-cookie", "private=secret");
    if (req.url?.startsWith("/stream")) {
      res.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 2-5/8", "content-length": "4", "accept-ranges": "bytes" });
      return res.end(Buffer.from([2, 3, 4, 5]));
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end("[]");
  });
  const workerPort = await listen(worker); t.after(() => close(worker));
  const config = hostedConfig({ CUE_WORKER_SECRET: secret, CUE_WORKER_URL: `http://127.0.0.1:${workerPort}` });
  const web = await createHostedServer(config, resolve(import.meta.dirname, "../public"));
  const port = await listen(web); t.after(() => close(web)); config.origin = new URL(`http://127.0.0.1:${port}`);
  const base = config.origin.href;
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('name="cue-mode" content="hosted"'));
  const response = await fetch(new URL("api/info?v=abcdefghijk&p=owners-profile", base), { headers: { cookie: "session=private", authorization: "Bearer attacker" } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(response.headers.get("content-security-policy")?.includes("script-src 'self' 'sha256-"));
  assert.ok(!response.headers.get("content-security-policy")?.includes("script-src 'self' 'unsafe-inline'"));
  assert.deepEqual(calls[0], { url: "/api/info?v=abcdefghijk", cookie: undefined, authorization: undefined, secret, range: undefined });
  assert.equal((await fetch(new URL("api/live?v=abcdefghijk&p=owners-profile&r=token", base))).status, 200);
  assert.equal(new URL(calls[1].url, base).searchParams.get("p"), "public");
  const media = await fetch(new URL("stream?v=abcdefghijk&f=137", base), { headers: { range: "bytes=2-5" } });
  assert.equal(media.status, 206); assert.equal(media.headers.get("content-range"), "bytes 2-5/8");
  assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [2, 3, 4, 5]); assert.equal(calls[2].range, "bytes=2-5");
  const before = calls.length;
  for (const path of ["api/account/connect?p=k", "api/account/feed?p=k", "api/download/status?job=somebody", "api/ai-captions", "app/fixture.json", "../server.js", "app/app.js.map"]) {
    assert.equal((await fetch(new URL(path, base))).status, 404, path);
  }
  assert.equal((await fetch(new URL("api/account/connect", base), { method: "POST" })).status, 405);
  assert.equal(calls.length, before, "disabled capabilities never reach the worker");
  assert.deepEqual(await (await fetch(new URL("api/account?p=owners-profile", base))).json(), { connected: false });
  assert.equal((await fetch(new URL("api/info?v=abcdefghijk", base), { headers: { origin: "https://attacker.example" } })).status, 403);
  assert.equal((await fetch(new URL("api/info?v=abcdefghijk", base), { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const forgedHost = await new Promise<number | undefined>((done, reject) => {
    http.get(base, { headers: { host: "attacker.example" } }, (res) => { res.resume(); done(res.statusCode); }).on("error", reject);
  });
  assert.equal(forgedHost, 403);
});

test("an ordinary local server cannot accidentally become the guest worker", async (t) => {
  const wrongWorker = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"private":"must not leak"}'); });
  const workerPort = await listen(wrongWorker); t.after(() => close(wrongWorker));
  const config = hostedConfig({ CUE_WORKER_SECRET: secret, CUE_WORKER_URL: `http://127.0.0.1:${workerPort}` });
  const web = await createHostedServer(config, resolve(import.meta.dirname, "../public"));
  const port = await listen(web); t.after(() => close(web)); config.origin = new URL(`http://127.0.0.1:${port}`);
  const response = await fetch(new URL("api/info?v=abcdefghijk", config.origin));
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("must not leak"));
  await close(wrongWorker);
  assert.equal((await fetch(config.origin)).status, 200, "web shell survives worker outages");
  assert.equal((await fetch(new URL("api/info?v=abcdefghijk", config.origin))).status, 503);
});

test("disconnecting a media viewer cancels the worker response and releases capacity", async (t) => {
  let notifyClosed: () => void;
  const closed = new Promise<void>((done) => { notifyClosed = done; });
  const worker = http.createServer((req, res) => {
    res.setHeader("x-cue-worker-version", "1");
    if (!req.url?.startsWith("/stream")) return res.end("[]");
    res.on("close", () => notifyClosed());
    res.writeHead(200, { "content-type": "video/mp4" }); res.write(Buffer.alloc(16));
  });
  const workerPort = await listen(worker); t.after(() => close(worker));
  const config = hostedConfig({ CUE_WORKER_SECRET: secret, CUE_WORKER_URL: `http://127.0.0.1:${workerPort}`, CUE_MAX_MEDIA: "1" });
  const web = await createHostedServer(config, resolve(import.meta.dirname, "../public"));
  const port = await listen(web); t.after(() => close(web)); config.origin = new URL(`http://127.0.0.1:${port}`);
  await new Promise<void>((done, reject) => {
    const request = http.get(new URL("/stream?v=abcdefghijk&f=137", config.origin), (response) => {
      response.once("data", () => { response.destroy(); request.destroy(); done(); });
    });
    request.on("error", reject);
  });
  await Promise.race([closed, new Promise<never>((_done, reject) => { setTimeout(() => reject(new Error("Upstream stream was not cancelled.")), 2000).unref(); })]);
  assert.equal((await fetch(new URL("/api/info?v=abcdefghijk", config.origin))).status, 200);
});

test("actual private worker requires its secret and refuses account, download and static routes", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "cue-worker-test-")); t.after(() => rm(data, { recursive: true, force: true }));
  const reservation = http.createServer(); const port = await listen(reservation); await close(reservation);
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../server.js")], {
    env: { ...process.env, PORT: String(port), CUE_MODE: "worker", CUE_DATA_DIR: data, CUE_WORKER_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  await Promise.race([
    once(child.stdout!, "data"),
    once(child, "exit").then(() => { throw new Error("Worker did not start."); }),
    new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Worker startup timed out.")), 5000); timer.unref(); }),
  ]);
  const base = `http://127.0.0.1:${port}`;
  const headers = { host: `localhost:${port}`, "x-cue-worker-secret": secret };
  assert.equal((await fetch(base + "/healthz", { headers: { host: `localhost:${port}` } })).status, 401);
  const health = await fetch(base + "/healthz", { headers }); assert.equal(health.status, 200); assert.equal(health.headers.get("x-cue-worker-version"), "1");
  for (const path of ["/", "/api/account?p=k", "/api/account/connect?p=k", "/api/download", "/api/ai-captions/clear"]) {
    assert.equal((await fetch(base + path, { headers })).status, 404, path);
  }
  assert.equal((await fetch(base + "/api/info?v=bad", { headers })).status, 400);
  assert.equal((await fetch(base + "/api/search?q=test", { method: "POST", headers })).status, 404);
});
