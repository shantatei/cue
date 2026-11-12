import "./build.js";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compiler = spawn(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--watch", "--preserveWatchOutput"], { cwd: root, stdio: "inherit" });
const server = spawn(process.execPath, ["--enable-source-maps", "--watch", "dist/server.js"], { cwd: root, stdio: "inherit" });
const assets = watch(resolve(root, "public"), { recursive: true }, (_event, filename) => {
  if (!filename || filename.endsWith(".ts")) return;
  const source = resolve(root, "public", filename), target = resolve(root, "dist/public", filename);
  void (async () => {
    try {
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, filter: (path) => !path.endsWith(".ts") });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") await rm(target, { force: true, recursive: true });
      else console.error("Asset copy failed:", error);
    }
  })();
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true; assets.close(); compiler.kill(); server.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
compiler.on("exit", stop);
server.on("exit", stop);
console.log("Watching TypeScript and static assets. Refresh the browser after frontend edits.");
