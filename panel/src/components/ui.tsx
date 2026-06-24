import type { ReactNode } from "react";

export function Card({
  title,
  right,
  children,
  className = "",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-line bg-surface p-4 ${className}`}
    >
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-dim">
            {title}
          </h3>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/** Big labelled metric with a thin usage bar underneath. */
export function Metric({
  label,
  value,
  sub,
  pct,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  pct?: number;
}) {
  return (
    <div>
      <div className="text-xs text-fg-dim">{label}</div>
      <div className="tabular mt-0.5 text-2xl font-semibold text-fg">{value}</div>
      {sub && <div className="tabular text-xs text-fg-dim">{sub}</div>}
      {pct != null && <Bar pct={pct} className="mt-2" />}
    </div>
  );
}

/** Horizontal progress bar, colour ramps green → amber → red with load. */
export function Bar({ pct, className = "" }: { pct: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color =
    clamped < 60 ? "bg-emerald-500" : clamped < 85 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-line ${className}`}>
      <div
        className={`h-full rounded-full ${color} transition-[width] duration-500`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function Badge({
  children,
  tone = "zinc",
}: {
  children: ReactNode;
  tone?: "zinc" | "green" | "amber" | "blue";
}) {
  const tones: Record<string, string> = {
    zinc: "bg-surface-2 text-fg-muted",
    green: "bg-emerald-500/15 text-emerald-400",
    amber: "bg-amber-500/15 text-amber-400",
    blue: "bg-blue-500/15 text-blue-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-10 text-center text-sm text-fg-faint">{children}</div>
  );
}
