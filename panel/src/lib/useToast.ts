import { useEffect, useState } from "react";

/**
 * Shared toast / notification queue. Replaces the per-component `flash()`
 * pattern (local state, no stacking, ad-hoc timeouts) with one global store.
 *
 * Follows the same global-singleton + listener shape as `useI18n`: state lives
 * in module scope, components subscribe via `useToasts()` and re-render on
 * change. Anything (even non-React code) can fire a toast with `toast.*`.
 *
 * Behaviour (per spec): success / error / info variants, a dismiss button,
 * at most MAX stacked at once (oldest dropped), auto-dismiss after AUTO_MS.
 */

export type ToastVariant = "success" | "error" | "info";

export type ToastAction = {
  /** Button label (already translated by the caller). */
  label: string;
  /** Invoked when the user taps the action; the toast then closes. */
  run: () => void;
};

export type Toast = {
  id: number;
  variant: ToastVariant;
  message: string;
  action?: ToastAction;
};

const MAX = 3;
const AUTO_MS = 4000;
/** Default window before an undoable action commits (per the card spec). */
const UNDO_MS = 5000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
// Callbacks run when a toast closes *without* its action having been taken
// (auto-dismiss or manual close). Used to commit a deferred (undoable) action.
const onExpire = new Map<number, () => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** Remove a toast by id (used by the auto-dismiss timer and the close button). */
export function dismissToast(id: number): void {
  clearTimer(id);
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  // Fire the deferred commit, if any (it wasn't undone before the toast closed).
  const expire = onExpire.get(id);
  if (expire) {
    onExpire.delete(id);
    expire();
  }
  if (toasts.length !== before) emit();
}

/** Run a toast's action button, then close it *without* firing onExpire. */
function runAction(id: number): void {
  const toastEntry = toasts.find((t) => t.id === id);
  // Drop the deferred commit first so closing the toast can't also fire it.
  onExpire.delete(id);
  clearTimer(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
  toastEntry?.action?.run();
}

/** Internal: dismiss a toast by running its action (the action button path). */
export function actOnToast(id: number): void {
  runAction(id);
}

type PushOpts = {
  action?: ToastAction;
  durationMs?: number;
  onExpire?: () => void;
};

function push(variant: ToastVariant, message: string, opts: PushOpts = {}): number {
  const id = nextId++;
  // Cap the stack: drop the oldest (and its timer) once we'd exceed MAX. This
  // closes the oldest, which also commits any deferred action it carried.
  const overflow = toasts.length + 1 - MAX;
  if (overflow > 0) {
    for (const old of toasts.slice(0, overflow)) dismissToast(old.id);
  }
  toasts = [...toasts, { id, variant, message, action: opts.action }];
  if (opts.onExpire) onExpire.set(id, opts.onExpire);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), opts.durationMs ?? AUTO_MS),
  );
  emit();
  return id;
}

/** Fire a toast from anywhere (components, async handlers, plain functions). */
export const toast = {
  success: (message: string) => push("success", message),
  error: (message: string) => push("error", message),
  /** `durationMs` overrides the default dwell — background alerts stay longer. */
  info: (message: string, opts: { durationMs?: number } = {}) => push("info", message, opts),
  /**
   * Show an undoable toast: the visual change should already be applied
   * optimistically by the caller. `onCommit` runs once the undo window closes
   * (auto-dismiss or manual close); `onUndo` runs instead if the user taps
   * Undo. Exactly one of the two fires.
   */
  undo: (
    message: string,
    opts: { undoLabel: string; onUndo: () => void; onCommit: () => void; durationMs?: number },
  ): number =>
    push("info", message, {
      durationMs: opts.durationMs ?? UNDO_MS,
      onExpire: opts.onCommit,
      action: { label: opts.undoLabel, run: opts.onUndo },
    }),
};

/** Subscribe to the live toast queue. Re-renders on any change. */
export function useToasts(): Toast[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const notify = () => tick((n) => n + 1);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, []);
  return toasts;
}
