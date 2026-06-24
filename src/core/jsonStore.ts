import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

// Panel-owned JSON stores live in the same gitignored data/ folder as the
// session/schedule state, keyed by filename.
const dataDir = dirname(config.STATE_FILE);

/** Resolve a store file path inside the data directory. */
export function dataPath(file: string): string {
  return join(dataDir, file);
}

/** Read a JSON store, returning `fallback` if the file is absent or unreadable. */
export function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(dataPath(file), "utf8")) as T;
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
    mkdirSync(dataDir, { recursive: true });
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
