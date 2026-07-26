/**
 * Which vendor usage limits this machine can actually show.
 *
 * Only two of the backends leave their rate limits somewhere readable: Claude
 * (the OAuth probe in usageProbe.ts) and Codex (its own session transcripts,
 * codexUsage.ts). Cursor keeps the numbers behind its dashboard and Antigravity
 * fetches them without ever writing them down, so neither can appear here — for
 * those, the per-agent token and cost tally is the only picture of spend.
 *
 * A source shows up when there is data for it, so somebody who has never run
 * codex never sees a codex card. The user can still override that per source,
 * which is kept in planSettings (`usageCards`) as a tri-state: unset follows
 * detection, `false` hides a source that was detected.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPlanSettings } from "./planSettings.js";
import { loadProbeResult } from "./usageProbe.js";
import { readCodexUsage } from "./codexUsage.js";

export type UsageSourceId = "claude" | "codex";

export const USAGE_SOURCE_IDS: readonly UsageSourceId[] = ["claude", "codex"];

export interface UsageSourceState {
  id: UsageSourceId;
  /** Display name for the card and the settings row. */
  label: string;
  /** True when this machine has (or can get) limit data for the source. */
  detected: boolean;
  /** The user's explicit choice. Undefined = follow `detected`. */
  preference?: boolean;
  /** What callers act on: detected and not switched off. */
  visible: boolean;
}

/**
 * Claude counts as detected when the probe has ever produced a result, or when
 * the CLI's own directory exists. Deliberately looser than "has live limits
 * right now": the card doubles as the place to log in and press Refresh, so it
 * must not vanish just because the probe has not run yet or is switched off.
 */
function claudeDetected(): boolean {
  return Boolean(loadProbeResult()) || existsSync(join(homedir(), ".claude"));
}

/** Codex counts as detected only with real numbers, since there is nothing to
 *  press: no codex turn has happened here means nothing to show. */
function codexDetected(): boolean {
  return (readCodexUsage()?.limits.length ?? 0) > 0;
}

const LABELS: Record<UsageSourceId, string> = {
  claude: "Claude",
  codex: "Codex",
};

const DETECTORS: Record<UsageSourceId, () => boolean> = {
  claude: claudeDetected,
  codex: codexDetected,
};

/** State of every usage source, in display order. */
export function usageSources(): UsageSourceState[] {
  const prefs = getPlanSettings().usageCards ?? {};
  return USAGE_SOURCE_IDS.map((id) => {
    let detected = false;
    try {
      detected = DETECTORS[id]();
    } catch {
      // A missing or unreadable data dir just means "not detected".
    }
    const preference = prefs[id];
    return {
      id,
      label: LABELS[id],
      detected,
      preference,
      visible: detected && preference !== false,
    };
  });
}

/** Whether one source should be shown, for callers that only care about one. */
export function usageSourceVisible(id: UsageSourceId): boolean {
  return usageSources().find((s) => s.id === id)?.visible ?? false;
}

/**
 * The preference alone, skipping detection. For callers that are about to read
 * the data anyway (the `/usage` commands), where empty data is detection: this
 * keeps them from reading the same file twice per invocation.
 */
export function usageCardEnabled(id: UsageSourceId): boolean {
  return getPlanSettings().usageCards?.[id] !== false;
}
