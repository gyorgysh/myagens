import os from "node:os";
import si from "systeminformation";
import { log } from "../logger.js";

/** A point-in-time system-health snapshot for the panel dashboard. */
export interface HealthSnapshot {
  ts: number;
  host: string;
  platform: string;
  uptimeSec: number;
  cpu: {
    /** Overall load 0–100. */
    load: number;
    /** Per-core load 0–100. */
    cores: number[];
    /** 1/5/15-minute load averages (0 on Windows). */
    loadAvg: [number, number, number];
    /** Main package temperature in °C, if the platform reports it. */
    tempC?: number;
  };
  mem: { total: number; used: number; available: number };
  swap: { total: number; used: number };
  disks: Array<{ mount: string; size: number; used: number; usePct: number }>;
  io: { readBytesSec?: number; writeBytesSec?: number; tps?: number };
}

/**
 * Gather a health snapshot. Each metric is fetched defensively — some
 * (disk IO, temperature) are unavailable on certain platforms and return
 * null/empty; we degrade gracefully rather than throw.
 */
export async function getHealth(): Promise<HealthSnapshot> {
  const [load, mem, fs, io, temp] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.fsSize().catch(() => [] as si.Systeminformation.FsSizeData[]),
    si.disksIO().catch(() => null),
    si.cpuTemperature().catch(() => null),
  ]);

  const cores = (load?.cpus ?? []).map((c) => round(c.load));

  return {
    ts: Date.now(),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSec: Math.round(os.uptime()),
    cpu: {
      load: round(load?.currentLoad ?? 0),
      cores,
      loadAvg: os.loadavg() as [number, number, number],
      tempC: temp && temp.main > 0 ? round(temp.main) : undefined,
    },
    mem: {
      total: mem?.total ?? 0,
      used: mem?.active ?? mem?.used ?? 0,
      available: mem?.available ?? mem?.free ?? 0,
    },
    swap: { total: mem?.swaptotal ?? 0, used: mem?.swapused ?? 0 },
    // Dedupe by mount; skip pseudo filesystems with zero size.
    disks: dedupeMounts(fs)
      .filter((d) => d.size > 0)
      .map((d) => ({
        mount: d.mount,
        size: d.size,
        used: d.used,
        usePct: round(d.use),
      })),
    io: {
      readBytesSec: nonNeg(io?.rIO_sec),
      writeBytesSec: nonNeg(io?.wIO_sec),
      tps: nonNeg(io?.tIO_sec),
    },
  };
}

function dedupeMounts(
  fs: si.Systeminformation.FsSizeData[],
): si.Systeminformation.FsSizeData[] {
  const seen = new Set<string>();
  const out: si.Systeminformation.FsSizeData[] = [];
  for (const d of fs) {
    if (seen.has(d.mount)) continue;
    seen.add(d.mount);
    out.push(d);
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function nonNeg(n: number | null | undefined): number | undefined {
  return typeof n === "number" && n >= 0 ? Math.round(n) : undefined;
}

// Warm systeminformation's internal caches once at import so the first panel
// request isn't slow (disksIO in particular primes a delta baseline).
void getHealth().catch((err) =>
  log.debug("Health warmup failed", { error: err instanceof Error ? err.message : String(err) }),
);
