/**
 * Per-agent token/cost usage tracking.
 *
 * Records a cumulative UsageStat per named agent (Atlas, Iris, Ethan, task
 * delegations, etc.) and persists to agentUsage.json in the data dir. Each
 * entry also carries a 30-day rolling daily breakdown so the panel can render
 * a per-category token chart alongside the session-level chart.
 */
import { zeroStat, type UsageStat } from "../session/store.js";
import { loadJson, saveJson } from "./jsonStore.js";
import type { TurnUsage } from "../session/manager.js";

const FILE = "agentUsage.json";

export type AgentRole = "atlas" | "lead" | "worker" | "task" | "schedule" | "agentchat";

export interface AgentUsageEntry {
  /** Display name: "Atlas", the Lead's name, worker's name, "Tasks", etc. */
  name: string;
  role: AgentRole;
  total: UsageStat;
  /** Daily buckets keyed YYYY-MM-DD, kept for 30 days. */
  daily: Record<string, UsageStat>;
}

interface StoreFile {
  version: 1;
  agents: AgentUsageEntry[];
}

function addStat(into: UsageStat, u: TurnUsage): void {
  into.turns += 1;
  into.costUsd += u.costUsd;
  into.durationMs += u.durationMs;
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.cacheReadTokens += u.cacheReadTokens;
  into.cacheWriteTokens += u.cacheWriteTokens;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Prune daily keys older than 30 days from an entry (mutates). */
function pruneDays(daily: Record<string, UsageStat>): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const k of Object.keys(daily)) {
    if (k < cutoffStr) delete daily[k];
  }
}

/** Backfill entries that were saved before the `daily` field was added. */
function normalize(e: AgentUsageEntry): AgentUsageEntry {
  if (!e.daily) e.daily = {};
  return e;
}

class AgentUsageStore {
  private agents: AgentUsageEntry[] = loadJson<StoreFile>(FILE, {
    version: 1,
    agents: [],
  }).agents.map(normalize);

  private debounce?: ReturnType<typeof setTimeout>;

  private flush(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      saveJson<StoreFile>(FILE, { version: 1, agents: this.agents });
    }, 500);
  }

  record(name: string, role: AgentRole, u: TurnUsage): void {
    let entry = this.agents.find((a) => a.name === name);
    if (!entry) {
      entry = { name, role, total: zeroStat(), daily: {} };
      this.agents.push(entry);
    }
    entry.role = role; // keep role in sync if it changes
    addStat(entry.total, u);
    const day = today();
    const bucket = (entry.daily[day] ??= zeroStat());
    addStat(bucket, u);
    pruneDays(entry.daily);
    this.flush();
  }

  list(): AgentUsageEntry[] {
    return [...this.agents].sort(
      (a, b) =>
        b.total.inputTokens + b.total.outputTokens -
        (a.total.inputTokens + a.total.outputTokens),
    );
  }

  /**
   * Aggregate daily totals across all agents, grouped by role category.
   * Returns a map: role → array of { day, ...UsageStat } sorted oldest-first.
   */
  dailyByRole(): Record<AgentRole, Array<{ day: string } & UsageStat>> {
    const byRole = new Map<AgentRole, Map<string, UsageStat>>();
    for (const entry of this.agents) {
      let roleMap = byRole.get(entry.role);
      if (!roleMap) {
        roleMap = new Map();
        byRole.set(entry.role, roleMap);
      }
      for (const [day, stat] of Object.entries(entry.daily)) {
        const acc = roleMap.get(day) ?? zeroStat();
        mergeStat(acc, stat);
        roleMap.set(day, acc);
      }
    }
    const result = {} as Record<AgentRole, Array<{ day: string } & UsageStat>>;
    for (const [role, dayMap] of byRole) {
      result[role] = [...dayMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, s]) => ({ day, ...s }));
    }
    return result;
  }

  /** Flush synchronously on shutdown. */
  flushSync(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    saveJson<StoreFile>(FILE, { version: 1, agents: this.agents });
  }
}

/** Add one UsageStat into another (no turn counter increment). */
function mergeStat(into: UsageStat, from: UsageStat): void {
  into.turns += from.turns;
  into.costUsd += from.costUsd;
  into.durationMs += from.durationMs;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
}

export const agentUsage = new AgentUsageStore();
