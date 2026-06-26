import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

// Panel-owned JSON stores live in the same gitignored data/ folder as the
// session/schedule state, keyed by filename.
const dataDir = dirname(config.STATE_FILE);

/**
 * Ensure the data directory exists with owner-only (0700) permissions. It holds
 * secrets at rest (the vault key file, session resume tokens, memory), so other
 * local users must not be able to list or read it. `chmodSync` also tightens a
 * directory that already exists with looser (e.g. 0755) permissions.
 */
export function ensureDataDir(): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
  } catch (err) {
    log.error("Failed to secure data directory", { error: errText(err) });
  }
}

ensureDataDir();

/** Resolve a store file path inside the data directory. */
export function dataPath(file: string): string {
  return join(dataDir, file);
}

/**
 * JSON.parse reviver that drops dangerous keys so a tampered store file can't
 * pollute Object.prototype when parsed. The data files are bot-written, but this
 * is cheap defence-in-depth against a poisoned `__proto__`/`constructor` entry.
 */
function safeReviver(key: string, value: unknown): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return value;
}

/** Read a JSON store, returning `fallback` if the file is absent or unreadable. */
export function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(dataPath(file), "utf8"), safeReviver) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error("Failed to read store; using fallback", { file, error: errText(err) });
    }
    return fallback;
  }
}

/** Atomically write a JSON store (temp file + rename). */
export function saveJson<T>(file: string, data: T): void {
  try {
    ensureDataDir();
    const target = dataPath(file);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, target);
  } catch (err) {
    log.error("Failed to persist store", { file, error: errText(err) });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
