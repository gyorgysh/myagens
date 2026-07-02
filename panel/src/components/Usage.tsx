import { useEffect, useState } from "react";
import {
  api,
  type PlanView,
  type ClaudeUsageSnapshot,
  type ProbeResult,
  type UsageLimitWindow,
  type UsageSummary,
  type AgentUsageEntry,
  type AgentDailyByRole,
  type AgentRole,
} from "../api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Card, Button, Empty, Metric } from "./ui.tsx";
import { ms, usd, tokens, relTime, friendlyProbeError } from "../lib/format.ts";
import { useSubscription } from "../lib/useSubscription.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

/** Translate the server-supplied usage-limit label when it matches a known default. */
function limitLabel(label: string, t: (k: TranslationKey) => string): string {
  if (label === "5-hour session") return t("limit_5h");
  if (label === "7-day weekly") return t("limit_7d");
  return label;
}

// ---------------------------------------------------------------------------
// Root view
// ---------------------------------------------------------------------------

export function UsageView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const { data: myagens, error } = usePoll(api.usage, 15000, onAuthError);
  const configSubscription = useSubscription();
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [claude, setClaude] = useState<ClaudeUsageSnapshot | null>(null);
  const [agentEntries, setAgentEntries] = useState<AgentUsageEntry[] | null>(null);
  const [agentDaily, setAgentDaily] = useState<AgentDailyByRole>({});
  const [probeRunning, setProbeRunning] = useState(false);

  useEffect(() => {
    api.plan().then(setPlan).catch(() => {});
    api.usageProbe().then(setProbe).catch(() => {});
    api.claudeUsage().then(setClaude).catch(() => {});
    api.usageAgents().then((r) => {
      setAgentEntries(r.agents);
      setAgentDaily(r.dailyByRole);
    }).catch(() => {});
  }, []);

  if (error) return <Empty>{error}</Empty>;

  const refreshProbe = async () => {
    setProbeRunning(true);
    await api.runProbe().catch(() => {});
    // Poll until fresh result arrives.
    let attempts = 0;
    const poll = setInterval(async () => {
      const p = await api.usageProbe().catch(() => null);
      if (p) setProbe(p);
      if (++attempts >= 15) clearInterval(poll);
    }, 2000);
    setTimeout(() => { clearInterval(poll); setProbeRunning(false); }, 30_000);
  };

  // Derive plan from probe auto-detection when available.
  const detectedPlan =
    probe?.account?.hasMax ? "Claude Max" :
    probe?.account?.hasPro ? "Claude Pro" :
    probe?.account?.subscriptionType ? capFirst(probe.account.subscriptionType) :
    null;

  // Subscription = no extra per-token cost, so hide every USD figure. Trust the
  // OAuth probe when it detects Pro/Max, and fall back to the configured plan
  // (subscriptionPlan from /api/me) so it still works when the probe is stale.
  const isSubscription = Boolean(probe?.account?.hasPro || probe?.account?.hasMax) || configSubscription;
  const hasApiCap = !isSubscription && plan && plan.monthlyCap > 0;

  return (
    <div className="space-y-4">
      {/* Live limits — real OAuth data */}
      <LiveLimitsCard
        probe={probe}
        detectedPlan={detectedPlan}
        probeRunning={probeRunning}
        onRefresh={refreshProbe}
      />

      {/* Historical activity from stats-cache */}
      {claude && <ActivityCard claude={claude} />}

      {/* Budget tracker — only for API plan with a cap set */}
      {hasApiCap && plan && (
        <Card title={t("usage_api_budget")}>
          <BudgetBar plan={plan} />
        </Card>
      )}

      {/* Token usage — real input/output tokens per turn, summed. Meaningful on
          every plan (subscription or API), so always shown when we have data. */}
      {myagens && <TokenUsageCard myagens={myagens} />}

      {/* Per-agent breakdown — always rendered so empty state is visible. */}
      <AgentBreakdownCard agents={agentEntries ?? []} dailyByRole={agentDaily} hideCost={isSubscription} />

      {/* MyAgens session metrics — cost is meaningless on a subscription plan, so omit it */}
      {myagens && (
        <>
          {isSubscription ? (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Card>
                <Metric
                  label={t("usage_turns_today")}
                  value={myagens.today.turns.toLocaleString()}
                  sub={`${myagens.total.turns.toLocaleString()} ${t("usage_turns_total")}`}
                />
              </Card>
              <Card>
                <Metric label={t("usage_time_today")} value={ms(myagens.today.durationMs)} />
              </Card>
              <Card>
                <Metric label={t("usage_time_lifetime")} value={ms(myagens.total.durationMs)} />
              </Card>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Card>
                  <Metric
                    label={t("usage_cost_today")}
                    value={usd(myagens.today.costUsd)}
                    sub={`${myagens.today.turns} ${myagens.today.turns === 1 ? t("usage_turn") : t("usage_turns")}`}
                  />
                </Card>
                <Card>
                  <Metric
                    label={t("usage_cost_lifetime")}
                    value={usd(myagens.total.costUsd)}
                    sub={`${myagens.total.turns} ${t("usage_turns_total")}`}
                  />
                </Card>
                <Card>
                  <Metric label={t("usage_time_today")} value={ms(myagens.today.durationMs)} />
                </Card>
                <Card>
                  <Metric label={t("usage_time_lifetime")} value={ms(myagens.total.durationMs)} />
                </Card>
              </div>

              <Card title={t("usage_daily_cost")}>
                <CostChart myagens={myagens} plan={plan} isSubscription={isSubscription} />
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live limits card
// ---------------------------------------------------------------------------

function barColor(s: UsageLimitWindow["severity"]): string {
  return s === "critical" ? "bg-critical" : s === "warning" ? "bg-warn" : "bg-accent";
}
function textColor(s: UsageLimitWindow["severity"]): string {
  return s === "critical" ? "text-critical-fg" : s === "warning" ? "text-warn-fg" : "text-ok-fg";
}

function formatMs(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function LimitBar({ lim }: { lim: UsageLimitWindow }) {
  const { t } = useI18n();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const resetsInMs = Math.max(0, new Date(lim.resetsAt).getTime() - Date.now());
  const pct = Math.min(100, lim.percent);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-dim">{limitLabel(lim.label, t)}</span>
        <span className={`text-2xl font-bold tabular ${textColor(lim.severity)}`}>{lim.percent}%</span>
      </div>
      <div className="h-3 w-full rounded-full bg-surface-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor(lim.severity)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-fg-faint">{lim.severity === "normal" ? t("usage_within_limits") : lim.severity}</span>
        <span className={`font-medium ${resetsInMs < 600_000 ? "text-warn-fg" : "text-fg-dim"}`}>
          {t("usage_resets_in").replace("{time}", formatMs(resetsInMs))}
        </span>
      </div>
    </div>
  );
}

function LiveLimitsCard({
  probe,
  detectedPlan,
  probeRunning,
  onRefresh,
}: {
  probe: ProbeResult | null;
  detectedPlan: string | null;
  probeRunning: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const probedAgo = probe?.probedAt
    ? Date.now() - new Date(probe.probedAt).getTime()
    : null;

  return (
    <Card
      title={t("usage_limits_title")}
      right={
        <div className="flex items-center gap-2">
          {detectedPlan && (
            <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-medium text-accent">
              {detectedPlan}
            </span>
          )}
          <Button onClick={onRefresh} disabled={probeRunning}>
            {probeRunning ? t("usage_checking") : t("usage_refresh")}
          </Button>
        </div>
      }
    >
      {!probe || probe.source === "none" ? (
        <p className="text-sm text-fg-faint">{t("usage_no_data")}</p>
      ) : probe.source === "fallback" ? (
        <p className="text-sm text-warn-fg">
          {friendlyProbeError(probe.error) ?? t("usage_oauth_unavailable")}
        </p>
      ) : probe.limits.length === 0 ? (
        <p className="text-sm text-fg-faint">{t("usage_no_active_limits")}</p>
      ) : (
        <div className="space-y-5">
          {(probe.stale || probe.error) && (
            <div className="rounded-lg border border-warn/30 bg-warn-subtle px-3 py-2 text-xs text-warn-fg">
              {friendlyProbeError(probe.error) ?? t("usage_oauth_unavailable")}
            </div>
          )}
          <div className="grid gap-6 sm:grid-cols-2">
            {probe.limits.slice(0, 2).map((lim) => (
              <LimitBar key={lim.label} lim={lim} />
            ))}
          </div>
          {probedAgo !== null && (
            <p className="text-xs text-fg-faint">
              {t("usage_updated").replace("{time}", probedAgo < 5000 ? t("usage_just_now") : relTime(new Date(probe.probedAt!).getTime()))}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Historical activity (stats-cache)
// ---------------------------------------------------------------------------

function ActivityCard({ claude }: { claude: ClaudeUsageSnapshot }) {
  const { t } = useI18n();

  return (
    <Card title={t("usage_activity_history")}>
      <div className="space-y-4">
        {/* Stat tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile
            label={claude.hasTodayData ? t("usage_messages_today") : t("usage_messages_last").replace("{date}", claude.lastRecordedDay?.date ?? "last")}
            value={(claude.lastRecordedDay?.messageCount ?? 0).toLocaleString()}
          />
          <Tile
            label={t("usage_messages_this_week")}
            value={claude.weekly.count.toLocaleString()}
          />
          <Tile
            label={t("usage_sessions_last_day")}
            value={(claude.lastRecordedDay?.sessionCount ?? 0).toLocaleString()}
          />
          <Tile
            label={t("usage_tool_calls_last_day")}
            value={(claude.lastRecordedDay?.toolCallCount ?? 0).toLocaleString()}
          />
        </div>

        {/* Lifetime footer */}
        <div className="flex flex-wrap gap-x-5 gap-y-0.5 border-t border-line pt-2 text-xs text-fg-faint">
          <span><span className="text-fg-dim font-medium">{claude.totalMessages.toLocaleString()}</span> {t("usage_total_messages")}</span>
          <span><span className="text-fg-dim font-medium">{claude.totalSessions.toLocaleString()}</span> {t("usage_sessions")}</span>
          {claude.firstSessionDate && (
            <span>{t("usage_since").replace("{date}", new Date(claude.firstSessionDate).toLocaleDateString())}</span>
          )}
          {!claude.hasTodayData && (
            <span className="ml-auto italic">{t("usage_stats_update")}</span>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Budget bar (API plan only)
// ---------------------------------------------------------------------------

function BudgetBar({ plan }: { plan: PlanView }) {
  const { t } = useI18n();
  const pct = Math.min(100, plan.pctUsed);
  const color = plan.pctUsed >= 90 ? "bg-critical" : plan.pctUsed >= 70 ? "bg-warn" : "bg-ok";
  const tcolor = plan.pctUsed >= 90 ? "text-critical-fg" : plan.pctUsed >= 70 ? "text-warn-fg" : "text-ok-fg";

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className={`text-2xl font-semibold tabular ${tcolor}`}>${plan.periodCostUsd.toFixed(2)}</span>
        <span className="text-xs text-fg-faint">{t("usage_of_cap").replace("{cap}", String(plan.monthlyCap)).replace("{pct}", plan.pctUsed.toFixed(0))}</span>
        <span className="ml-auto text-xs text-fg-faint">{t("usage_until_reset").replace("{n}", String(plan.daysUntilReset))}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex gap-4 text-xs text-fg-faint">
        <span>{t("usage_avg_day")}: ${plan.dailyAvgUsd.toFixed(4)}</span>
        <span>{t("usage_est_month")}: ${plan.estimatedMonthlyUsd.toFixed(2)}</span>
        {plan.periodStart && <span>{t("usage_since_label")}: {plan.periodStart}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily cost chart
// ---------------------------------------------------------------------------

function CostChart({
  myagens,
  plan,
  isSubscription,
}: {
  myagens: { daily: Array<{ day: string; costUsd: number; turns: number }> };
  plan: PlanView | null;
  isSubscription: boolean;
}) {
  const { t } = useI18n();
  const recent = myagens.daily.slice(-30);
  const maxCost = Math.max(0.0001, ...recent.map((d) => d.costUsd));
  const periodStart = plan?.periodStart;

  if (recent.length === 0) return <Empty>{t("usage_no_activity")}</Empty>;

  return (
    <div className="relative flex h-40 items-end gap-1">
      {!isSubscription && plan && plan.monthlyCap > 0 && (() => {
        const dailyCap = plan.monthlyCap / 30;
        const capPct = (dailyCap / maxCost) * 100;
        if (capPct > 100) return null;
        return (
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-critical/40"
            style={{ bottom: `${capPct}%` }}
            title={`Daily cap ceiling: $${dailyCap.toFixed(4)}`}
          />
        );
      })()}
      {recent.map((d) => {
        const inPeriod = periodStart ? d.day >= periodStart : true;
        return (
          <div key={d.day} className="group flex h-full flex-1 flex-col items-center justify-end">
            <div
              className={`w-full rounded-t transition-all ${
                inPeriod ? "bg-accent/70 group-hover:bg-accent" : "bg-fg-faint/20 group-hover:bg-fg-faint/40"
              }`}
              style={{ height: `${(d.costUsd / maxCost) * 100}%` }}
              title={`${d.day}: ${usd(d.costUsd)} · ${d.turns} ${t("usage_turns")}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-agent token breakdown (grouped by category)
// ---------------------------------------------------------------------------

/** Display order and labels for the role categories. */
const CATEGORIES: Array<{ role: AgentRole; label: string; color: string }> = [
  { role: "atlas",     label: "Atlas",       color: "bg-accent/70" },
  { role: "lead",      label: "Leads",       color: "bg-blue-500/70" },
  { role: "worker",    label: "Workers",     color: "bg-zinc-400/70" },
  { role: "task",      label: "Tasks",       color: "bg-emerald-400/70" },
  { role: "schedule",  label: "Schedules",   color: "bg-amber-400/70" },
  { role: "agentchat", label: "Agent Chat",  color: "bg-rose-400/70" },
];

function sumAgents(agents: AgentUsageEntry[]) {
  const s = { turns: 0, costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const a of agents) {
    s.turns += a.total.turns;
    s.costUsd += a.total.costUsd;
    s.durationMs += a.total.durationMs;
    s.inputTokens += a.total.inputTokens;
    s.outputTokens += a.total.outputTokens;
    s.cacheReadTokens += a.total.cacheReadTokens;
    s.cacheWriteTokens += a.total.cacheWriteTokens;
  }
  return s;
}

function AgentBreakdownCard({
  agents,
  dailyByRole,
  hideCost,
}: {
  agents: AgentUsageEntry[];
  dailyByRole: AgentDailyByRole;
  hideCost: boolean;
}) {
  const { t } = useI18n();

  if (agents.length === 0)
    return (
      <Card title={t("usage_agents_title")}>
        <p className="text-sm text-fg-faint">{t("usage_agents_no_data")}</p>
      </Card>
    );

  // Group agents by role, keeping only categories that have data.
  const grouped = CATEGORIES.map((cat) => ({
    ...cat,
    agents: agents.filter((a) => a.role === cat.role),
  })).filter((g) => g.agents.length > 0);

  // Drop the cost column entirely on subscription plans (no marginal API cost).
  // Narrower fixed columns below sm so the 1fr name column stays readable on
  // a 390px phone (the values are short mono numbers; they fit the tight tier).
  const COL = hideCost
    ? "grid grid-cols-[1fr_60px_60px_44px] gap-2 px-1 sm:grid-cols-[1fr_80px_80px_52px]"
    : "grid grid-cols-[1fr_56px_56px_48px_40px] gap-1.5 px-1 sm:grid-cols-[1fr_80px_80px_72px_52px] sm:gap-2";

  return (
    <Card title={t("usage_agents_title")}>
      <div className="space-y-5">
        {/* All-categories stacked daily token chart — always shown; AgentTokenChart handles its own empty state */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-fg-dim">
              {t("usage_tokens_per_day")}
            </p>
            <div className="flex flex-wrap items-center gap-3 text-xs text-fg-faint">
              {grouped.map((g) => (
                <span key={g.role} className="flex items-center gap-1">
                  <span className={`inline-block h-2 w-2 rounded-sm ${g.color}`} />
                  {g.label}
                </span>
              ))}
            </div>
          </div>
          <AgentTokenChart dailyByRole={dailyByRole} />
        </div>

        {/* Per-category tables */}
        {grouped.map((cat) => {
          const sub = sumAgents(cat.agents);
          return (
            <div key={cat.role}>
              {/* Category header with subtotal */}
              <div className={`${COL} mb-0.5 text-xs font-semibold uppercase tracking-wider`}>
                <span className="flex items-center gap-1.5 text-fg-dim">
                  <span className={`inline-block h-2 w-2 rounded-sm ${cat.color}`} />
                  {cat.label}
                </span>
                <span className="text-right font-mono text-fg-dim">{tokens(sub.inputTokens)}</span>
                <span className="text-right font-mono text-fg-dim">{tokens(sub.outputTokens)}</span>
                {!hideCost && (
                  <span className="text-right font-mono text-fg-dim">
                    {sub.costUsd > 0 ? usd(sub.costUsd) : "—"}
                  </span>
                )}
                <span className="text-right font-mono text-fg-dim">{sub.turns}</span>
              </div>

              {/* Column header (only shown once per group when >1 agent) */}
              {cat.agents.length > 1 && (
                <div className={`${COL} mb-0.5 text-xs text-fg-faint`}>
                  <span className="pl-3">{t("usage_agents_col_agent")}</span>
                  <span className="text-right">{t("usage_agents_col_input")}</span>
                  <span className="text-right">{t("usage_agents_col_output")}</span>
                  {!hideCost && <span className="text-right">{t("usage_agents_col_cost")}</span>}
                  <span className="text-right">{t("usage_agents_col_turns")}</span>
                </div>
              )}

              {/* Agent rows */}
              {cat.agents.length > 1 && cat.agents.map((a) => (
                <div
                  key={a.name}
                  className={`${COL} rounded py-0.5 text-sm even:bg-surface/40`}
                >
                  <span className="truncate pl-3 text-fg-dim">{a.name}</span>
                  <span className="text-right font-mono text-xs text-fg-faint">{tokens(a.total.inputTokens)}</span>
                  <span className="text-right font-mono text-xs text-fg-faint">{tokens(a.total.outputTokens)}</span>
                  {!hideCost && (
                    <span className="text-right font-mono text-xs text-fg-faint">
                      {a.total.costUsd > 0 ? usd(a.total.costUsd) : "—"}
                    </span>
                  )}
                  <span className="text-right font-mono text-xs text-fg-faint">{a.total.turns}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Stacked daily bar chart for all agent categories. Each bar is segmented by
 * role category (Atlas at bottom, then Leads, Workers, Tasks, Schedules,
 * Agent Chat at top). Height represents total input+output tokens that day.
 */
function AgentTokenChart({ dailyByRole }: { dailyByRole: AgentDailyByRole }) {
  const { t } = useI18n();
  // Collect all days across all roles, union them.
  const daySet = new Set<string>();
  for (const series of Object.values(dailyByRole)) {
    for (const d of series ?? []) daySet.add(d.day);
  }
  const days = [...daySet].sort();
  const recent = days.slice(-30);

  if (recent.length === 0) {
    // Ghost skeleton matching the TokenChart empty state style.
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="relative flex h-20 w-full items-end gap-0.5 opacity-20">
          {[35, 55, 40, 70, 45, 30, 60, 80, 50, 65, 45, 55, 40, 75, 60, 35, 50, 65, 45, 70, 55, 40, 60, 80, 50, 65, 45, 55, 70, 60].map((h, i) => (
            <div key={i} className="flex flex-1 flex-col justify-end">
              <div className="w-full rounded-t bg-fg-dim" style={{ height: `${h}%` }} />
            </div>
          ))}
        </div>
        <p className="text-xs text-fg-faint">{t("usage_chart_empty_title")}</p>
      </div>
    );
  }

  if (recent.length === 1) {
    // Single day: show it centred with a label, skip the full bar chart.
    const day = recent[0];
    const colorMap = Object.fromEntries(CATEGORIES.map((c) => [c.role, c.color]));
    const slices = CATEGORIES.map((cat) => {
      const entry = (dailyByRole[cat.role] ?? []).find((d) => d.day === day);
      return { role: cat.role, tokens: (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0) };
    }).filter((s) => s.tokens > 0);
    const dayTotal = slices.reduce((s, x) => s + x.tokens, 0);
    return (
      <div className="flex flex-col items-center gap-1 py-2">
        <div className="flex h-20 w-12 flex-col justify-end overflow-hidden rounded-t">
          {slices.map((s) => {
            const pct = dayTotal > 0 ? (s.tokens / dayTotal) * 100 : 0;
            const base = colorMap[s.role] ?? "bg-fg-faint/30";
            return <div key={s.role} className={`w-full ${base}`} style={{ height: `${pct}%` }} />;
          })}
        </div>
        <p className="text-xs text-fg-faint">{day}</p>
        <p className="text-xs text-fg-faint">{tokens(dayTotal)}</p>
        <p className="text-center text-xs text-fg-faint">{t("usage_chart_today_hint")}</p>
      </div>
    );
  }

  // For each day, compute total tokens per role.
  type DaySlice = { day: string; slices: Array<{ role: AgentRole; tokens: number }> };
  const rows: DaySlice[] = recent.map((day) => ({
    day,
    slices: CATEGORIES.map((cat) => {
      const entry = (dailyByRole[cat.role] ?? []).find((d) => d.day === day);
      return { role: cat.role, tokens: (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0) };
    }).filter((s) => s.tokens > 0),
  }));

  const maxTotal = Math.max(1, ...rows.map((r) => r.slices.reduce((s, x) => s + x.tokens, 0)));
  const colorMap = Object.fromEntries(CATEGORIES.map((c) => [c.role, c.color]));

  return (
    <div className="relative flex h-40 items-end gap-1">
      {rows.map((row) => {
        const total = row.slices.reduce((s, x) => s + x.tokens, 0);
        const totalPct = (total / maxTotal) * 100;
        const tip = row.slices.map((s) => `${CATEGORIES.find((c) => c.role === s.role)?.label}: ${tokens(s.tokens)}`).join(" | ");
        return (
          <div key={row.day} className="group flex h-full flex-1 flex-col items-center justify-end">
            <div
              className="flex w-full flex-col-reverse justify-end overflow-hidden rounded-t"
              style={{ height: `${totalPct}%` }}
              title={`${row.day}: ${tokens(total)} — ${tip}`}
            >
              {row.slices.map((s) => {
                const pct = total > 0 ? (s.tokens / total) * 100 : 0;
                const base = colorMap[s.role] ?? "bg-fg-faint/30";
                const hover = base.replace("/70", "");
                return (
                  <div
                    key={s.role}
                    className={`w-full transition-all ${base} group-hover:${hover}`}
                    style={{ height: `${pct}%` }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token usage (real input/output tokens per turn, summed)
// ---------------------------------------------------------------------------

function TokenUsageCard({ myagens }: { myagens: UsageSummary }) {
  const { t } = useI18n();
  const hasTokens =
    myagens.total.inputTokens > 0 ||
    myagens.total.outputTokens > 0 ||
    myagens.total.cacheReadTokens > 0 ||
    myagens.total.cacheWriteTokens > 0;

  return (
    <Card title={t("usage_tokens_title")}>
      {!hasTokens ? (
        <p className="text-sm text-fg-faint">{t("usage_tokens_no_data")}</p>
      ) : (
        <div className="space-y-4">
          {/* Today vs lifetime input/output/cache breakdown */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              label={`${t("usage_tokens_input")} · ${t("usage_tokens_today")}`}
              value={tokens(myagens.today.inputTokens)}
            />
            <Tile
              label={`${t("usage_tokens_output")} · ${t("usage_tokens_today")}`}
              value={tokens(myagens.today.outputTokens)}
            />
            <Tile
              label={`${t("usage_tokens_input")} · ${t("usage_tokens_lifetime")}`}
              value={tokens(myagens.total.inputTokens)}
            />
            <Tile
              label={`${t("usage_tokens_output")} · ${t("usage_tokens_lifetime")}`}
              value={tokens(myagens.total.outputTokens)}
            />
          </div>

          {/* Cache footer — useful to see how much is served from cache */}
          <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-xs text-fg-faint">
            <span>
              <span className="font-medium text-fg-dim">{tokens(myagens.total.cacheReadTokens)}</span>{" "}
              {t("usage_tokens_cache_read")}
            </span>
            <span>
              <span className="font-medium text-fg-dim">{tokens(myagens.total.cacheWriteTokens)}</span>{" "}
              {t("usage_tokens_cache_write")}
            </span>
          </div>

          {/* Daily input vs output chart */}
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-dim">
                {t("usage_tokens_per_day")}
              </p>
              <div className="flex items-center gap-3 text-xs text-fg-faint">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm bg-accent/70" />
                  {t("usage_tokens_legend_input")}
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400/70" />
                  {t("usage_tokens_legend_output")}
                </span>
              </div>
            </div>
            <TokenChart myagens={myagens} />
            <p className="text-xs text-fg-faint">{t("usage_tokens_in_out")}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Stacked daily bar chart of input (bottom) + output (top) tokens per day. */
function TokenChart({ myagens }: { myagens: UsageSummary }) {
  const { t } = useI18n();
  const recent = myagens.daily.slice(-30);
  const max = Math.max(1, ...recent.map((d) => d.inputTokens + d.outputTokens));

  const todayIn = myagens.today.inputTokens;
  const todayOut = myagens.today.outputTokens;
  const todayTotal = todayIn + todayOut;

  // No finalized days at all — clean empty state.
  if (recent.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        {/* "Today so far" callout when there is activity today */}
        {todayTotal > 0 && (
          <div className="flex w-full items-center gap-4 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                {t("usage_chart_today_label")}
              </p>
              <p className="mt-0.5 text-xl font-bold tabular text-fg">
                {tokens(todayTotal)}
              </p>
              <p className="text-xs text-fg-dim">
                {tokens(todayIn)} {t("usage_tokens_legend_input")} · {tokens(todayOut)} {t("usage_tokens_legend_output")}
              </p>
            </div>
            {/* Mini single-bar preview */}
            <div className="flex h-12 w-6 flex-shrink-0 flex-col justify-end overflow-hidden rounded">
              <div className="w-full rounded-t bg-emerald-400/60" style={{ height: `${todayTotal > 0 ? (todayOut / todayTotal) * 100 : 0}%` }} />
              <div className="w-full bg-accent/60" style={{ height: `${todayTotal > 0 ? (todayIn / todayTotal) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {/* Placeholder bars (ghost skeleton) */}
        <div className="relative flex h-24 w-full items-end gap-0.5 opacity-20">
          {[35, 55, 40, 70, 45, 30, 60, 80, 50, 65, 45, 55, 40, 75, 60, 35, 50, 65, 45, 70, 55, 40, 60, 80, 50, 65, 45, 55, 70, 60].map((h, i) => (
            <div key={i} className="flex flex-1 flex-col justify-end">
              <div className="w-full rounded-t bg-fg-dim" style={{ height: `${h}%` }} />
            </div>
          ))}
        </div>
        <p className="text-center text-xs font-medium text-fg-dim">{t("usage_chart_empty_title")}</p>
        <p className="max-w-xs text-center text-xs text-fg-faint">{t("usage_chart_empty_desc")}</p>
      </div>
    );
  }

  // Single finalized day — show a "today so far" callout + the one bar, labelled.
  if (recent.length === 1) {
    const d = recent[0];
    const total = d.inputTokens + d.outputTokens;
    const inPct  = total > 0 ? (d.inputTokens  / total) * 100 : 0;
    const outPct = total > 0 ? (d.outputTokens / total) * 100 : 0;
    return (
      <div className="space-y-3">
        {todayTotal > 0 && (
          <div className="flex items-center gap-4 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                {t("usage_chart_today_label")}
              </p>
              <p className="mt-0.5 text-xl font-bold tabular text-fg">{tokens(todayTotal)}</p>
              <p className="text-xs text-fg-dim">
                {tokens(todayIn)} {t("usage_tokens_legend_input")} · {tokens(todayOut)} {t("usage_tokens_legend_output")}
              </p>
            </div>
            <div className="flex h-12 w-6 flex-shrink-0 flex-col justify-end overflow-hidden rounded">
              <div className="w-full rounded-t bg-emerald-400/60" style={{ height: `${todayTotal > 0 ? (todayOut / todayTotal) * 100 : 0}%` }} />
              <div className="w-full bg-accent/60" style={{ height: `${todayTotal > 0 ? (todayIn / todayTotal) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {/* Single-bar chart with a date label underneath */}
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-24 w-12 flex-col justify-end overflow-hidden rounded-t">
            <div className="w-full bg-emerald-400/70" style={{ height: `${outPct}%` }} />
            <div className="w-full bg-accent/70" style={{ height: `${inPct}%` }} />
          </div>
          <p className="text-xs text-fg-faint">{d.day}</p>
          <p className="text-xs text-fg-faint">{tokens(total)}</p>
        </div>
        <p className="text-center text-xs text-fg-faint">{t("usage_chart_today_hint")}</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-40 items-end gap-1">
      {recent.map((d) => {
        const total = d.inputTokens + d.outputTokens;
        const totalPct = (total / max) * 100;
        // Within the bar, split the height between input and output.
        const inPct = total > 0 ? (d.inputTokens / total) * 100 : 0;
        const outPct = total > 0 ? (d.outputTokens / total) * 100 : 0;
        return (
          <div key={d.day} className="group flex h-full flex-1 flex-col items-center justify-end">
            <div
              className="flex w-full flex-col justify-end overflow-hidden rounded-t"
              style={{ height: `${totalPct}%` }}
              title={`${d.day}: ${tokens(d.inputTokens)} ${t("usage_tokens_legend_input")} · ${tokens(d.outputTokens)} ${t("usage_tokens_legend_output")}`}
            >
              <div
                className="w-full bg-emerald-400/70 transition-all group-hover:bg-emerald-400"
                style={{ height: `${outPct}%` }}
              />
              <div
                className="w-full bg-accent/70 transition-all group-hover:bg-accent"
                style={{ height: `${inPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-input p-3">
      <p className="text-xs uppercase tracking-wide text-fg-faint">{label}</p>
      <p className="mt-1 text-xl font-bold tabular text-fg">{value}</p>
    </div>
  );
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
