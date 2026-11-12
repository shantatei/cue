import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RawFormat } from "./yt-types.js";

const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
export function liveMediaURL(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".googlevideo.com") || url.username || url.password || (url.port && url.port !== "443")) throw failure("Invalid live media address.", 400);
  return url;
}
export function liveManifestURL(formats: RawFormat[]): string | undefined {
  const stream = formats.find((f) => f.protocol?.startsWith("m3u8") && f.manifest_url);
  return stream?.manifest_url ? liveMediaURL(stream.manifest_url).href : undefined;
}

/** Only media URLs supplied by YouTube playlists get a local token; clients cannot pick a URL. */
export function createLiveResources({ now = Date.now, ttl = 5 * 60_000, maxEntries = 4096 } = {}) {
  const entries = new Map<string, { url: string; video: string; profile: string; expires: number; key: string }>();
  const byURL = new Map<string, string>();
  const remove = (token: string) => { const entry = entries.get(token); if (entry) byURL.delete(entry.key); entries.delete(token); };
  return {
    register(value: string, video: string, profile: string): string {
      const url = liveMediaURL(value).href, key = JSON.stringify([video, profile, url]);
      const saved = byURL.get(key), entry = saved ? entries.get(saved) : undefined;
      if (entry) { entry.expires = now() + ttl; entries.delete(saved!); entries.set(saved!, entry); return saved!; }
      for (const [token, item] of entries) if (item.expires <= now()) remove(token);
      while (entries.size >= maxEntries) remove(entries.keys().next().value!);
      const token = randomUUID(); entries.set(token, { url, video, profile, expires: now() + ttl, key }); byURL.set(key, token);
      return token;
    },
    resolve(token: string, video: string, profile: string): string {
      const entry = entries.get(token);
      if (!entry || entry.expires <= now()) { remove(token); throw failure("Live media expired. Reconnect to the live stream.", 410); }
      if (entry.video !== video || entry.profile !== profile) throw failure("Invalid live media request.", 403);
      entry.expires = now() + ttl; entries.delete(token); entries.set(token, entry);
      return entry.url;
    },
  };
}

export function rewriteLiveManifest(text: string, base: string, register: (url: string) => string): string {
  if (!text.trimStart().startsWith("#EXTM3U")) throw failure("YouTube returned an invalid live playlist.", 502);
  const rewrite = (value: string) => register(liveMediaURL(value, base).href);
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
    return rewrite(line.trim());
  }).join("\n");
}

export function createLiveProxy({ manifest, fetcher = fetch }: {
  manifest: (video: string, profile: string, refresh: boolean) => Promise<string>;
  fetcher?: typeof fetch;
}) {
  const resources = createLiveResources();
  return async (req: IncomingMessage, res: ServerResponse, video: string, profile: string, token: string | null): Promise<void> => {
    const abort = new AbortController(), disconnect = () => abort.abort();
    res.on("close", disconnect);
    const get = async (value: string): Promise<{ response: Response; url: URL }> => {
      let url = liveMediaURL(value);
      for (let redirects = 0; redirects < 4; redirects++) {
        const range = req.headers.range;
        const response = await fetcher(url, { redirect: "manual", headers: range && /^bytes=\d+-\d*$/.test(range) ? { Range: range } : {}, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          url = liveMediaURL(response.headers.get("location") ?? "", url.href); continue;
        }
        return { response, url };
      }
      throw failure("Too many live media redirects.", 502);
    };
    try {
      const address = token ? resources.resolve(token, video, profile) : await manifest(video, profile, false);
      let upstream = await get(address);
      if (!token && [401, 403, 410].includes(upstream.response.status)) {
        await upstream.response.body?.cancel(); upstream = await get(await manifest(video, profile, true));
      }
      const { response, url } = upstream;
      if (!response.ok) { await response.body?.cancel(); throw failure(`Live stream is unavailable (${response.status}). Try reconnecting.`, response.status === 404 ? 404 : 502); }
      const type = response.headers.get("content-type") ?? "application/octet-stream";
      const playlist = !token || /mpegurl/i.test(type) || /\.m3u8$|\/manifest\//i.test(url.pathname);
      if (playlist) {
        const text = await response.text();
        if (text.length > 2_000_000) throw failure("Live playlist is too large.", 502);
        const body = rewriteLiveManifest(text, url.href, (address) => {
          const params = new URLSearchParams({ v: video, p: profile, r: resources.register(address, video, profile) });
          return `/api/live?${params}`;
        });
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store", "content-length": Buffer.byteLength(body) }); res.end(body); return;
      }
      const headers: Record<string, string> = { "content-type": type, "cache-control": "private, max-age=30" };
      for (const name of ["content-length", "content-range", "accept-ranges"]) { const value = response.headers.get(name); if (value) headers[name] = value; }
      if (!response.body) throw failure("Empty live media response.", 502);
      res.writeHead(response.status, headers);
      for await (const chunk of response.body) if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
      res.end();
    } finally { res.off("close", disconnect); }
  };
}
