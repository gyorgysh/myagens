import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, XCircle, Info, X, type LucideIcon } from "lucide-react";
import { useI18n } from "../lib/useI18n";
import { actOnToast, dismissToast, useToasts, type ToastVariant } from "../lib/useToast.ts";
import { avatarSrc, resolveAvatarSlug } from "../lib/avatar.ts";

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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
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
  tone?: "zinc" | "green" | "amber" | "blue" | "cobalt" | "critical";
  className?: string;
}) {
  const tones: Record<string, string> = {
    zinc: "bg-surface-2 text-fg-muted",
    green: "bg-ok-subtle text-ok-fg",
    amber: "bg-warn-subtle text-warn-fg",
    blue: "bg-accent/15 text-accent",
    critical: "bg-critical-subtle text-critical-fg",
    // True blue — the "Private Chat on Web" counterpart to the green Telegram
    // badge. Fixed blue (not the theme accent) so it reads as a distinct channel.
    cobalt: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
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

/**
 * A modern model picker: a text field that always opens a dropdown of the
 * available options on click/focus, even when a value is already filled in
 * (unlike a native `<datalist>`, which hides once the field matches an option).
 * The list is filtered as you type but never fully collapses — you can always
 * see and pick from the built-in suggestions plus any live-fetched provider
 * models, and any custom id can still be typed by hand. Opening the dropdown on
 * an already-committed value shows the full list (the value is not treated as a
 * search query), and a clear "x" button resets the field to browse afresh.
 *
 * Pass `onFetch` to render a "fetch" button that loads provider models on
 * demand; results are merged into the dropdown ahead of the static suggestions.
 */
export function ModelSelect({
  value,
  onChange,
  suggestions,
  onFetch,
  fetchLabel = "Fetch",
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Built-in suggestions (e.g. Anthropic defaults). */
  suggestions: string[];
  /** When provided, renders a fetch button that resolves to provider models. */
  onFetch?: () => Promise<string[]>;
  fetchLabel?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [active, setActive] = useState(0);
  // Whether the user has actively edited the input since the dropdown opened.
  // Until they do, we show the full list rather than filtering by the committed
  // value, so a picked value never collapses the options down to just itself.
  const [editing, setEditing] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Merge fetched models (first, they're the most relevant) with the static
  // suggestions, de-duped and preserving order.
  const all = [...new Set([...fetched, ...suggestions])];
  // Only filter once the user actively edits the field. When the dropdown is
  // opened on a committed value (via focus/click/chevron), `editing` is false so
  // the whole list stays visible to browse and re-pick — the committed value is
  // not treated as a search query. This is the fix for the "stuck on picked
  // value" bug where filtering `all` by the exact committed id collapsed the
  // options down to that single entry.
  const q = editing ? value.trim().toLowerCase() : "";
  // Filter as the user types, but if nothing matches keep the full list visible
  // so the dropdown never goes empty just because a custom id was typed.
  const filtered = q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
  const options = filtered.length ? filtered : all;

  // Once the dropdown closes, forget any in-progress search so the next open
  // (on the now-committed value) shows the full list again instead of filtering.
  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The options list renders in a portal (to escape any ancestor's
      // overflow-hidden), so it's outside `ref`'s DOM subtree — check it too.
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !(listRef.current && listRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Track the input's on-screen position while open so the portalled options
  // list can be placed under it with `position: fixed`, immune to clipping by
  // any ancestor's `overflow-hidden` (e.g. the Settings Accordion).
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) setCoords({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  const doFetch = async () => {
    if (!onFetch || fetching) return;
    setFetching(true);
    try {
      setFetched(await onFetch());
      setOpen(true);
    } finally {
      setFetching(false);
    }
  };

  const pick = (m: string) => {
    onChange(m);
    setEditing(false);
    setOpen(false);
    inputRef.current?.focus();
  };

  const clear = () => {
    onChange("");
    setEditing(false);
    setActive(0);
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && options[active]) {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="flex gap-2">
      <div ref={ref} className="relative flex-1">
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          onChange={(e) => {
            onChange(e.target.value);
            setEditing(true);
            setActive(0);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKey}
          className={`${fieldClass} cursor-text ${value ? "pr-16" : "pr-9"}`}
        />
        {/* Clear button: resets the field and reopens the full list, a quick
            escape hatch when a picked value needs to be swapped out. */}
        {value && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear"
            onClick={clear}
            className="absolute right-9 top-0 flex h-full w-9 items-center justify-center text-fg-dim transition-colors hover:text-fg"
          >
            <X size={14} aria-hidden />
          </button>
        )}
        {/* Chevron toggles the dropdown without stealing the input's value. */}
        <button
          type="button"
          tabIndex={-1}
          aria-label="Toggle options"
          disabled={disabled}
          onClick={() => {
            setEditing(false);
            setOpen((o) => !o);
            inputRef.current?.focus();
          }}
          className="absolute right-0 top-0 flex h-full w-9 items-center justify-center text-fg-dim transition-colors hover:text-fg"
        >
          <span
            aria-hidden
            className="h-4 w-4 bg-fg-dim"
            style={{
              maskImage: CHEVRON_SVG,
              WebkitMaskImage: CHEVRON_SVG,
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
              maskSize: "contain",
              WebkitMaskSize: "contain",
            }}
          />
        </button>
        {open && options.length > 0 && coords &&
          createPortal(
            <ul
              ref={listRef}
              role="listbox"
              className="fixed z-50 max-h-60 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-xl"
              style={{ top: coords.top, left: coords.left, width: coords.width }}
            >
              {options.map((m, i) => {
                const selected = m === value;
                return (
                  <li key={m}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(m)}
                      className={`mono flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                        i === active ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-2"
                      }`}
                    >
                      <span className="truncate">{m}</span>
                      {selected && <CheckCircle2 size={14} className="shrink-0 text-accent" />}
                    </button>
                  </li>
                );
              })}
            </ul>,
            document.body,
          )}
      </div>
      {onFetch && (
        <Button onClick={() => void doFetch()} disabled={disabled || fetching} className="shrink-0">
          {fetching ? "…" : fetchLabel}
        </Button>
      )}
    </div>
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

/**
 * A circular agent avatar. Resolves the worker's avatar slug (explicit or a
 * deterministic default derived from its id) to a curated SVG and renders it
 * clipped to a circle. `size` is the pixel diameter.
 */
export function Avatar({
  id,
  avatar,
  size = 32,
  className = "",
  alt = "",
}: {
  id: string;
  avatar?: string;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const slug = resolveAvatarSlug(id, avatar);
  return (
    <img
      src={avatarSrc(slug)}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      className={`shrink-0 rounded-full bg-surface-2 object-cover ring-1 ring-line ${className}`}
      style={{ width: size, height: size }}
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

/** A modal dialog: full-screen backdrop, centred card, escape-to-close, and a
 *  focus trap that keeps Tab cycling within the dialog. Mount it conditionally
 *  (i.e. `{open && <Modal …/>}`) — it assumes it is only rendered when open.
 *  `onClose` fires on backdrop click, Escape, and the optional close button. */
export function Modal({
  onClose,
  children,
  className = "",
  labelledBy,
  closeButton = false,
  size = "lg",
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** id of the element that titles the dialog, for `aria-labelledby`. */
  labelledBy?: string;
  /** Render a small ✕ in the top-right corner. */
  closeButton?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const maxW = size === "sm" ? "max-w-sm" : size === "md" ? "max-w-md" : "max-w-lg";

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Focus the first focusable element (or the dialog itself) on open.
    const node = ref.current;
    const focusables = node?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );
    (focusables && focusables.length ? focusables[0] : node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <button aria-label={t("close")} tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div
        ref={ref}
        tabIndex={-1}
        className={`relative z-10 max-h-[85dvh] w-full ${maxW} overflow-y-auto rounded-2xl border border-line bg-surface shadow-xl outline-none ${className}`}
      >
        {closeButton && (
          <button
            onClick={onClose}
            aria-label={t("close")}
            className="absolute right-3 top-3 z-10 -m-2 rounded p-2 text-fg-faint transition-colors hover:text-fg-muted"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

/** A confirmation dialog built on Modal: title, description, and Cancel/Confirm
 *  buttons (Confirm uses the danger variant by default). Replaces native
 *  `confirm()` so destructive actions match the rest of the UI. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Confirm button uses the danger variant (default true). */
  danger?: boolean;
  /** Disable buttons while the action runs. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal onClose={onCancel} size="sm" labelledBy="confirm-dialog-title">
      <div className="p-4">
        <h3 id="confirm-dialog-title" className="text-sm font-semibold text-fg">
          {title}
        </h3>
        {description && <p className="mt-2 text-sm text-fg-dim">{description}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t("cancel")}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {confirmLabel ?? t("confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A popover: an absolutely-positioned card anchored to a trigger element, with
 *  click-outside and escape to dismiss. Wrap the trigger and pass `open`/`onClose`;
 *  the panel is positioned relative to the wrapper, so the wrapper must be the
 *  trigger's offset parent. `align` controls horizontal edge alignment. */
export function Popover({
  open,
  onClose,
  trigger,
  children,
  align = "end",
  className = "",
  panelClassName = "",
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  panelClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return (
    <div ref={ref} className={`relative ${className}`}>
      {trigger}
      {open && (
        <div
          role="dialog"
          className={`absolute top-full z-40 mt-1 min-w-[12rem] rounded-lg border border-line bg-surface p-1 shadow-xl ${align === "end" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {children}
        </div>
      )}
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
