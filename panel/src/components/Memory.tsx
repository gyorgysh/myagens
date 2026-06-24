import { useEffect, useState } from "react";
import { api, AuthError, type MemoryEntry } from "../api.ts";
import { Badge, Button, Card, Empty, Input, Label, TextArea } from "./ui.tsx";

const blank = { text: "", tags: "", salience: 0.5 };

export function MemoryView({ onAuthError }: { onAuthError: () => void }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof blank>(blank);
  const [error, setError] = useState<string | null>(null);

  const load = (q?: string) =>
    api
      .memories(q)
      .then((r) => setEntries(r.memories))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search as you type.
  useEffect(() => {
    const t = setTimeout(() => void load(query.trim() || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const startNew = () => {
    setForm(blank);
    setEditing("new");
  };
  const startEdit = (m: MemoryEntry) => {
    setForm({ text: m.text, tags: m.tags.join(", "), salience: m.salience });
    setEditing(m.id);
  };

  const save = async () => {
    const payload = {
      text: form.text,
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      salience: form.salience,
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

  const del = async (id: string) => {
    if (!confirm("Forget this memory?")) return;
    await api.deleteMemory(id);
    await load(query.trim() || undefined);
  };

  return (
    <Card
      title="Memory"
      right={
        editing ? null : (
          <Button variant="primary" onClick={startNew}>
            + New memory
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-dim">
        Durable facts the agent recalls across conversations. It reads and writes these itself via
        the <code>memory_*</code> tools; relevant ones are injected into each turn.
      </p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

      {editing && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div>
            <Label>Fact</Label>
            <TextArea
              rows={2}
              value={form.text}
              onChange={(e) => setForm({ ...form, text: e.target.value })}
              placeholder="One concise, self-contained fact…"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Tags (comma-separated)</Label>
              <Input
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="deploy, preferences"
              />
            </div>
            <div>
              <Label>Salience: {form.salience.toFixed(2)}</Label>
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
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={!form.text.trim()}>
              Save
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search memories…"
        className="mb-3"
      />

      {entries.length === 0 && !editing ? (
        <Empty>{query ? "No matching memories." : "No memories yet."}</Empty>
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
                  {m.tags.map((t) => (
                    <Badge key={t} tone="blue">
                      {t}
                    </Badge>
                  ))}
                  <span className="tabular">salience {m.salience.toFixed(2)}</span>
                  {m.useCount > 0 && <span className="tabular">· recalled {m.useCount}×</span>}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button onClick={() => startEdit(m)}>Edit</Button>
                <Button variant="danger" onClick={() => del(m.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
