import { useEffect, useState } from "react";
import { api, AuthError, type MemoryEntry, type MemoryStats, type MemoryTier } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { toast } from "../lib/useToast.ts";
import { useListAnimate } from "../lib/useListAnimate.ts";
import { relTime } from "../lib/format.ts";
import { Badge, Button, Callout, Card, Empty, InfoCard, Input, Label, Skeleton, TextArea } from "./ui.tsx";
import { MemoryArt } from "./onboarding.tsx";
import { Flame, Thermometer, Snowflake, type LucideIcon } from "lucide-react";

const blank = { text: "", tags: "", salience: 0.5, tier: "warm" as MemoryTier };

const TIER_TONE = {
  hot: "amber" as const,
  warm: "blue" as const,
  cold: "zinc" as const,
};

const TIER_KEY = { hot: "memory_tier_hot", warm: "memory_tier_warm", cold: "memory_tier_cold" } as const;

const TIER_ICON: Record<MemoryTier, LucideIcon> = {
  hot: Flame,
  warm: Thermometer,
  cold: Snowflake,
};

/** A tier badge with its Lucide glyph, used wherever a tier is shown as a chip. */
function TierBadge({ tier, label }: { tier: MemoryTier; label: string }) {
  const Icon = TIER_ICON[tier];
  return (
    <Badge tone={TIER_TONE[tier]}>
      <Icon size={11} className="mr-1" />
      {label}
    </Badge>
  );
}

type TierFilter = "all" | MemoryTier;

