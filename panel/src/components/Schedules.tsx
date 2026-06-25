import { useEffect, useState } from "react";
import { api, AuthError, type ScheduleView } from "../api.ts";
import { Badge, Button, Card, Empty, Input, Label } from "./ui.tsx";
import { relTime } from "../lib/format.ts";

const blank = { prompt: "", when: "", cwd: "" };

export function SchedulesView({ onAuthError }: { onAuthError: () => void }) {
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [form, setForm] = useState<typeof blank>(blank);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<typeof blank>(blank);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .schedules()
      .then((r) => setSchedules(r.schedules))
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setError(null);
    try {
      const r = await api.createSchedule(form);
      setSchedules(r.schedules);
      setForm(blank);
      setAdding(false);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const startEdit = (s: ScheduleView) => {
    setEditingId(s.id);
    setEditForm({ prompt: s.prompt, when: s.spec, cwd: s.cwd });
  };

  const saveEdit = async (id: string) => {
    setError(null);
    try {
      const r = await api.updateSchedule(id, editForm);
      setSchedules(r.schedules);
      setEditingId(null);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const del = async (id: string) => {
    if (!confirm("Delete this schedule?")) return;
    await api.deleteSchedule(id);
    await load();
  };

  return (
    <Card
      title="Schedules"
      right={
        !adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            + New schedule
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-dim">
        Recurring autonomous prompts. Each runs in its working directory and posts the result to its
        Telegram chat. Also manageable from Telegram with <code>/schedule</code>.
      </p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

      {adding && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-input p-3">
          <div>
            <Label>Prompt</Label>
            <Input
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="e.g. Summarise today's commits"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>When</Label>
              <Input
                value={form.when}
                onChange={(e) => setForm({ ...form, when: e.target.value })}
                placeholder="30m · 2h · 1d · or 09:30"
              />
            </div>
            <div>
              <Label>Working directory (optional)</Label>
              <Input
                value={form.cwd}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                placeholder="default WORKDIR"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={create} disabled={!form.prompt.trim() || !form.when.trim()}>
              Create
            </Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {schedules.length === 0 && !adding ? (
        <Empty>No schedules yet.</Empty>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) =>
            editingId === s.id ? (
              <div key={s.id} className="space-y-3 rounded-lg border border-accent/50 bg-input p-3">
                <div>
                  <Label>Prompt</Label>
                  <Input
                    value={editForm.prompt}
                    onChange={(e) => setEditForm({ ...editForm, prompt: e.target.value })}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>When</Label>
                    <Input
                      value={editForm.when}
                      onChange={(e) => setEditForm({ ...editForm, when: e.target.value })}
                      placeholder="30m · 2h · 1d · or 09:30"
                    />
                  </div>
                  <div>
                    <Label>Working directory</Label>
                    <Input
                      value={editForm.cwd}
                      onChange={(e) => setEditForm({ ...editForm, cwd: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => saveEdit(s.id)} disabled={!editForm.prompt.trim() || !editForm.when.trim()}>
                    Save
                  </Button>
                  <Button onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div key={s.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="blue">{s.spec}</Badge>
                  <span className="ml-auto tabular text-xs text-fg-muted">
                    next {relTime(s.nextRunAt)}
                    {s.lastRunAt ? ` · last ${relTime(s.lastRunAt)}` : ""}
                  </span>
                  <Button onClick={() => startEdit(s)}>Edit</Button>
                  <Button variant="danger" onClick={() => del(s.id)}>
                    Delete
                  </Button>
                </div>
                <div className="mt-2 text-sm text-fg">{s.prompt}</div>
                <div className="mono mt-1 truncate text-xs text-fg-faint" title={s.cwd}>
                  {s.cwd}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}
