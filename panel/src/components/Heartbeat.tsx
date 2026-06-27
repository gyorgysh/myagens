import { useEffect, useState } from "react";
import { api, AuthError, type HeartbeatConfig, type HeartbeatMode, type HeartbeatSignalKey, type HeartbeatView } from "../api.ts";
import { Badge, Button, Card, Empty, InfoCard, Label } from "./ui.tsx";
import { relTime } from "../lib/format.ts";
import { useI18n } from "../lib/useI18n.ts";
import type { TranslationKey } from "../i18n/en.ts";

const MODES: Array<{ id: HeartbeatMode; label: TranslationKey; desc: TranslationKey }> = [
  { id: "off", label: "hb_mode_off", desc: "hb_mode_off_desc" },
  { id: "alert", label: "hb_mode_alert", desc: "hb_mode_alert_desc" },
  { id: "active", label: "hb_mode_active", desc: "hb_mode_active_desc" },
];

const NUMS: Array<{ key: keyof HeartbeatConfig; label: TranslationKey; suffix: string }> = [
  { key: "cpuPct", label: "hb_cpu", suffix: "%" },
  { key: "memPct", label: "hb_memory", suffix: "%" },
  { key: "swapPct", label: "hb_swap", suffix: "%" },
  { key: "diskPct", label: "hb_disk", suffix: "%" },
  { key: "staleCardHours", label: "hb_stale_card", suffix: "h" },
];

export function HeartbeatView_({ onAuthError }: { onAuthError: () => void }) {
  const { t } = useI18n();
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
    setStatus(signals ? t("hb_found_signals").replace("{n}", String(signals)) : t("hb_no_signals"));
    setTimeout(() => setStatus(null), 4000);
    await load();
  };

  if (!view) return <Card title={t("hb_title")}>{error ? <p className="text-sm text-red-400">{error}</p> : <Empty>{t("loading")}</Empty>}</Card>;
  const c = view.config;

  return (
    <div className="space-y-4">
      <Card
        title={t("hb_title")}
        right={
          <Button onClick={runNow} disabled={c.mode === "off"}>
            {t("hb_run_check")}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-fg-dim">{t("hb_desc")}</p>
        <div className="mb-3">
          <InfoCard id="heartbeat" title={t("info_heartbeat_title")} body={t("info_heartbeat_body")}>
            <ul className="space-y-1.5">
              <li>{t("info_heartbeat_alert")}</li>
              <li>{t("info_heartbeat_active")}</li>
            </ul>
          </InfoCard>
        </div>
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
        {status && <p className="mb-2 text-sm text-emerald-400">{status}</p>}

        <Label>{t("hb_mode")}</Label>
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
              <div className="font-medium">{t(m.label)}</div>
              <div className="text-xs text-fg-faint">{t(m.desc)}</div>
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label>{t("hb_interval")}</Label>
            <NumberField
              value={Math.round(c.intervalMs / 60_000)}
              onCommit={(n) => save({ intervalMs: Math.max(1, n) * 60_000 })}
            />
          </div>
          {NUMS.map((f) => (
            <div key={f.key}>
              <Label>
                {t("hb_threshold").replace("{label}", t(f.label)).replace("{suffix}", f.suffix)}
              </Label>
              <NumberField value={c[f.key] as number} onCommit={(n) => save({ [f.key]: n })} />
            </div>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          <Label>{t("hb_signal_alerts")}</Label>
          <p className="text-xs text-fg-faint">{t("hb_signal_alerts_hint")}</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                { key: "cpu" as HeartbeatSignalKey, label: "hb_cpu" as TranslationKey },
                { key: "mem" as HeartbeatSignalKey, label: "hb_memory" as TranslationKey },
                { key: "swap" as HeartbeatSignalKey, label: "hb_swap" as TranslationKey },
                { key: "disk" as HeartbeatSignalKey, label: "hb_disk" as TranslationKey },
                { key: "stale" as HeartbeatSignalKey, label: "hb_stale_card" as TranslationKey },
              ] satisfies Array<{ key: HeartbeatSignalKey; label: TranslationKey }>
            ).map(({ key, label }) => {
              const muted = (c.mutedSignals ?? []).includes(key);
              const toggle = () => {
                const next = muted
                  ? (c.mutedSignals ?? []).filter((s) => s !== key)
                  : [...(c.mutedSignals ?? []), key];
                void save({ mutedSignals: next });
              };
              return (
                <label key={key} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={!muted}
                    onChange={toggle}
                    className="h-4 w-4 accent-accent"
                  />
                  <span className={`text-sm ${muted ? "text-fg-faint line-through" : "text-fg"}`}>
                    {t(label)}
                  </span>
                  {muted && <Badge tone="zinc">{t("hb_muted")}</Badge>}
                </label>
              );
            })}
          </div>
        </div>

        <p className="mt-3 text-xs text-fg-faint">
          {t("hb_last_checked").replace("{time}", view.lastTickAt ? relTime(view.lastTickAt) : t("hb_never"))}
        </p>
      </Card>

      <Card title={t("hb_recent_alerts")}>
        {view.alerts.length === 0 ? (
          <Empty>{t("hb_no_alerts")}</Empty>
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
