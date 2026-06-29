import { useState, type ReactNode } from "react";
import { CheckCircle2, XCircle, Info, X, type LucideIcon } from "lucide-react";
import { useI18n } from "../lib/useI18n";
import { actOnToast, dismissToast, useToasts, type ToastVariant } from "../lib/useToast.ts";

export function Card({
  title,
  right,
  children,
  className = "",
  compact = false,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Tighter padding tier (`p-3`) for dense/nested cards; default is `p-4`. */
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-line bg-surface ${compact ? "p-3" : "p-4"} ${className}`}
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
    clamped < 60 ? "bg-ok" : clamped < 85 ? "bg-warn" : "bg-critical";
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
  className = "",
}: {
  children: ReactNode;
  tone?: "zinc" | "green" | "amber" | "blue" | "violet" | "critical";
  className?: string;
}) {
  const tones: Record<string, string> = {
    zinc: "bg-surface-2 text-fg-muted",
    green: "bg-ok-subtle text-ok-fg",
    amber: "bg-warn-subtle text-warn-fg",
    blue: "bg-accent/15 text-accent",
    critical: "bg-critical-subtle text-critical-fg",
    // Neon violet — the "Private Chat on Web" counterpart to the green Telegram
    // badge. Fixed violet (not the theme accent) so it reads as a distinct channel.
    violet: "bg-violet-500/15 text-violet-500 dark:text-violet-300",
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

/** Empty / zero-data placeholder. The simple form (just text children) is
 *  unchanged; pass `icon` for an illustration above the message, `title` for a
 *  bolder heading, and `action` for a call-to-action button below it. */
export function Empty({
  children,
  icon,
  title,
  action,
}: {
  children?: ReactNode;
  icon?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
}) {
  if (!icon && !title && !action) {
    return <div className="py-10 text-center text-sm text-fg-faint">{children}</div>;
  }
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      {icon && <div className="text-fg-faint/60">{icon}</div>}
      {title && <p className="text-sm font-medium text-fg-dim">{title}</p>}
      {children && <p className="max-w-xs text-sm text-fg-faint">{children}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** One crumb in a breadcrumb trail. A crumb with `onClick` renders as a button
 *  (a navigable ancestor); the last crumb is plain text (the current page). */
export type Crumb = { label: ReactNode; onClick?: () => void };

/** A breadcrumb trail for nested views. Renders nothing for a single crumb so
 *  top-level pages that only know their own name don't show a lone label. */
export function Breadcrumb({ items, className = "" }: { items: Crumb[]; className?: string }) {
  if (items.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className={`flex flex-wrap items-center gap-1.5 text-sm ${className}`}>
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {c.onClick && !last ? (
              <button
                onClick={c.onClick}
                className="text-fg-dim transition-colors hover:text-fg"
              >
                {c.label}
              </button>
            ) : (
              <span className={last ? "font-medium text-fg" : "text-fg-dim"} aria-current={last ? "page" : undefined}>
                {c.label}
              </span>
            )}
            {!last && <span className="text-fg-faint" aria-hidden>/</span>}
          </span>
        );
      })}
    </nav>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};

export function Button({ variant = "ghost", className = "", ...props }: ButtonProps) {
  const styles: Record<string, string> = {
    primary: "bg-accent text-accent-fg hover:opacity-90",
    ghost: "border border-line text-fg-muted hover:bg-surface-2",
    danger: "border border-critical/30 text-critical-fg hover:bg-critical-subtle",
  };
  return (
    <button
      {...props}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-page focus-visible:ring-accent disabled:opacity-50 ${styles[variant]} ${className}`}
    />
  );
}

