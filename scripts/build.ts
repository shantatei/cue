import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc")], { cwd: root, stdio: "inherit" });
await mkdir(resolve(root, "dist/public"), { recursive: true });
await cp(resolve(root, "public"), resolve(root, "dist/public"), { recursive: true, filter: (path) => !path.endsWith(".ts") });
await cp(resolve(root, "scripts"), resolve(root, "dist/scripts"), { recursive: true, filter: (path) => !path.endsWith(".ts") && !path.includes("__pycache__") });
await mkdir(resolve(root, "dist/public/vendor"), { recursive: true });
for (const file of ["dist/hls.mjs", "dist/hls.mjs.map", "LICENSE"]) await cp(resolve(root, "node_modules/hls.js", file), resolve(root, "dist/public/vendor", file.split("/").at(-1)!));
console.log("Built Cue into dist/ (JavaScript, source maps and static assets).");
