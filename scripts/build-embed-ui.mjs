#!/usr/bin/env node
/**
 * Build the console as a static SPA and copy it into internal/control/ui
 * so `go:embed` ships the login page inside umbrad.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, "internal/control/ui");
const env = { ...process.env, UMBRA_EMBED_UI: "1" };

const built = spawnSync("node", ["scripts/with-app-env.mjs", "vite", "build"], {
  cwd: root,
  env,
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);

function findIndexHtml(dir, depth = 0) {
  if (depth > 5 || !existsSync(dir) || !statSync(dir).isDirectory()) return null;
  if (existsSync(join(dir, "index.html"))) return dir;
  for (const name of readdirSync(dir)) {
    const hit = findIndexHtml(join(dir, name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

const candidates = [
  join(root, "dist/client"),
  join(root, "dist"),
  join(root, ".output/public"),
  join(root, "build/client"),
];
let src = candidates.find((d) => existsSync(join(d, "index.html")) || existsSync(join(d, "_shell.html")));
if (!src) src = findIndexHtml(join(root, "dist")) ?? findIndexHtml(join(root, ".output"));
if (!src) {
  console.error("embed-ui: no index.html / _shell.html in vite output");
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
for (const name of readdirSync(dest)) {
  rmSync(join(dest, name), { recursive: true, force: true });
}
for (const name of readdirSync(src)) {
  cpSync(join(src, name), join(dest, name), { recursive: true });
}
const shell = join(dest, "_shell.html");
const index = join(dest, "index.html");
if (!existsSync(index) && existsSync(shell)) {
  cpSync(shell, index);
}
if (!existsSync(index)) {
  console.error("embed-ui: copied output but still no index.html");
  process.exit(1);
}
console.log(`embed-ui: ${src} -> ${dest}`);
