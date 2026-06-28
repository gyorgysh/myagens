export function bytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function bytesPerSec(n?: number): string {
  if (n == null) return "—";
  return `${bytes(n)}/s`;
}

export function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ms(n: number): string {
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** Compact token count: 1234 → "1.2K", 3_400_000 → "3.4M". */
export function tokens(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/**
 * Turn a raw usage-probe error into something readable. A rate-limit (429) is
 * by far the most common, so collapse its noisy "URL → 429: {json}" form into a
 * plain explanation; anything else is passed through as-is.
 */
export function friendlyProbeError(error?: string): string | undefined {
  if (!error) return undefined;
  if (/\b429\b/.test(error) || /rate[_ ]?limit/i.test(error)) {
    return "Rate limited by Anthropic — showing the last known values; it retries automatically.";
  }
  return error;
}

export function relTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const label =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / 1440)}d`;
  if (mins === 0) return "now";
  return diff > 0 ? `in ${label}` : `${label} ago`;
}
