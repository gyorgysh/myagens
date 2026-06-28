import { sessions } from "../session/manager.js";
import type { Autonomy } from "../session/manager.js";
import { schedules } from "../schedule/manager.js";
import { describeSpec, specToWhen } from "../schedule/manager.js";
import { zeroStat, type UsageStat } from "../session/store.js";

/** Panel-facing view of one chat session (no abort controllers / secrets). */
export interface SessionView {
  chatId: number;
  cwd: string;
  autonomy: Autonomy;
  busy: boolean;
  hasContext: boolean;
  projects: string[];
  allowedTools: string[];
  allowedBashCmds: string[];
  usage: { total: UsageStat; today: UsageStat };
}

/** Panel-facing view of one schedule. */
export interface ScheduleView {
  id: string;
  chatId: number;
  cwd: string;
  prompt: string;
  spec: string;
  specRaw: string;
  nextRunAt: number;
  lastRunAt?: number;
  createdAt: number;
  enabled: boolean;
  webhookUrl?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function listSessions(): SessionView[] {
  const day = today();
  return sessions.all().map((s) => ({
    chatId: s.chatId,
    cwd: s.cwd,
    autonomy: s.autonomy,
    busy: s.busy,
    hasContext: Boolean(s.sessionId),
    projects: s.projects,
    allowedTools: [...s.sessionAllowedTools],
    allowedBashCmds: [...s.allowedBashCmds],
    usage: { total: s.usage.total, today: s.usage.daily[day] ?? zeroStat() },
  }));
}

export function listSchedules(): ScheduleView[] {
  return schedules.all().map((s) => ({
    id: s.id,
    chatId: s.chatId,
    cwd: s.cwd,
    prompt: s.prompt,
    spec: describeSpec(s.spec),
    specRaw: specToWhen(s.spec),
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    createdAt: s.createdAt,
    enabled: s.enabled !== false,
    webhookUrl: s.webhookUrl,
  }));
}

/** Aggregate usage across all sessions: lifetime totals + today + a daily series. */
export function usageSummary(): {
  total: UsageStat;
  today: UsageStat;
  daily: Array<{ day: string } & UsageStat>;
} {
  const day = today();
  const total: UsageStat = zeroStat();
  const todayStat: UsageStat = zeroStat();
  const byDay = new Map<string, UsageStat>();

  for (const s of sessions.all()) {
    add(total, s.usage.total);
    add(todayStat, s.usage.daily[day] ?? zeroStat());
    for (const [d, stat] of Object.entries(s.usage.daily)) {
      const acc = byDay.get(d) ?? zeroStat();
      add(acc, stat);
      byDay.set(d, acc);
    }
  }

  const daily = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stat]) => ({ day, ...stat }));

  return { total, today: todayStat, daily };
}

function add(into: UsageStat, from: UsageStat): void {
  into.turns += from.turns;
  into.costUsd += from.costUsd;
  into.durationMs += from.durationMs;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
}
