// Busy-aware dev runner for the bot.
//
// Replaces `tsx watch src/index.ts`. tsx's own watcher restarts on every source
// change, which kills an in-flight agent run that happens to edit this repo's
// own source (e.g. a delegated kanban card, or the panel chat working on the
// bot itself). This runner watches src/ the same way, but defers the restart
// while a run holds the dev guard lock (.dev-busy, maintained by src/core/
// devGuard.ts via runTurn). When the lock clears, the pending restart fires.
//
// Node >= 20 (recursive fs.watch is stable on macOS/Windows/Linux there).

import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const ENTRY = "src/index.ts";
const SRC = resolve(ROOT, "src");
const LOCK = resolve(ROOT, ".dev-busy");

const DEBOUNCE_MS = 200;
const BUSY_RECHECK_MS = 500;

let child = null;
let restartTimer = null;
let busyTimer = null;
let crashTimer = null;
let shuttingDown = false;
// Prevents multiple concurrent applyRestart calls from spawning more than one
// child. Set to true as soon as a restart is in flight; cleared when the new
// child is actually running (or on error).
let restarting = false;
// Set right before we deliberately SIGTERM a child (planned restart or
// shutdown). The bot catches SIGTERM itself and calls process.exit(0), so
// Node reports the exit as `signal: null`, not "SIGTERM" — without this flag
// the crash handler below can't tell a planned restart from a real crash and
// queues a redundant extra restart on top of the immediate one, causing an
// endless restart loop.
let killingForRestart = false;

// Crash-loop backoff: consecutive unexpected exits ramp the delay up
// (2s, 5s, 10s, 20s, capped at 30s) so a persistently broken start doesn't
// spin-loop, but a single transient blip (e.g. a Telegram network error)
// recovers fast. Resets once the process survives a full window.
const CRASH_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];
const CRASH_HEALTHY_AFTER_MS = 30_000;
let consecutiveCrashes = 0;
let startedAt = 0;

function startChild() {
  restarting = false;
  startedAt = Date.now();
  child = spawn("tsx", [ENTRY], {
    stdio: "inherit",
    env: { ...process.env, CCT_DEV_GUARD: "1" },
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (shuttingDown || signal === "SIGTERM" || killingForRestart) {
      killingForRestart = false;
      return;
    }
    // Unexpected exit (crash). Auto-restart with backoff instead of killing
    // the whole dev session, so a transient startup error doesn't require
    // manually re-running `npm run dev`.
    if (Date.now() - startedAt >= CRASH_HEALTHY_AFTER_MS) consecutiveCrashes = 0;
    const delayMs = CRASH_BACKOFF_MS[Math.min(consecutiveCrashes, CRASH_BACKOFF_MS.length - 1)];
    consecutiveCrashes += 1;
    console.log(
      `[dev] bot exited unexpectedly (code ${code ?? "?"}) — restarting in ${delayMs / 1000}s`,
    );
    if (crashTimer) clearTimeout(crashTimer);
    crashTimer = setTimeout(() => {
      crashTimer = null;
      applyRestart();
    }, delayMs);
  });
}

function applyRestart() {
  // Only one restart may be in flight at a time.
  if (restarting) return;
  // Wait out an active run: an agent may be mid-edit on our own source.
  if (existsSync(LOCK)) {
    if (busyTimer) clearTimeout(busyTimer);
    busyTimer = setTimeout(applyRestart, BUSY_RECHECK_MS);
    return;
  }
  busyTimer = null;
  restarting = true;
  if (!child) {
    startChild();
    return;
  }
  // Restart cleanly: kill, then respawn once the old process has fully exited
  // (avoids two bots fighting over the Telegram long-poll / panel port).
  const old = child;
  child = null;
  killingForRestart = true;
  old.once("exit", () => startChild());
  old.kill("SIGTERM");
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    applyRestart();
  }, DEBOUNCE_MS);
}

watch(SRC, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  // Only source changes matter; ignore editor temp files.
  if (!/\.(ts|tsx|js|mjs|json)$/.test(filename)) return;
  if (filename.endsWith("~") || filename.includes(".tmp")) return;
  console.log(`[dev] change: ${filename} — restart pending`);
  scheduleRestart();
});

function shutdown() {
  shuttingDown = true;
  restarting = false;
  if (restartTimer) clearTimeout(restartTimer);
  if (busyTimer) clearTimeout(busyTimer);
  if (crashTimer) clearTimeout(crashTimer);
  if (child) child.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[dev] bot watcher started (restarts defer while a run is active)");
startChild();
