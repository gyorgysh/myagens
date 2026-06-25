import { useEffect, useState } from "react";
import { api, AuthError, type HeartbeatConfig, type HeartbeatMode, type HeartbeatView } from "../api.ts";
import { Badge, Button, Card, Empty, Label } from "./ui.tsx";
import { relTime } from "../lib/format.ts";

const MODES: Array<{ id: HeartbeatMode; label: string; desc: string }> = [
  { id: "off", label: "Off", desc: "No monitoring." },
  { id: "alert", label: "Alert only", desc: "Deterministic checks; message on threshold breach." },
  { id: "active", label: "Active", desc: "Hand signals to an autonomous agent turn to investigate." },
];

const NUMS: Array<{ key: keyof HeartbeatConfig; label: string; suffix: string }> = [
  { key: "cpuPct", label: "CPU", suffix: "%" },
  { key: "memPct", label: "Memory", suffix: "%" },
  { key: "swapPct", label: "Swap", suffix: "%" },
  { key: "diskPct", label: "Disk", suffix: "%" },
  { key: "staleCardHours", label: "Stale card after", suffix: "h" },
];

export function HeartbeatView_({ onAuthError }: { onAuthError: () => void }) {
  const [view, setView] = useState<HeartbeatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = () =>
    api
      .heartbeat()
      .then(setView)
      .catch((e) => (e instanceof AuthError ? onAuthError() : setError(String(e))));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<HeartbeatConfig>) => {
    try {
      setView(await api.saveHeartbeat(patch));
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setError(String(e));
    }
  };

  const runNow = async () => {
    const { signals } = await api.runHeartbeat();
    setStatus(signals ? `Found ${signals} signal(s).` : "No signals — all quiet.");
    setTimeout(() => setStatus(null), 4000);
    await load();
  };

  if (!view) return <Card title="Heartbeat">{error ? <p className="text-sm text-red-400">{error}</p> : <Empty>Loading…</Empty>}</Card>;
  const c = view.config;

  return (
    <div className="space-y-4">
      <Card
        title="Heartbeat"
        right={
          <Button onClick={runNow} disabled={c.mode === "off"}>
            Run check now
          </Button>
        }
      >
        <p className="mb-3 text-sm text-fg-dim">
          Proactive monitoring of host health and stalled kanban cards. It messages you over
          Telegram only when something is noteworthy.
        </p>
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
        {status && <p className="mb-2 text-sm text-emerald-400">{status}</p>}

        <Label>Mode</Label>
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => save({ mode: m.id })}
              className={`rounded-lg border p-2.5 text-left text-sm transition-colors ${
                c.mode === m.id
                  ? "border-accent bg-accent/10 text-fg"
                  : "border-line text-fg-dim hover:bg-surface-2"
              }`}
            >
              <div className="font-medium">{m.label}</div>
              <div className="text-xs text-fg-faint">{m.desc}</div>
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label>Interval (minutes)</Label>
            <NumberField
              value={Math.round(c.intervalMs / 60_000)}
              onCommit={(n) => save({ intervalMs: Math.max(1, n) * 60_000 })}
            />
          </div>
          {NUMS.map((f) => (
            <div key={f.key}>
              <Label>
                {f.label} threshold ({f.suffix})
              </Label>
              <NumberField value={c[f.key] as number} onCommit={(n) => save({ [f.key]: n })} />
            </div>
          ))}
        </div>

        <label className="mt-4 flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={c.spendAlertEnabled}
            onChange={(e) => save({ spendAlertEnabled: e.target.checked })}
            className="h-4 w-4 rounded accent-accent"
          />
          <span className="text-sm text-fg">
            API billing spend alert{" "}
            <span className="text-xs text-fg-faint">
              (API-key plans only — not meaningful for Pro/Max subscriptions)
            </span>
          </span>
        </label>

        <p className="mt-3 text-xs text-fg-faint">
          Last checked: {view.lastTickAt ? relTime(view.lastTickAt) : "never"}
        </p>
      </Card>

      <Card title="Recent alerts">
        {view.alerts.length === 0 ? (
          <Empty>No alerts yet.</Empty>
        ) : (
          <div className="space-y-2">
            {view.alerts.map((a, i) => (
              <div key={i} className="flex items-start gap-3 rounded-lg border border-line p-2.5">
                <Badge>{relTime(a.ts)}</Badge>
                <span className="whitespace-pre-wrap text-sm text-fg">{a.text}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function NumberField({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input
      type="number"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = Number(v);
        if (!Number.isNaN(n) && n !== value) onCommit(n);
      }}
      className="h-[38px] w-full rounded-lg border border-line bg-input px-3 text-sm text-fg outline-none focus:border-accent"
    />
  );
}
