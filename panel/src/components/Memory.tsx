import { useEffect, useState } from "react";
import { api, AuthError, type MemoryEntry, type MemoryStats, type MemoryTier } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { relTime } from "../lib/format.ts";
import { Badge, Button, Callout, Card, Empty, Input, Label, TextArea } from "./ui.tsx";

const blank = { text: "", tags: "", salience: 0.5, tier: "warm" as MemoryTier };

const TIER_TONE = {
  hot: "amber" as const,
  warm: "blue" as const,
  cold: "zinc" as const,
};

const TIER_KEY = { hot: "memory_tier_hot", warm: "memory_tier_warm", cold: "memory_tier_cold" } as const;

type TierFilter = "all" | MemoryTier;

export function MemoryView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof blank>(blank);
  const [error, setError] = useState<string | null>(null);

  // The unfiltered list endpoint already returns every tier (incl. cold); the
  // `all` flag only widens *search* to cold entries. So only ask for cold when
  // searching and the active filter could include cold.
  const wantCold = tierFilter === "cold" || tierFilter === "all";

  const loadStats = () => api.memoryStats().then(setStats).catch(() => {});

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

  const reload = async () => {
    await load(query.trim() || undefined);
    await loadStats();
  };

  const startNew = () => {
    setForm(blank);
    setEditing("new");
  };
  const startEdit = (m: MemoryEntry) => {
    setForm({ text: m.text, tags: m.tags.join(", "), salience: m.salience, tier: m.tier });
    setEditing(m.id);
  };

  const save = async () => {
    const payload = {
      text: form.text,
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      salience: form.salience,
      tier: form.tier,
    };
    try {
      if (editing === "new") await api.createMemory(payload);
      else if (editing) await api.updateMemory(editing, payload);
      setEditing(null);
      await reload();
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const setTier = async (id: string, tier: MemoryTier) => {
    try {
      await api.setMemoryTier(id, tier);
      await reload();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };

  const del = async (id: string) => {
    if (!confirm(t("memory_forget"))) return;
    await api.deleteMemory(id);
    await reload();
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
      <p className="mb-3 text-sm text-fg-dim">{t("memory_desc")}</p>

      <div className="mb-4">
        <Callout title={t("memory_tip_title")} dismissId="memory-recall">
          {t("memory_tip_body")}
        </Callout>
      </div>

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

      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

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
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={form.salience}
                onChange={(e) => setForm({ ...form, salience: Number(e.target.value) })}
                className="mt-2 w-full accent-[var(--accent)]"
              />
            </div>
          </div>
          <div>
            <Label>{t("memory_tier")}</Label>
            <div className="flex gap-2 mt-1">
              {(["hot", "warm", "cold"] as MemoryTier[]).map((tier) => (
                <button
                  key={tier}
                  onClick={() => setForm({ ...form, tier })}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    form.tier === tier
                      ? "bg-[var(--accent)] text-white"
                      : "border border-line text-fg-dim hover:text-fg"
                  }`}
                >
                  {t(TIER_KEY[tier])}
                </button>
              ))}
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
            return (
              <button
                key={f}
                onClick={() => setTierFilter(f)}
                className={`rounded px-2.5 py-1 text-xs border border-line transition-colors ${
                  tierFilter === f
                    ? "bg-[var(--accent)] text-white"
                    : "text-fg-dim hover:text-fg"
                }`}
              >
                {label}
                {count !== undefined && <span className="ml-1 tabular opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {entries.length === 0 && !editing ? (
        <Empty>{query ? t("memory_empty_query") : t("memory_empty")}</Empty>
      ) : (
        <div className="space-y-2">
          {entries.map((m) => (
            <div
              key={m.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-line p-3"
            >
              <div className="min-w-0">
                <p className="text-sm text-fg">{m.text}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-faint">
                  <Badge tone={TIER_TONE[m.tier]}>{t(TIER_KEY[m.tier])}</Badge>
                  {m.tags.map((tag) => (
                    <Badge key={tag} tone="blue">
                      {tag}
                    </Badge>
                  ))}
                  <span className="tabular">{t("memory_salience").toLowerCase()} {m.salience.toFixed(2)}</span>
                  {m.useCount > 0 && <span className="tabular">· {t("memory_recalled")} {m.useCount}×</span>}
                </div>
                <div className="mt-1.5 flex gap-1">
                  {(["hot", "warm", "cold"] as MemoryTier[])
                    .filter((tier) => tier !== m.tier)
                    .map((tier) => (
                      <button
                        key={tier}
                        onClick={() => setTier(m.id, tier)}
                        className="rounded px-1.5 py-0.5 text-xs border border-line text-fg-faint hover:text-fg transition-colors"
                      >
                        → {t(TIER_KEY[tier])}
                      </button>
                    ))}
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
      <span className="truncate text-[11px] uppercase tracking-wide text-fg-faint">{label}</span>
    </div>
  );
}
