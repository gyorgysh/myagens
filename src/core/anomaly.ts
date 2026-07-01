import { readFileSync } from "node:fs";
import { dataPath } from "./jsonStore.js";
import { auditResource, type AuditEvent } from "./audit.js";

/**
 * Audit-log anomaly detection.
 *
 * Scans the recent tail of the append-only action log for suspicious patterns
 * and returns human-readable findings. Purely read-only and deterministic; the
 * heartbeat loop calls {@link detectAnomalies} on its tick and routes any
 * findings through the existing Telegram/push alert path.
 *
 * The three built-in rules mirror the ones the card called out:
 *  - a burst of deletes in a short window (data-destruction spike),
 *  - vault access outside configured working hours (off-hours secret access),
 *  - addition of a new privileged grant (new vault credential / access grant),
 *    the runtime analogue of "a new allowed user was added".
 */

const FILE = dataPath("audit.jsonl");

export type AnomalyKind = "delete-burst" | "vault-offhours" | "new-grant";
export type AnomalySeverity = "warning" | "critical";

export interface Anomaly {
  /** Stable key for alert de-duplication (kind + a coarse time bucket). */
  key: string;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** One-line, user-facing description. */
  text: string;
  /** Epoch-ms of the most recent event that contributed to this finding. */
  ts: number;
  /** How many audit events matched (for burst rules). */
  count: number;
}

export interface AnomalyConfig {
  /** Master switch — anomaly scanning only runs when true. */
  enabled: boolean;
  /** Sliding window (minutes) over which delete events are counted. */
  deleteWindowMin: number;
  /** Number of deletes within the window that trips the burst alert. */
  deleteThreshold: number;
  /** Start of normal working hours, "HH:MM" server-local (inclusive). */
  workStart: string;
  /** End of normal working hours, "HH:MM" server-local (exclusive). */
  workEnd: string;
  /** How far back (minutes) to scan for off-hours / new-grant events. */
  lookbackMin: number;
}

export const ANOMALY_DEFAULTS: AnomalyConfig = {
  enabled: false,
  deleteWindowMin: 10,
  deleteThreshold: 5,
  workStart: "08:00",
  workEnd: "20:00",
  lookbackMin: 30,
};

/** Audit actions that create a new privileged grant (the runtime analogue of
 *  adding a new allowed user): a fresh vault credential or a remote-access
 *  tunnel/grant becoming reachable. */
const GRANT_ACTIONS = new Set(["vault.create", "vault.import", "remote.grant", "remote.enable"]);

/** Vault actions that count as "accessing secrets" for the off-hours rule. */
const VAULT_ACTIONS = new Set(["vault.create", "vault.update", "vault.rotate", "vault.export", "vault.import"]);

function isHHMM(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Whether `date` (server-local) falls outside the [start, end) working window.
 * A window whose end <= start wraps past midnight (e.g. 20:00..08:00 would make
 * daytime the "off" period — unusual but supported).
 */
function outsideWorkHours(start: string, end: string, date: Date): boolean {
  if (!isHHMM(start) || !isHHMM(end)) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  const s = hhmmToMin(start);
  const e = hhmmToMin(end);
  if (s === e) return false;
  const inside = s < e ? cur >= s && cur < e : cur >= s || cur < e;
  return !inside;
}

/** Read the tail of the audit log (newest first), bounded for cheap scanning. */
function tail(limit = 2000): AuditEvent[] {
  try {
    const lines = readFileSync(FILE, "utf8").trim().split("\n");
    const out: AuditEvent[] = [];
    for (const l of lines.slice(-limit)) {
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

/** Coarse time bucket (window-sized) so the same ongoing burst dedupes to one
 *  alert rather than re-firing every tick. */
function bucket(ts: number, windowMs: number): number {
  return Math.floor(ts / windowMs);
}

/**
 * Scan the recent audit log and return any anomalies found. Deterministic and
 * side-effect-free; the caller decides how to surface / dedupe the findings.
 */
export function detectAnomalies(cfg: AnomalyConfig, now = Date.now()): Anomaly[] {
  if (!cfg.enabled) return [];
  const events = tail();
  const out: Anomaly[] = [];

  // Rule 1: delete burst — many *.delete actions inside the sliding window.
  const winMs = Math.max(1, cfg.deleteWindowMin) * 60_000;
  const since = now - winMs;
  const deletes = events.filter((e) => e.ts >= since && e.action.endsWith(".delete"));
  if (deletes.length >= cfg.deleteThreshold) {
    const byResource = new Map<string, number>();
    for (const e of deletes) {
      const r = auditResource(e.action);
      byResource.set(r, (byResource.get(r) ?? 0) + 1);
    }
    const breakdown = [...byResource.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${n} ${r}`)
      .join(", ");
    out.push({
      key: `delete-burst:${bucket(now, winMs)}`,
      kind: "delete-burst",
      severity: deletes.length >= cfg.deleteThreshold * 2 ? "critical" : "warning",
      text: `${deletes.length} deletes in ${cfg.deleteWindowMin} min (${breakdown})`,
      ts: deletes[0].ts,
      count: deletes.length,
    });
  }

  // Rule 2 & 3 scan a wider lookback window.
  const lookbackSince = now - Math.max(1, cfg.lookbackMin) * 60_000;
  const recent = events.filter((e) => e.ts >= lookbackSince);

  // Rule 2: vault access outside working hours.
  const offHoursVault = recent.filter(
    (e) => VAULT_ACTIONS.has(e.action) && outsideWorkHours(cfg.workStart, cfg.workEnd, new Date(e.ts)),
  );
  if (offHoursVault.length > 0) {
    const latest = offHoursVault[0];
    const clock = new Date(latest.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    out.push({
      key: `vault-offhours:${bucket(latest.ts, 3_600_000)}`,
      kind: "vault-offhours",
      severity: "critical",
      text:
        offHoursVault.length === 1
          ? `Vault access at ${clock}, outside ${cfg.workStart}–${cfg.workEnd} (${latest.action})`
          : `${offHoursVault.length} vault operations outside ${cfg.workStart}–${cfg.workEnd} (latest ${latest.action} at ${clock})`,
      ts: latest.ts,
      count: offHoursVault.length,
    });
  }

  // Rule 3: a new privileged grant appeared (new credential / access grant).
  const grants = recent.filter((e) => GRANT_ACTIONS.has(e.action));
  if (grants.length > 0) {
    const latest = grants[0];
    const name =
      latest.detail && typeof latest.detail.name === "string" ? ` "${latest.detail.name}"` : "";
    out.push({
      key: `new-grant:${latest.ts}`,
      kind: "new-grant",
      severity: "warning",
      text:
        grants.length === 1
          ? `New privileged grant added: ${latest.action}${name}`
          : `${grants.length} new privileged grants added (latest ${latest.action}${name})`,
      ts: latest.ts,
      count: grants.length,
    });
  }

  return out;
}
