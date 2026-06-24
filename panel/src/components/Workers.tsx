import { useEffect, useRef, useState } from "react";
import { api, AuthError, type Worker, type WorkerRun } from "../api.ts";
import { useWorkerEvents, type LiveRun } from "../lib/useWorkerEvents.ts";
import { Badge, Button, Card, Empty, Input, Label, TextArea } from "./ui.tsx";
import { ms, relTime, usd } from "../lib/format.ts";

const emptyForm = { name: "", cwd: "", prompt: "", model: "", systemPrompt: "", skillId: "", when: "" };
type Form = typeof emptyForm;

/** Short, readable label for a model id badge (e.g. "haiku-4-5"). */
function shortModel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// Model choices offered in the worker form. "" = inherit the bot's CLAUDE_MODEL.
const MODELS: Array<{ value: string; label: string }> = [
  { value: "", label: "Default (CLAUDE_MODEL)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (cheapest)" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 (balanced)" },
  { value: "claude-opus-4-8", label: "Opus 4.8 (most capable)" },
];

export function WorkersView({ onAuthError }: { onAuthError: () => void }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [skills, setSkills] = useState<Array<{ id: string; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useWorkerEvents();

  const load = () =>
    api
      .workers()
      .then((r) => {
        setWorkers(r.workers);
        setSkills(r.skills);
      })
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // Refresh registry periodically so schedule/running state stays current.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <Empty>Failed to load: {error}</Empty>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {!creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            + New worker
          </Button>
        )}
      </div>

      {creating && (
        <Card title="New worker">
          <WorkerForm
            skills={skills}
            initial={emptyForm}
            onCancel={() => setCreating(false)}
            onSubmit={async (form) => {
              await api.createWorker(form);
              setCreating(false);
              await load();
            }}
            onAuthError={onAuthError}
          />
        </Card>
      )}

      {workers.length === 0 && !creating ? (
        <Empty>No workers yet. Create a persistent autonomous agent.</Empty>
      ) : (
        workers.map((w) => (
          <WorkerRow
            key={w.id}
            worker={w}
            skills={skills}
            live={live[w.id]}
            onChange={load}
            onAuthError={onAuthError}
          />
        ))
      )}
    </div>
  );
}

function WorkerRow({
  worker,
  skills,
  live,
  onChange,
  onAuthError,
}: {
  worker: Worker;
  skills: Array<{ id: string; name: string }>;
  live?: LiveRun;
  onChange: () => void;
  onAuthError: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<WorkerRun[]>([]);
  const running = worker.running || live?.status === "running";

  const loadRuns = () => api.workerRuns(worker.id).then((r) => setRuns(r.runs));
  useEffect(() => {
    if (open) void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live?.status]);

  const run = async () => {
    try {
      await api.runWorker(worker.id);
      setOpen(true);
      onChange();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    }
  };
  const stop = async () => {
    await api.stopWorker(worker.id);
    onChange();
  };
  const del = async () => {
    if (!confirm(`Delete worker "${worker.name}"?`)) return;
    await api.deleteWorker(worker.id);
    onChange();
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{worker.name}</span>
        <Badge tone={worker.schedule === "manual" ? "zinc" : "blue"}>{worker.schedule}</Badge>
        {worker.model && <Badge>{shortModel(worker.model)}</Badge>}
        {!worker.enabled && <Badge tone="amber">disabled</Badge>}
        {running && <Badge tone="green">running</Badge>}
        <span className="ml-auto flex gap-1.5">
          {running ? (
            <Button variant="danger" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={run}>
              Run now
            </Button>
          )}
          <Button onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Details"}</Button>
          <Button onClick={() => setEditing((e) => !e)}>Edit</Button>
          <Button variant="danger" onClick={del}>
            Delete
          </Button>
        </span>
      </div>

      <div className="mt-1 truncate font-mono text-xs text-fg-faint" title={worker.cwd}>
        {worker.cwd || "(no cwd)"}
        {worker.nextRunAt && ` · next ${relTime(worker.nextRunAt)}`}
      </div>

      {editing && (
        <div className="mt-3 border-t border-line pt-3">
          <WorkerForm
            skills={skills}
            initial={{
              name: worker.name,
              cwd: worker.cwd,
              prompt: worker.prompt,
              model: worker.model,
              systemPrompt: worker.systemPrompt,
              skillId: worker.skillId,
              when: worker.when,
            }}
            enabled={worker.enabled}
            onCancel={() => setEditing(false)}
            onSubmit={async (form, enabled) => {
              await api.updateWorker(worker.id, { ...form, enabled });
              setEditing(false);
              onChange();
            }}
            onAuthError={onAuthError}
          />
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <LiveOutput live={live} />
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wider text-fg-dim">
              Run history
            </div>
            {runs.length === 0 ? (
              <p className="text-xs text-fg-faint">No runs yet.</p>
            ) : (
              <div className="space-y-1">
                {runs.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-xs">
                    <Badge tone={r.status === "ok" ? "green" : r.status === "error" ? "amber" : "zinc"}>
                      {r.status}
                    </Badge>
                    <span className="tabular text-fg-dim">{relTime(r.startedAt)}</span>
                    {r.durationMs != null && (
                      <span className="tabular text-fg-faint">{ms(r.durationMs)}</span>
                    )}
                    {r.costUsd != null && (
                      <span className="tabular text-fg-faint">{usd(r.costUsd)}</span>
                    )}
                    {r.error && <span className="truncate text-red-400">{r.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function LiveOutput({ live }: { live?: LiveRun }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [live?.output]);

  if (!live) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-fg-dim">
        Live output
        {live.status === "running" && <Badge tone="green">streaming</Badge>}
        {live.tool && <span className="font-mono normal-case text-fg-faint">🔧 {live.tool}</span>}
      </div>
      <pre
        ref={ref}
        className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-input p-3 text-xs text-fg-muted"
      >
        {live.output || "…"}
      </pre>
    </div>
  );
}

function WorkerForm({
  skills,
  initial,
  enabled: initialEnabled = true,
  onCancel,
  onSubmit,
  onAuthError,
}: {
  skills: Array<{ id: string; name: string }>;
  initial: Form;
  enabled?: boolean;
  onCancel: () => void;
  onSubmit: (form: Form, enabled: boolean) => Promise<void>;
  onAuthError: () => void;
}) {
  const [form, setForm] = useState<Form>(initial);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(form, enabled);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <Label>Working directory</Label>
          <Input
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            placeholder="/path/to/project"
          />
        </div>
      </div>
      <div>
        <Label>Task prompt (run each time)</Label>
        <TextArea
          rows={4}
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          placeholder="What should this worker do every run?"
        />
      </div>
      <div>
        <Label>Persona / extra system prompt (optional)</Label>
        <TextArea
          rows={3}
          value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Model</Label>
          <select
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            className="w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg outline-none focus:border-blue-500"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Skill (optional)</Label>
          <select
            value={form.skillId}
            onChange={(e) => setForm({ ...form, skillId: e.target.value })}
            className="w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg outline-none focus:border-blue-500"
          >
            <option value="">— none —</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Schedule (optional)</Label>
          <Input
            value={form.when}
            onChange={(e) => setForm({ ...form, when: e.target.value })}
            placeholder="30m · 2h · 09:00"
          />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
            Enabled
          </label>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || !form.name.trim() || !form.cwd.trim() || !form.prompt.trim()}
        >
          {busy ? "Saving…" : "Save worker"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
