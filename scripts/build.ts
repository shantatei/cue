import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc")], { cwd: root, stdio: "inherit" });
await mkdir(resolve(root, "dist/public"), { recursive: true });
await cp(resolve(root, "public"), resolve(root, "dist/public"), { recursive: true, filter: (path) => !path.endsWith(".ts") });
await cp(resolve(root, "scripts"), resolve(root, "dist/scripts"), { recursive: true, filter: (path) => !path.endsWith(".ts") && !path.includes("__pycache__") });
console.log("Built Cue into dist/ (JavaScript, source maps and static assets).");
