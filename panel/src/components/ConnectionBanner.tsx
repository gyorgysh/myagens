// Global, hard-to-miss backend connection indicator. Mounted once at the app
// root so it shows on every tab. Hidden while the backend is live; slides in as
// an amber "reconnecting" bar (with a retry countdown + manual retry) when the
// connection drops, escalating to a red "offline" bar after repeated failures,
// and briefly flashes green "Reconnected" when it comes back.

import { useEffect, useRef, useState } from "react";
import { useConnection } from "../lib/useConnection.ts";
import { useI18n } from "../lib/useI18n.ts";
import { reloadFresh } from "../lib/reload.ts";

// After the backend has been fully offline (a restart/update/crash, not a brief
// blip) and comes back, the page often has stale view state and never recovers
// on its own, so do a hard reload once the connection is healthy again. This
// short grace period lets the freshly restarted server finish booting first.
const RELOAD_AFTER_RECOVERY_MS = 2000;

export function ConnectionBanner() {
  const { status, retryIn, retryNow } = useConnection();
  const { t } = useI18n();
  const prev = useRef(status);
  // Have we actually been live once and then lost it? Only then is reaching
  // "live" a genuine recovery worth flashing — not the initial connect on a
  // fresh page load (the hook starts in "reconnecting").
  const everLive = useRef(false);
  // Did the connection go fully "offline" (a real outage) at any point? A hard
  // reload only makes sense after a real restart/crash, not a momentary blip.
  const sawOutage = useRef(false);
  const [flashOk, setFlashOk] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (status === "offline" && everLive.current) sawOutage.current = true;

    // Recovered from a real drop: we'd previously been live, then went non-live,
    // and are now back.
    if (status === "live" && prev.current !== "live" && everLive.current) {
      if (sawOutage.current) {
        // The backend actually went down (restart/update/crash). Reload so every
        // view re-inits against the fresh server instead of hanging on stale state.
        // Drop the asset cache first: a restart is usually an update, and the
        // rebuilt panel bundle must not be served from a stale cache.
        setReloading(true);
        const id = setTimeout(() => void reloadFresh(), RELOAD_AFTER_RECOVERY_MS);
        prev.current = status;
        return () => clearTimeout(id);
      }
      // Just a brief blip: confirm and carry on without a reload.
      setFlashOk(true);
      const id = setTimeout(() => setFlashOk(false), 2500);
      prev.current = status;
      return () => clearTimeout(id);
    }
    if (status === "live") everLive.current = true;
    prev.current = status;
  }, [status]);

  const visible = status !== "live" || flashOk || reloading;
  if (!visible) return null;

  const ok = status === "live"; // showing the reconnected / reloading flash
  const offline = status === "offline";
  const locked = status === "locked";

  // Lockout and outage both read as "something is wrong" (critical red); a plain
  // reconnect is a softer amber.
  const tone = ok
    ? "bg-ok-subtle text-ok-fg border-ok/30"
    : offline || locked
      ? "bg-critical-subtle text-critical-fg border-critical/30"
      : "bg-warn-subtle text-warn-fg border-warn/30";

  const dot = ok ? "bg-ok" : offline || locked ? "bg-critical" : "bg-warn";

  const title = reloading
    ? t("conn_reloading")
    : ok
      ? t("conn_reconnected")
      : locked
        ? t("conn_locked")
        : offline
          ? t("conn_offline")
          : t("conn_reconnecting");

  // A lockout has a known retry window, so phrase the countdown as minutes
  // ("try again in ~N min") rather than the per-attempt "retrying in Ns".
  const retryLabel = locked
    ? t("conn_locked_retry").replace("{m}", String(Math.max(1, Math.ceil(retryIn / 60))))
    : retryIn > 0
      ? t("conn_retry_in").replace("{s}", String(retryIn))
      : "";

  return (
    // Opaque base layer so page content scrolling under this sticky bar can't
    // bleed through the translucent colour tint.
    <div role="status" aria-live="polite" className="sticky top-0 z-40 bg-page">
      <div className={`border-b px-4 py-2 text-sm ${tone}`}>
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {!ok && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${dot}`}
            />
          )}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot}`} />
        </span>

        <span className="font-medium">{title}</span>

        {!ok && (
          <span className="text-fg-dim">
            {locked
              ? t("conn_locked_hint")
              : offline
                ? t("conn_offline_hint")
                : t("conn_reconnecting_hint")}
          </span>
        )}

        {!ok && (
          <span className="ml-auto flex items-center gap-2">
            {retryLabel && (
              <span className="tabular-nums text-fg-dim">{retryLabel}</span>
            )}
            {/* During a lockout the backend will keep rejecting us until the
                window elapses, so a manual retry is pointless — hide it. */}
            {!locked && (
              <button
                onClick={retryNow}
                className="rounded-md border border-current/30 px-2 py-0.5 text-xs font-medium hover:bg-current/10"
              >
                {t("conn_retry_now")}
              </button>
            )}
          </span>
        )}
        </div>
      </div>
    </div>
  );
}