export function MemoryView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof blank>(blank);
  const [error, setError] = useState<string | null>(null);
  const [listRef] = useListAnimate();

  // The unfiltered list endpoint already returns every tier (incl. cold); the
  // `all` flag only widens *search* to cold entries. So only ask for cold when
  // searching and the active filter could include cold.
  const wantCold = tierFilter === "cold" || tierFilter === "all";

  const loadStats = () =>
    api
      .memoryStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setStatsLoaded(true));

  const load = (q?: string) =>
    api
      .memories(q, q ? wantCold : false)
      .then((r) => {
        const filtered =
          tierFilter === "all"
            ? r.memories
            : r.memories.filter((m) => m.tier === tierFilter);
        setEntries(filtered);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(query.trim() || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tierFilter]);

  const startNew = () => {
    setForm(blank);
    setEditing("new");
  };
  const startEdit = (m: MemoryEntry) => {
    setForm({ text: m.text, tags: m.tags.join(", "), salience: m.salience, tier: m.tier });
    setEditing(m.id);
  };

  // Insert/update a single entry into local state, honouring the active tier
  // filter and search query (drop it if it no longer matches the filter).
  const reconcile = (saved: MemoryEntry) => {
    setEntries((prev) => {
      const matches = tierFilter === "all" || saved.tier === tierFilter;
      const idx = prev.findIndex((m) => m.id === saved.id);
      if (idx === -1) return matches ? [saved, ...prev] : prev;
      if (!matches) return prev.filter((m) => m.id !== saved.id);
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
  };

  const save = async () => {
    const payload = {
      text: form.text,
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      salience: form.salience,
      tier: form.tier,
    };
    const wasEditing = editing;
    try {
      const saved =
        wasEditing === "new"
          ? await api.createMemory(payload)
          : await api.updateMemory(wasEditing!, payload);
      reconcile(saved);
      setEditing(null);
      // Stats (counts/tier distribution) can shift on save; refresh quietly.
      void loadStats();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const setTier = async (id: string, tier: MemoryTier) => {
    const prev = entries;
    const entry = entries.find((m) => m.id === id);
    if (!entry) return;
    const oldTier = entry.tier;
    // Optimistically move the entry to its new tier; if the active filter no
    // longer matches, drop it from the visible list.
    setEntries((cur) => {
      const updated = cur.map((m) => (m.id === id ? { ...m, tier } : m));
      return tierFilter === "all" ? updated : updated.filter((m) => m.tier === tierFilter);
    });
    setStats((s) =>
      s
        ? { ...s, byTier: { ...s.byTier, [oldTier]: s.byTier[oldTier] - 1, [tier]: s.byTier[tier] + 1 } }
        : s,
    );
    try {
      await api.setMemoryTier(id, tier);
    } catch (e) {
      setEntries(prev);
      setStats((s) =>
        s
          ? { ...s, byTier: { ...s.byTier, [oldTier]: s.byTier[oldTier] + 1, [tier]: s.byTier[tier] - 1 } }
          : s,
      );
      if (e instanceof AuthError) onAuthError();
    }
  };

  const del = (id: string) => {
    const prev = entries;
    const prevStats = stats;
    const entry = entries.find((m) => m.id === id);
    // Optimistically remove the row and adjust the counters, then open a 5s
    // undo window. The server delete only fires once the window closes; undo
    // restores the prior list + stats. Nothing is deleted server-side yet.
    setEntries((cur) => cur.filter((m) => m.id !== id));
    if (entry) {
      setStats((s) =>
        s
          ? { ...s, total: s.total - 1, byTier: { ...s.byTier, [entry.tier]: s.byTier[entry.tier] - 1 } }
          : s,
      );
    }
    toast.undo(t("deleted"), {
      undoLabel: t("toast_undo"),
      onUndo: () => {
        setEntries(prev);
        setStats(prevStats);
      },
      onCommit: async () => {
        try {
          await api.deleteMemory(id);
        } catch (e) {
          // Commit failed: restore the row + stats and surface the error.
          setEntries(prev);
          setStats(prevStats);
          if (e instanceof AuthError) return onAuthError();
          setError(String(e));
        }
      },
    });
  };

  return (
    <Card
      title={t("memory_title")}
      right={
        editing ? null : (
          <Button variant="primary" onClick={startNew}>
            {t("memory_new")}
          </Button>
        )
      }
    >
      <div className="mb-4 space-y-3">
        <InfoCard id="memory" title={t("info_memory_title")} body={t("info_memory_body")}>
          <ul className="space-y-1.5">
            <li className="flex items-start gap-1.5">
              <Flame size={13} className="mt-0.5 shrink-0 text-warn-fg" />
              <span>{t("info_memory_hot")}</span>
            </li>
            <li className="flex items-start gap-1.5">
              <Thermometer size={13} className="mt-0.5 shrink-0 text-accent" />
              <span>{t("info_memory_warm")}</span>
            </li>
            <li className="flex items-start gap-1.5">
              <Snowflake size={13} className="mt-0.5 shrink-0 text-fg-dim" />
              <span>{t("info_memory_cold")}</span>
            </li>
            <li>{t("info_memory_salience")}</li>
          </ul>
        </InfoCard>
        <Callout title={t("memory_tip_title")} dismissId="memory-recall">
          {t("memory_tip_body")}
        </Callout>
      </div>

      {!statsLoaded && (
        <div className="mb-4 overflow-hidden rounded-lg border border-line bg-line">
          <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1.5 bg-input px-3 py-2.5">
                <Skeleton className="h-5 w-10" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            ))}
          </div>
        </div>
      )}

      {stats && stats.total > 0 && (
        <div className="mb-4">
          <TierBar stats={stats} />
        </div>
      )}

      {stats && (
        <div className="mb-4 overflow-hidden rounded-lg border border-line bg-line">
          <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
            <Stat label={t("memory_stat_total")} value={stats.total} />
            <Stat label={t("memory_stat_recalls")} value={stats.totalRecalls} />
            <Stat label={t("memory_stat_recalled")} value={`${stats.recalledCount}/${stats.total}`} />
            <Stat label={t("memory_stat_tags")} value={stats.tagCount} />
            <Stat label={t("memory_tier_hot")} value={stats.byTier.hot} />
            <Stat label={t("memory_tier_warm")} value={stats.byTier.warm} />
            <Stat label={t("memory_tier_cold")} value={stats.byTier.cold} />
            <Stat label={t("memory_stat_embedded")} value={`${stats.embedded}/${stats.total}`} />
          </div>
          {stats.lastRecalledAt && (
            <div className="mt-px flex items-center justify-between gap-3 bg-input px-3 py-2 text-xs">
              <span className="text-fg-faint">{t("memory_stat_last_recall")}</span>
              <span className="text-fg-dim tabular">{relTime(stats.lastRecalledAt)}</span>
            </div>
          )}
        </div>
      )}

      {error && <p className="mb-2 text-sm text-critical-fg">{error}</p>}

      {editing && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div>
            <Label>{t("memory_fact")}</Label>
            <TextArea
              rows={2}
              value={form.text}
              onChange={(e) => setForm({ ...form, text: e.target.value })}
              placeholder={t("memory_fact_placeholder")}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("memory_tags")}</Label>
              <Input
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder={t("memory_tags_placeholder")}
              />
            </div>
            <div>
              <Label>{t("memory_salience")}: {form.salience.toFixed(2)}</Label>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-fg-faint">{t("memory_salience_low")}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={form.salience}
                  onChange={(e) => setForm({ ...form, salience: Number(e.target.value) })}
                  className="flex-1 accent-[var(--accent)]"
                />
                <span className="text-xs text-fg-faint">{t("memory_salience_high")}</span>
              </div>
              <p className="mt-1 text-xs text-fg-faint">{t("memory_salience_hint")}</p>
            </div>
          </div>
          <div>
            <Label>{t("memory_tier")}</Label>
            <div className="flex gap-2 mt-1">
              {(["hot", "warm", "cold"] as MemoryTier[]).map((tier) => {
                const Icon = TIER_ICON[tier];
                return (
                  <button
                    key={tier}
                    onClick={() => setForm({ ...form, tier })}
                    className={`inline-flex min-h-[44px] items-center gap-1 rounded px-2.5 text-xs font-medium transition-colors ${
                      form.tier === tier
                        ? "bg-[var(--accent)] text-white"
                        : "border border-line text-fg-dim hover:text-fg"
                    }`}
                  >
                    <Icon size={12} />
                    {t(TIER_KEY[tier])}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={!form.text.trim()}>
              {t("save")}
            </Button>
            <Button onClick={() => setEditing(null)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      <div className="mb-3 space-y-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("memory_search")}
          className="w-full"
        />
        <div className="flex flex-wrap gap-1.5">
          {(["all", "hot", "warm", "cold"] as TierFilter[]).map((f) => {
            const count =
              f === "all" ? stats?.total : stats?.byTier[f];
            const label = f === "all" ? t("memory_filter_all") : t(TIER_KEY[f]);
            const Icon = f === "all" ? null : TIER_ICON[f];
            return (
              <button
                key={f}
                onClick={() => setTierFilter(f)}
                className={`inline-flex min-h-[44px] items-center gap-1 rounded px-2.5 text-xs border border-line transition-colors ${
                  tierFilter === f
                    ? "bg-[var(--accent)] text-white"
                    : "text-fg-dim hover:text-fg"
                }`}
              >
                {Icon && <Icon size={12} />}
                {label}
                {count !== undefined && <span className="ml-1 tabular opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {entries.length === 0 && !editing ? (
        query ? (
          <Empty>{t("memory_empty_query")}</Empty>
        ) : (
          <Empty
            icon={<MemoryArt />}
            title={t("memory_empty")}
            action={
              <Button variant="primary" onClick={startNew}>
                {t("memory_new")}
              </Button>
            }
          >
            {t("memory_empty_desc")}
          </Empty>
        )
      ) : (
        <div ref={listRef} className="space-y-2">
          {entries.map((m) => (
            <div
              key={m.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line p-3"
            >
              <div className="min-w-0">
                <p className="text-sm text-fg">{m.text}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-faint">
                  <TierBadge tier={m.tier} label={t(TIER_KEY[m.tier])} />
                  {m.tags.map((tag) => (
                    <Badge key={tag} tone="blue">
                      {tag}
                    </Badge>
                  ))}
                  <span className="tabular">{t("memory_salience").toLowerCase()} {m.salience.toFixed(2)}</span>
                  {m.useCount > 0 && <span className="tabular">· {t("memory_recalled")} {m.useCount}×</span>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-fg-faint">{t("memory_move_to")}</span>
                  {(["hot", "warm", "cold"] as MemoryTier[])
                    .filter((tier) => tier !== m.tier)
                    .map((tier) => {
                      const Icon = TIER_ICON[tier];
                      return (
                        <button
                          key={tier}
                          onClick={() => setTier(m.id, tier)}
                          aria-label={t("memory_move_to_tier").replace("{tier}", t(TIER_KEY[tier]))}
                          className="inline-flex min-h-[44px] items-center gap-1 rounded-full border border-line px-2 text-xs font-medium text-fg-dim hover:border-accent/40 hover:bg-accent/5 hover:text-accent transition-colors"
                        >
                          <Icon size={11} />
                          {t(TIER_KEY[tier])}
                        </button>
                      );
                    })}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button onClick={() => startEdit(m)}>{t("edit")}</Button>
                <Button variant="danger" onClick={() => del(m.id)}>
                  {t("delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col gap-1 bg-input px-3 py-2.5">
      <span className="text-lg font-semibold leading-none text-fg tabular">{value}</span>
      <span className="truncate text-xs uppercase tracking-wide text-fg-faint">{label}</span>
    </div>
  );
}

/** Compact stacked bar showing the hot/warm/cold tier distribution. */
function TierBar({ stats }: { stats: MemoryStats }) {
  const { t } = useI18n();
  const total = stats.total || 1;
  const segs: Array<{ tier: MemoryTier; count: number; cls: string }> = [
    { tier: "hot", count: stats.byTier.hot, cls: "bg-warn" },
    { tier: "warm", count: stats.byTier.warm, cls: "bg-blue-500" },
    { tier: "cold", count: stats.byTier.cold, cls: "bg-zinc-500" },
  ];
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line">
        {segs.map((s) =>
          s.count > 0 ? (
            <div
              key={s.tier}
              className={s.cls}
              style={{ width: `${(s.count / total) * 100}%` }}
              title={`${t(TIER_KEY[s.tier])}: ${s.count}`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-faint">
        {segs.map((s) => (
          <span key={s.tier} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${s.cls}`} />
            {t(TIER_KEY[s.tier])}
            <span className="tabular text-fg-dim">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
