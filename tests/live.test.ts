import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { liveMediaURL, liveManifestURL, createLiveResources, rewriteLiveManifest, createLiveProxy } from "../server/live.js";

const master = "https://manifest.googlevideo.com/api/manifest/hls_playlist/master.m3u8";
const segment = "https://rr1.googlevideo.com/videoplayback/segment.ts";

test("live manifests come from HLS metadata and only trusted HTTPS media hosts", () => {
  assert.equal(liveManifestURL([{ format_id: "live", url: master, protocol: "m3u8_native", manifest_url: master }]), master);
  assert.equal(liveManifestURL([{ format_id: "vod", protocol: "https", url: segment }]), undefined);
  for (const address of ["http://rr1.googlevideo.com/x", "https://googlevideo.com.evil.test/x", "https://localhost/x", "https://rr1.googlevideo.com:8443/x", "https://user:pass@rr1.googlevideo.com/x", "file:///tmp/x"]) {
    assert.throws(() => liveMediaURL(address), /Invalid live media/);
  }
});

test("playlists rewrite video, audio, encryption keys, init segments and relative URLs", () => {
  const found: string[] = [];
  const rewritten = rewriteLiveManifest(`#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\r\n#EXT-X-KEY:METHOD=AES-128,URI="https://rr1.googlevideo.com/key"\r\n#EXT-X-MAP:URI="init.mp4"\r\n#EXTINF:5,\r\n../video.ts\r\n`, master, (url) => { found.push(url); return `/local/${found.length}`; });
  assert.deepEqual(found, [new URL("audio.m3u8", master).href, "https://rr1.googlevideo.com/key", new URL("init.mp4", master).href, new URL("../video.ts", master).href]);
  assert.match(rewritten, /TYPE=AUDIO,URI="\/local\/1"/);
  assert.match(rewritten, /#EXTINF:5,\n\/local\/4/);
  assert.ok(!rewritten.includes("googlevideo"));
  assert.throws(() => rewriteLiveManifest("<html>bad</html>", master, String), /invalid live playlist/);
  assert.throws(() => rewriteLiveManifest("#EXTM3U\nhttps://localhost/private", master, String), /Invalid live media/);
});

test("resource tokens are opaque, profile/video bound, deduplicated and renewed while active", () => {
  let time = 0;
  const resources = createLiveResources({ now: () => time, ttl: 100, maxEntries: 3 });
  const token = resources.register(segment, "video1", "profile1");
  assert.ok(!token.includes("googlevideo"));
  assert.equal(resources.register(segment, "video1", "profile1"), token);
  assert.throws(() => resources.resolve(token, "video2", "profile1"), /Invalid live media request/);
  assert.throws(() => resources.resolve(token, "video1", "profile2"), /Invalid live media request/);
  for (time = 90; time <= 900; time += 90) assert.equal(resources.resolve(token, "video1", "profile1"), segment);
  time = 1100;
  assert.throws(() => resources.resolve(token, "video1", "profile1"), /expired/);
});

test("bounded registry keeps frequently used playlists when old segments are evicted", () => {
  const resources = createLiveResources({ maxEntries: 2 });
  const a = resources.register(master, "v", "p");
  const b = resources.register(segment, "v", "p");
  resources.resolve(a, "v", "p");
  resources.register(segment + "2", "v", "p");
  assert.equal(resources.resolve(a, "v", "p"), master);
  assert.throws(() => resources.resolve(b, "v", "p"), /expired/);
});

async function withProxy(fetcher: typeof fetch, manifest: (v: string, p: string, refresh: boolean) => Promise<string>, run: (base: string) => Promise<void>) {
  const proxy = createLiveProxy({ fetcher, manifest });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    try { await proxy(req, res, url.searchParams.get("v") ?? "v", url.searchParams.get("p") ?? "p", url.searchParams.get("r")); }
    catch (error) { const e = error as Error & { status?: number }; if (!res.destroyed) { res.writeHead(e.status ?? 502); res.end(e.message); } }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("live proxy delivers nested audio/video playlists and ranged media through local tokens", async () => {
  const seen: { url: string; range: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); seen.push({ url, range: new Headers(init?.headers).get("Range") });
    if (url === master) return new Response(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvideo.m3u8\n`, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    if (url.endsWith(".m3u8")) return new Response(`#EXTM3U\n#EXTINF:5,\n${segment}\n`, { headers: { "content-type": "application/x-mpegurl" } });
    return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-type": "video/mp2t", "content-range": "bytes 0-2/10", "content-length": "3" } });
  };
  await withProxy(fetcher, async () => master, async (base) => {
    const root = await fetch(base + "/?v=v&p=p"), text = await root.text();
    assert.equal(root.headers.get("cache-control"), "no-store"); assert.ok(!text.includes("googlevideo"));
    const audio = text.match(/URI="([^"]+)"/)![1], video = text.split("\n").find((line) => line.startsWith("/api/"))!;
    for (const path of [audio, video]) {
      const playlist = await (await fetch(base + path)).text();
      const media = playlist.split("\n").find((line) => line.startsWith("/api/"))!;
      const response = await fetch(base + media, { headers: { Range: "bytes=0-2" } });
      assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 0-2/10");
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
      const badProfile = new URL(base + media); badProfile.searchParams.set("p", "other");
      assert.equal((await fetch(badProfile)).status, 403);
    }
    assert.equal(seen.filter((x) => x.range === "bytes=0-2").length, 2);
  });
});

test("an expired root URL gets fresh metadata and redirects never reach untrusted hosts", async () => {
  const refreshes: boolean[] = [];
  const fetcher: typeof fetch = async (input) => String(input).includes("fresh") ? new Response("#EXTM3U\n") : new Response(null, { status: 403 });
  await withProxy(fetcher, async (_v, _p, refresh) => { refreshes.push(refresh); return master + (refresh ? "?fresh" : ""); }, async (base) => {
    assert.equal((await fetch(base)).status, 200); assert.deepEqual(refreshes, [false, true]);
  });
  let calls = 0;
  await withProxy(async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://localhost/secret" } }); }, async () => master, async (base) => {
    assert.equal((await fetch(base)).status, 400); assert.equal(calls, 1);
  });
});

test("leaving a live media request aborts the upstream segment download", async () => {
  let disconnected!: () => void;
  const aborted = new Promise<void>((resolve) => { disconnected = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === master) return new Response(`#EXTM3U\n${segment}\n`);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      init!.signal!.addEventListener("abort", () => { disconnected(); controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
    } }));
  };
  await withProxy(fetcher, async () => master, async (base) => {
    const text = await (await fetch(base)).text();
    const path = text.split("\n").find((line) => line.startsWith("/api/"))!;
    const client = new AbortController();
    const response = await fetch(base + path, { signal: client.signal });
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).value!.length, 3);
    client.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([aborted, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Upstream did not abort")), 2000); })]); }
    finally { clearTimeout(timer); }
  });
});
