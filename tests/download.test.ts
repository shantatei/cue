import test from "node:test";
import assert from "node:assert/strict";
import { downloadOptions } from "../server/download.js";
import type { RawFormat } from "../server/yt-types.js";

const v = (id: string, height: number, extra: Partial<RawFormat> = {}): RawFormat => ({ format_id: id, url: "x", vcodec: "vp9", acodec: "none", height, width: height * 16 / 9, format_note: `${height}p`, tbr: height, fps: 30, ...extra });
const a: RawFormat = { format_id: "251", url: "x", vcodec: "none", acodec: "opus", abr: 128, tbr: 128 };

test("download options list every quality from highest to lowest, then audio", () => {
  const opts = downloadOptions([v("a", 720), v("b", 2160, { dynamic_range: "HDR10", fps: 60 }), v("c", 1080), v("d", 1080, { vcodec: "avc1" }), a], 100);
  assert.deepEqual(opts.map((o) => o.id), ["2160", "1080", "720", "audio"]);
  assert.equal(opts[0].label, "4K 60fps HDR");
  assert.equal(opts[0].size, Math.round(2160 * 1000 / 8 * 100) + Math.round(128 * 1000 / 8 * 100));
  assert.equal(opts.at(-1)?.label, "Audio only");
});

test("protected and unsized streams are handled", () => {
  const opts = downloadOptions([v("a", 1080, { has_drm: true }), v("b", 480, { tbr: undefined })], 0);
  assert.deepEqual(opts.map((o) => o.id), ["480"]);
  assert.equal(opts[0].size, null);
});
