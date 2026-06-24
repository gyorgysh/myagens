import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataPath } from "./jsonStore.js";
import { log } from "../logger.js";

const FILE = dataPath("audit.jsonl");

export interface AuditEvent {
  ts: number;
  /** Where the action came from, e.g. "panel". */
  source: string;
  /** Verb + object, e.g. "prompt.save", "worker.run", "task.move". */
  action: string;
  /** Optional structured details (kept small). */
  detail?: Record<string, unknown>;
}

/** Append one audit event as a JSON line. Best-effort; never throws. */
export function audit(action: string, detail?: Record<string, unknown>, source = "panel"): void {
  const event: AuditEvent = { ts: Date.now(), source, action, detail };
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify(event) + "\n");
  } catch (err) {
    log.warn("Audit append failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Read the most recent `limit` audit events (newest first). */
export function recentAudit(limit = 100): AuditEvent[] {
  try {
    const lines = readFileSync(FILE, "utf8").trim().split("\n");
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as AuditEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEvent => e !== null)
      .reverse();
  } catch {
    return [];
  }
}
