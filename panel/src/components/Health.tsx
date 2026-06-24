import { useEffect, useRef, useState } from "react";
import { openHealthSocket, type Health } from "../api.ts";
import { Bar, Card, Empty, Metric } from "./ui.tsx";
import { bytes, bytesPerSec, duration } from "../lib/format.ts";

type Status = "connecting" | "live" | "down";

export function HealthView() {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;

    const connect = () => {
      if (closed) return;
      setStatus((s) => (s === "live" ? s : "connecting"));
      ws = openHealthSocket();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; data: Health };
          if (msg.type === "health") {
            setHealth(msg.data);
            setStatus("live");
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus("down");
        retryRef.current = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retryRef.current);
      ws?.close();
    };
  }, []);

  if (!health) {
    return <Empty>{status === "down" ? "Connection lost — retrying…" : "Connecting…"}</Empty>;
  }

  const memPct = health.mem.total ? (health.mem.used / health.mem.total) * 100 : 0;
  const swapPct = health.swap.total ? (health.swap.used / health.swap.total) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span className="font-medium text-fg">{health.host}</span>
        <span className="text-fg-faint">·</span>
        <span>{health.platform}</span>
        <span className="text-fg-faint">·</span>
        <span>up {duration(health.uptimeSec)}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              status === "live" ? "bg-emerald-500" : "bg-amber-500"
            }`}
          />
          {status === "live" ? "live" : "reconnecting"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <Metric
            label="CPU"
            value={`${health.cpu.load.toFixed(0)}%`}
            sub={`load ${health.cpu.loadAvg.map((n) => n.toFixed(2)).join(" ")}${
              health.cpu.tempC ? ` · ${health.cpu.tempC}°C` : ""
            }`}
            pct={health.cpu.load}
          />
        </Card>
        <Card>
          <Metric
            label="Memory"
            value={`${memPct.toFixed(0)}%`}
            sub={`${bytes(health.mem.used)} / ${bytes(health.mem.total)}`}
            pct={memPct}
          />
        </Card>
        <Card>
          <Metric
            label="Swap"
            value={health.swap.total ? `${swapPct.toFixed(0)}%` : "—"}
            sub={
              health.swap.total
                ? `${bytes(health.swap.used)} / ${bytes(health.swap.total)}`
                : "none"
            }
            pct={swapPct}
          />
        </Card>
        <Card>
          <Metric
            label="Disk I/O"
            value={bytesPerSec(
              (health.io.readBytesSec ?? 0) + (health.io.writeBytesSec ?? 0) || undefined,
            )}
            sub={`r ${bytesPerSec(health.io.readBytesSec)} · w ${bytesPerSec(
              health.io.writeBytesSec,
            )}`}
          />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Per-core load">
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {health.cpu.cores.map((load, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="tabular w-10 shrink-0 text-xs text-fg-dim">#{i}</span>
                <Bar pct={load} />
                <span className="tabular w-9 shrink-0 text-right text-xs text-fg-muted">
                  {load.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Filesystems">
          <div className="space-y-3">
            {health.disks.map((d) => (
              <div key={d.mount}>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="truncate font-mono text-xs text-fg-muted">{d.mount}</span>
                  <span className="tabular text-xs text-fg-dim">
                    {bytes(d.used)} / {bytes(d.size)} · {d.usePct.toFixed(0)}%
                  </span>
                </div>
                <Bar pct={d.usePct} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
