import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ROOT, DATA, SCRIPTS } from "../server/paths.js";

test("compiled server keeps account data and Python helpers outside the rebuildable output", () => {
  const project = resolve(import.meta.dirname, "../..");
  assert.equal(resolve(ROOT), project);
  assert.equal(resolve(DATA), resolve(project, "data"));
  assert.equal(resolve(SCRIPTS), resolve(project, "scripts"));
  assert.ok(!resolve(DATA).startsWith(resolve(project, "dist")));
});
