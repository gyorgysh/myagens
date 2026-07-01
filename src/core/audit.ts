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

/** The resource an action operates on: the segment before the first dot in the
 *  action verb (e.g. "vault.rotate" -> "vault", "task.move" -> "task"). Falls
 *  back to the whole action when it carries no dot. */
export function auditResource(action: string): string {
  const dot = action.indexOf(".");
  return dot === -1 ? action : action.slice(0, dot);
}

/** Parse every retained audit line into events (newest first). Best-effort:
 *  malformed lines are skipped, a missing file yields an empty list. */
function readAll(): AuditEvent[] {
  try {
    const lines = readFileSync(FILE, "utf8").trim().split("\n");
    const out: AuditEvent[] = [];
    for (const l of lines) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l) as AuditEvent);
      } catch {
        /* skip malformed */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

/** Read the most recent `limit` audit events (newest first). */
export function recentAudit(limit = 100): AuditEvent[] {
  return readAll().slice(0, limit);
}

export interface AuditQuery {
  /** Free-text needle matched against action, source, and detail (case-insensitive). */
  q?: string;
  /** Restrict to events from this source/actor (exact match). */
  actor?: string;
  /** Restrict to events whose action equals this (exact match). */
  action?: string;
  /** Restrict to events whose resource (action prefix) equals this. */
  resource?: string;
  /** Only events at/after this epoch-ms. */
  since?: number;
  /** Max rows to return (newest first). */
  limit?: number;
}

export interface AuditFacets {
  /** Distinct actors (sources) seen, most frequent first. */
  actors: string[];
  /** Distinct resources (action prefixes) seen, most frequent first. */
  resources: string[];
  /** Distinct full actions seen, most frequent first. */
  actions: string[];
}

/** Search the audit log with actor/action/resource/text filters. Reads the
 *  whole retained file, so results span the full history, not just the tail. */
export function searchAudit(query: AuditQuery = {}): AuditEvent[] {
  const { q, actor, action, resource, since, limit = 500 } = query;
  const needle = q?.trim().toLowerCase();
  const out: AuditEvent[] = [];
  for (const e of readAll()) {
    if (actor && e.source !== actor) continue;
    if (action && e.action !== action) continue;
    if (resource && auditResource(e.action) !== resource) continue;
    if (since && e.ts < since) continue;
    if (needle) {
      const hay = `${e.action} ${e.source} ${e.detail ? JSON.stringify(e.detail) : ""}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** Distinct actors, resources, and actions across the retained log, ordered by
 *  frequency (for populating the panel's filter dropdowns). */
export function auditFacets(): AuditFacets {
  const actors = new Map<string, number>();
  const resources = new Map<string, number>();
  const actions = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of readAll()) {
    bump(actors, e.source);
    bump(resources, auditResource(e.action));
    bump(actions, e.action);
  }
  const ranked = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { actors: ranked(actors), resources: ranked(resources), actions: ranked(actions) };
}
