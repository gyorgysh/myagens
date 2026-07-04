import { existsSync, mkdirSync, statSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Validates that `cwd` still exists as a directory before it's handed to the
 * Claude Agent SDK's child-process spawn. Nothing else checks this — only the
 * interactive `/cd` command validates its target — so an obsolete/deleted
 * path (a folder removed after `/cd` pointed at it, or a stale saved project)
 * otherwise fails every turn with a low-level `spawn ENOENT` and no way to
 * recover short of a manual `/cd`.
 *
 * Returns `cwd` unchanged when it's a valid directory. Otherwise falls back
 * to the shared default `config.WORKDIR` (created if missing) and logs a
 * warning; the caller is responsible for persisting the change and notifying
 * the user (compare the return value against the input to know whether a
 * fallback happened).
 */
export function guardCwd(cwd: string, context: Record<string, unknown> = {}): string {
  try {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd;
  } catch {
    // Any stat error (e.g. permission denied) is treated as invalid too.
  }
  try {
    mkdirSync(config.WORKDIR, { recursive: true });
  } catch {
    // Best-effort; if even this fails there's nothing more we can do here.
  }
  log.warn("cwd no longer exists — falling back to default workdir", {
    ...context,
    badCwd: cwd,
    workdir: config.WORKDIR,
  });
  return config.WORKDIR;
}

/** Chat-facing notice for when {@link guardCwd} had to fall back. */
export function cwdFallbackNotice(badCwd: string): string {
  return (
    `⚠️ Your working directory (\`${badCwd}\`) no longer exists, so I reset it to the default ` +
    `workspace (\`${config.WORKDIR}\`). Use /cd to pick a different one.`
  );
}