const fieldClass =
  "w-full rounded-lg border border-line bg-input px-3 py-2 text-sm text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-page focus-visible:ring-accent";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldClass} ${props.className ?? ""}`} />;
}

/** SVG chevron as a data-URI, used as a CSS mask so it inherits `currentColor`
 *  and stays visible in both light and dark themes (a baked-in stroke colour
 *  would be invisible against one of them). */
const CHEVRON_SVG =
  "url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%20fill='none'%20stroke='black'%20stroke-width='1.5'%3E%3Cpath%20d='M4%206l4%204%204-4'/%3E%3C/svg%3E\")";

/** Select with native chrome stripped so its height matches Input exactly,
 *  plus a custom chevron that follows the muted text token via currentColor. */
export function Select({
  className = "",
  wrapperClassName = "w-full",
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  return (
    <div className={`relative ${wrapperClassName}`}>
      <select
        {...props}
        className={`${fieldClass} h-[38px] cursor-pointer appearance-none pr-9 ${className}`}
      >
        {children}
      </select>
      {/* Masked chevron: bg is currentColor (text-fg-dim), revealed by the mask. */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 bg-fg-dim"
        style={{
          maskImage: CHEVRON_SVG,
          WebkitMaskImage: CHEVRON_SVG,
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskSize: "contain",
          WebkitMaskSize: "contain",
        }}
      />
    </div>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={`${fieldClass} resize-y font-mono ${props.className ?? ""}`} />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-fg-dim">{children}</label>;
}

/** A collapsible "how this works" explainer. Starts collapsed so it never
 *  dominates a page; the open state is remembered in localStorage per `id`.
 *  `body` can be a string or any node; pass `items` for a labelled bullet list. */
export function InfoCard({
  id,
  title,
  openTitle,
  body,
  items,
  children,
}: {
  id: string;
  title: ReactNode;
  openTitle?: ReactNode;
  body?: ReactNode;
  items?: Array<{ label: ReactNode; text: ReactNode }>;
  children?: ReactNode;
}) {
  const key = `cct.info.${id}`;
  const [open, setOpen] = useState(() => localStorage.getItem(key) === "1");
  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      localStorage.setItem(key, next ? "1" : "0");
      return next;
    });
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="text-accent">ⓘ</span>
        <span className="flex-1">{open ? openTitle ?? title : title}</span>
        <span className="text-fg-dim">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-3 text-sm text-fg-dim">
          {body && <p>{body}</p>}
          {items && (
            <ul className="space-y-1.5">
              {items.map((it, i) => (
                <li key={i}>
                  <span className="font-medium text-fg">{it.label}</span> — {it.text}
                </li>
              ))}
            </ul>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/** A collapsible settings section used to group a long form into named,
 *  expandable blocks. Open state is remembered in localStorage per `id`.
 *  `defaultOpen` controls the first-ever state before any toggle. `badge`
 *  renders on the right of the header (e.g. a dirty-state dot). */
export function Accordion({
  id,
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `cct.acc.${id}`;
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(key);
    return saved == null ? defaultOpen : saved === "1";
  });
  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      localStorage.setItem(key, next ? "1" : "0");
      return next;
    });
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 bg-surface-2/40 px-3 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2"
      >
        <span className="flex-1">{title}</span>
        {badge}
        <span className="text-fg-dim">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="border-t border-line p-3">{children}</div>}
    </div>
  );
}

/** An animated grey placeholder bone for loading states. Pulses via Tailwind's
 *  `animate-pulse` and tints with the `bg-surface-2` theme token so it tracks
 *  light/dark/matrix themes. Pass width/height/rounding through `className`. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-surface-2 ${className}`}
    />
  );
}

/** An info callout. Pass `dismissId` to make it dismissible (remembered in
 *  localStorage) — for "good to keep in mind" style tips. */
export function Callout({
  title,
  children,
  dismissId,
}: {
  title: ReactNode;
  children: ReactNode;
  dismissId?: string;
}) {
  const { t } = useI18n();
  const key = dismissId ? `cct.tip.${dismissId}` : undefined;
  const [hidden, setHidden] = useState(() => (key ? localStorage.getItem(key) === "1" : false));
  if (hidden) return null;
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-accent">💡 {title}</span>
        {key && (
          <button
            onClick={() => {
              localStorage.setItem(key, "1");
              setHidden(true);
            }}
            className="text-xs text-fg-faint hover:text-fg-muted"
            aria-label={
              typeof title === "string"
                ? t("callout_dismiss_named").replace("{title}", title)
                : t("callout_dismiss")
            }
          >
            ✕
          </button>
        )}
      </div>
      <div className="text-fg-dim">{children}</div>
    </div>
  );
}

/** Per-variant accent (icon glyph, left-border colour, icon text colour),
 *  reusing the emerald/red/accent palette already used by Badge/Bar so
 *  light/dark/matrix all stay coherent. */
const TOAST_STYLES: Record<
  ToastVariant,
  { icon: LucideIcon; border: string; text: string }
> = {
  success: { icon: CheckCircle2, border: "border-l-ok", text: "text-ok-fg" },
  error: { icon: XCircle, border: "border-l-critical", text: "text-critical-fg" },
  info: { icon: Info, border: "border-l-accent", text: "text-accent" },
};

/** Single global toast stack. Mount once near the app root; it subscribes to
 *  the shared queue (`useToasts`) and renders fixed in the corner above all
 *  content. Each toast auto-dismisses (handled by the store) and has a manual
 *  close button. Up to 3 are shown at once (capped in the store). */
export function ToastViewport() {
  const { t } = useI18n();
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((toast) => {
        const style = TOAST_STYLES[toast.variant];
        const Icon = style.icon;
        return (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border border-l-4 border-line bg-surface px-3 py-2 shadow-lg ${style.border}`}
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.text}`} strokeWidth={2} />
            <p className="min-w-0 flex-1 break-words text-sm text-fg">{toast.message}</p>
            {toast.action && (
              <button
                onClick={() => actOnToast(toast.id)}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
              >
                {toast.action.label}
              </button>
            )}
            <button
              onClick={() => dismissToast(toast.id)}
              aria-label={t("toast_dismiss")}
              className="shrink-0 text-fg-faint transition-colors hover:text-fg-muted"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
