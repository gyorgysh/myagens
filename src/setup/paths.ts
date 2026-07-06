import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Repo root from a module inside src/setup/ or dist/setup/ (three levels up
 * from the file). Mirrors config.ts's repoRoot without importing config.ts —
 * setup mode runs precisely because config validation would fail.
 */
export function repoRootFromHere(moduleUrl: string): string {
  return dirname(dirname(dirname(fileURLToPath(moduleUrl))));
}
