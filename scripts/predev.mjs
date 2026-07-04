// Conditional pre-`dev` panel build.
//
// The bot's panel server checks `panel/dist` ONCE at boot (registerStatic in
// src/panel/server.ts): if it's missing it registers a permanent "Panel not
// built" page for the whole process run, and won't pick up a dist that
// `panel:watch` produces a few seconds later. So a cold tree needs dist to
// exist *before* the bot boots.
//
// But `panel:watch` (vite build --watch) always does a full initial build on
// startup anyway. So on a WARM tree (dist already present) an unconditional
// pre-build just builds the panel — and runs `npm install` — a second time for
// nothing. This script builds only when dist is missing; otherwise it's a
// no-op and `panel:watch`'s initial build is the single build.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync("panel/dist")) {
  console.log("[predev] panel/dist present — skipping pre-build (panel:watch refreshes it)");
  process.exit(0);
}

console.log("[predev] panel/dist missing — building panel once so the bot boots with it…");
const r = spawnSync("npm", ["run", "build:panel"], {
  stdio: "inherit",
  // On Windows `npm` is a .cmd shim spawn() can't launch without a shell.
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
