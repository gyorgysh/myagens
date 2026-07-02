import { useEffect, useRef, useState } from "react";
import { api, AuthError, type MemoryEntry, type MemoryStats, type MemoryTier } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { errorMessage } from "../lib/errorMessage.ts";
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

// 3px left-border accent so a tier is scannable without reading the badge.
const TIER_BORDER: Record<MemoryTier, string> = {
  hot: "border-l-warn",
  warm: "border-l-blue-500",
  cold: "border-l-zinc-500",
};

// Icon colour matching each tier's accent, for the bar-chart legend glyphs.
const TIER_ICON_COLOR: Record<MemoryTier, string> = {
  hot: "text-warn-fg",
  warm: "text-blue-500",
  cold: "text-zinc-500",
};

/** A tier badge with its Lucide glyph, used wherever a tier is shown as a chip. */
function TierBadge({ tier, label }: { tier: MemoryTier; label: string }) {
  const Icon = TIER_ICON[tier];
  return (
    <Badge tone={TIER_TONE[tier]}>
      <Icon size={13} className="mr-1" />
      {label}
    </Badge>
  );
}

/** A 5-step dot row visualising a 0..1 salience, replacing the raw number. */
function SalienceDots({ value }: { value: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(value * 5)));
  return (
    <span className="inline-flex items-center gap-0.5" title={value.toFixed(2)}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i < filled ? "bg-accent" : "bg-surface-2"}`}
        />
      ))}
    </span>
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
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [listRef] = useListAnimate();
  const importInputRef = useRef<HTMLInputElement>(null);

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
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(errorMessage(e, t))));

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
      setError(errorMessage(e, t));
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
          setError(errorMessage(e, t));
        }
      },
    });
  };

  // Tag filter applies on top of the server-side tier/query filter. The full
  // set of tags for the chip row comes from whatever's currently in `entries`.
  const visible = tagFilter ? entries.filter((m) => m.tags.includes(tagFilter)) : entries;
  const allTags = Array.from(new Set(entries.flatMap((m) => m.tags))).sort();

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitBulk = () => {
    setBulkMode(false);
    setSelected(new Set());
  };

  const bulkDelete = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const prev = entries;
    const prevStats = stats;
    const removed = entries.filter((m) => ids.includes(m.id));
    setEntries((cur) => cur.filter((m) => !ids.includes(m.id)));
    setStats((s) => {
      if (!s) return s;
      const byTier = { ...s.byTier };
      for (const m of removed) byTier[m.tier] -= 1;
      return { ...s, total: s.total - removed.length, byTier };
    });
    exitBulk();
    toast.undo(t("memory_bulk_deleted").replace("{n}", String(ids.length)), {
      undoLabel: t("toast_undo"),
      onUndo: () => {
        setEntries(prev);
        setStats(prevStats);
      },
      onCommit: async () => {
        try {
          await Promise.all(ids.map((id) => api.deleteMemory(id)));
        } catch (e) {
          setEntries(prev);
          setStats(prevStats);
          if (e instanceof AuthError) return onAuthError();
          setError(errorMessage(e, t));
        }
      },
    });
  };

  // Download the full store as a portable JSON file (embeddings stripped server-side).
  const exportMemories = async () => {
    try {
      const dump = await api.exportMemories();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `memories-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      // Defer the revoke: revoking synchronously after click() can abort the
      // download in some browsers before it starts.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(errorMessage(e, t));
    }
  };

  // Read a chosen JSON file and merge its entries (dedup by text, server-side).
  const importMemories = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(entries)) {
        toast.error(t("memory_import_bad_file"));
        return;
      }
      const res = await api.importMemories(entries);
      toast.success(
        t("memory_import_done")
          .replace("{imported}", String(res.imported))
          .replace("{skipped}", String(res.skipped)),
      );
      void loadStats();
      void load(query.trim() || undefined);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast.error(t("memory_import_bad_file"));
    }
  };

  return (
    <Card
      title={t("memory_title")}
      right={
        editing ? null : bulkMode ? (
          <div className="flex gap-1.5">
            <Button
              variant="danger"
              disabled={selected.size === 0}
              onClick={bulkDelete}
            >
              {t("memory_bulk_delete_n").replace("{n}", String(selected.size))}
            </Button>
            <Button onClick={exitBulk}>{t("cancel")}</Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importMemories(file);
                e.target.value = "";
              }}
            />
            <Button onClick={() => importInputRef.current?.click()}>{t("memory_import")}</Button>
            {entries.length > 0 && (
              <Button onClick={exportMemories}>{t("memory_export")}</Button>
            )}
            {entries.length > 0 && (
              <Button onClick={() => setBulkMode(true)}>{t("memory_bulk_select")}</Button>
            )}
            <Button variant="primary" onClick={startNew}>
              {t("memory_new")}
            </Button>
          </div>
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
              <Label>{t("memory_salience")}</Label>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-fg-faint">{t("memory_salience_low")}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.salience}
                  onChange={(e) => setForm({ ...form, salience: Number(e.target.value) })}
                  className="flex-1 accent-[var(--accent)]"
                />
                <span className="text-xs text-fg-faint">{t("memory_salience_high")}</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.salience}
                  aria-label={t("memory_salience")}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v)) setForm({ ...form, salience: Math.max(0, Math.min(1, v)) });
                  }}
                  className="w-16 rounded-lg border border-line bg-input px-2 py-1 text-sm tabular text-fg outline-none focus:border-accent"
                />
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
        {allTags.length > 0 && (() => {
          // Keep the row scannable: show only the first ~10 tags collapsed, with
          // a toggle to reveal the rest. Always keep the active filter visible.
          const LIMIT = 10;
          const collapsible = allTags.length > LIMIT;
          let shownTags = tagsExpanded || !collapsible ? allTags : allTags.slice(0, LIMIT);
          if (collapsible && !tagsExpanded && tagFilter && !shownTags.includes(tagFilter)) {
            shownTags = [...shownTags, tagFilter];
          }
          const hiddenCount = allTags.length - shownTags.length;
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-fg-faint">{t("memory_filter_tag")}</span>
              {shownTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setTagFilter((cur) => (cur === tag ? null : tag))}
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                    tagFilter === tag
                      ? "bg-[var(--accent)] text-white"
                      : "bg-accent/15 text-accent hover:bg-accent/25"
                  }`}
                >
                  {tag}
                </button>
              ))}
              {collapsible && (
                <button
                  onClick={() => setTagsExpanded((v) => !v)}
                  className="text-xs text-accent underline-offset-2 hover:underline"
                >
                  {tagsExpanded
                    ? t("memory_tags_show_less")
                    : t("memory_tags_show_all").replace("{n}", String(hiddenCount))}
                </button>
              )}
              {tagFilter && (
                <button
                  onClick={() => setTagFilter(null)}
                  className="text-xs text-fg-faint underline-offset-2 hover:underline"
                >
                  {t("memory_filter_clear")}
                </button>
              )}
            </div>
          );
        })()}
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
      ) : visible.length === 0 ? (
        <Empty>{t("memory_empty_query")}</Empty>
      ) : (
        <div ref={listRef} className="space-y-2">
          {visible.map((m) => (
            <div
              key={m.id}
              className={`flex items-start justify-between gap-3 rounded-lg border border-l-[3px] border-line p-3 ${TIER_BORDER[m.tier]} ${
                bulkMode && selected.has(m.id) ? "ring-1 ring-accent" : ""
              }`}
            >
              {bulkMode && (
                <input
                  type="checkbox"
                  checked={selected.has(m.id)}
                  onChange={() => toggleSelect(m.id)}
                  aria-label={t("memory_bulk_select")}
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm text-fg">{m.text}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-faint">
                  <TierBadge tier={m.tier} label={t(TIER_KEY[m.tier])} />
                  {m.tags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => setTagFilter((cur) => (cur === tag ? null : tag))}
                      title={t("memory_filter_tag")}
                    >
                      <Badge tone="blue" className="cursor-pointer hover:opacity-80">
                        {tag}
                      </Badge>
                    </button>
                  ))}
                  <span className="inline-flex items-center gap-1.5">
                    {t("memory_salience").toLowerCase()}
                    <SalienceDots value={m.salience} />
                  </span>
                  {m.useCount > 0 && <span className="tabular">· {t("memory_recalled")} {m.useCount}×</span>}
                </div>
                {!bulkMode && (
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
                )}
              </div>
              {!bulkMode && (
                <div className="flex shrink-0 gap-1.5">
                  <Button onClick={() => startEdit(m)}>{t("edit")}</Button>
                  <Button variant="danger" onClick={() => del(m.id)}>
                    {t("delete")}
                  </Button>
                </div>
              )}
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
        {segs.map((s) => {
          const Icon = TIER_ICON[s.tier];
          return (
            <span key={s.tier} className="flex items-center gap-1.5">
              <Icon size={12} className={TIER_ICON_COLOR[s.tier]} />
              {t(TIER_KEY[s.tier])}
              <span className="tabular text-fg-dim">{s.count}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
