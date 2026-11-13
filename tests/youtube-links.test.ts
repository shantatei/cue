import test from "node:test";
import assert from "node:assert/strict";
import { cueRouteForLink } from "../public/app/youtube-links.js";

test("YouTube links open the matching Cue page", () => {
  const cases: [string, string | null][] = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "#/watch/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "#/watch/dQw4w9WgXcQ"],
    ["m.youtube.com/watch?v=dQw4w9WgXcQ", "#/watch/dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/GU8ZAOXmgHI", "#/shorts/GU8ZAOXmgHI"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "#/watch/dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "#/watch/dQw4w9WgXcQ"],
    ["https://www.youtube.com/channel/UCJrOtniJ0-NWz37R30urifQ", "#/channel/UCJrOtniJ0-NWz37R30urifQ"],
    ["https://www.youtube.com/watch?v=short", null],
    ["https://example.com/watch?v=dQw4w9WgXcQ", null],
    ["https://notyoutube.com/watch?v=dQw4w9WgXcQ", null],
    ["javascript:alert(1)", null],
    ["alan walker", null],
  ];
  for (const [input, expected] of cases) assert.equal(cueRouteForLink(input), expected, input);
});
