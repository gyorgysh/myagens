import { useEffect, useState } from "react";
import { api, AuthError, type MemoryEntry, type MemoryTier } from "../api.ts";
import { useI18n } from "../lib/useI18n.ts";
import { Badge, Button, Callout, Card, Empty, Input, Label, TextArea } from "./ui.tsx";

const blank = { text: "", tags: "", salience: 0.5, tier: "warm" as MemoryTier };

const TIER_TONE = {
  hot: "amber" as const,
  warm: "blue" as const,
  cold: "zinc" as const,
};

const TIER_KEY = { hot: "memory_tier_hot", warm: "memory_tier_warm", cold: "memory_tier_cold" } as const;

export function MemoryView({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [showCold, setShowCold] = useState(false);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof blank>(blank);
  const [error, setError] = useState<string | null>(null);

  const load = (q?: string) =>
    api
      .memories(q, q ? showCold : false)
      .then((r) => {
        const filtered = showCold ? r.memories : r.memories.filter((m) => m.tier !== "cold");
        setEntries(filtered);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCold]);

  useEffect(() => {
    const t = setTimeout(() => void load(query.trim() || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, showCold]);

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
      await load(query.trim() || undefined);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const setTier = async (id: string, tier: MemoryTier) => {
    try {
      await api.setMemoryTier(id, tier);
      await load(query.trim() || undefined);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };

  const del = async (id: string) => {
    if (!confirm(t("memory_forget"))) return;
    await api.deleteMemory(id);
    await load(query.trim() || undefined);
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

      <Callout title="Tip">
        In chat, tell your agent <em>"please remember…"</em> to save any fact you think it missed.
        You can also ask <em>"what do you remember about X?"</em> to verify recall before a long task.
      </Callout>

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

      <div className="mb-3 flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("memory_search")}
          className="flex-1"
        />
        <button
          onClick={() => setShowCold((s) => !s)}
          className={`rounded px-2.5 py-1 text-xs border border-line transition-colors ${showCold ? "bg-[var(--accent)] text-white" : "text-fg-dim hover:text-fg"}`}
        >
          {showCold ? t("memory_hide_cold") : t("memory_show_cold")}
        </button>
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
