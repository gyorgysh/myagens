// Global, hard-to-miss backend connection indicator. Mounted once at the app
// root so it shows on every tab. Hidden while the backend is live; slides in as
// an amber "reconnecting" bar (with a retry countdown + manual retry) when the
// connection drops, escalating to a red "offline" bar after repeated failures,
// and briefly flashes green "Reconnected" when it comes back.

import { useEffect, useRef, useState } from "react";
import { useConnection } from "../lib/useConnection.ts";
import { useI18n } from "../lib/useI18n.ts";

export function ConnectionBanner() {
  const { status, retryIn, retryNow } = useConnection();
  const { t } = useI18n();
  const prev = useRef(status);
  // Have we actually been live once and then lost it? Only then is reaching
  // "live" a genuine recovery worth flashing — not the initial connect on a
  // fresh page load (the hook starts in "reconnecting").
  const everLive = useRef(false);
  const [flashOk, setFlashOk] = useState(false);

  useEffect(() => {
    // Show a short "Reconnected" confirmation only when we recover from a real
    // drop: we'd previously been live, then went non-live, and are now back.
    if (status === "live" && prev.current !== "live" && everLive.current) {
      setFlashOk(true);
      const id = setTimeout(() => setFlashOk(false), 2500);
      prev.current = status;
      return () => clearTimeout(id);
    }
    if (status === "live") everLive.current = true;
    prev.current = status;
  }, [status]);

  const visible = status !== "live" || flashOk;
  if (!visible) return null;

  const ok = status === "live"; // showing the reconnected flash
  const offline = status === "offline";

  const tone = ok
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
    : offline
      ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40"
      : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40";

  const dot = ok ? "bg-emerald-500" : offline ? "bg-red-500" : "bg-amber-500";

  const title = ok
    ? t("conn_reconnected")
    : offline
      ? t("conn_offline")
      : t("conn_reconnecting");

  return (
    <div
      role="status"
      aria-live="polite"
      className={`sticky top-0 z-40 border-b px-4 py-2 text-sm ${tone}`}
    >
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
            {offline ? t("conn_offline_hint") : t("conn_reconnecting_hint")}
          </span>
        )}

        {!ok && (
          <span className="ml-auto flex items-center gap-2">
            {retryIn > 0 && (
              <span className="tabular-nums text-fg-dim">
                {t("conn_retry_in").replace("{s}", String(retryIn))}
              </span>
            )}
            <button
              onClick={retryNow}
              className="rounded-md border border-current/30 px-2 py-0.5 text-xs font-medium hover:bg-current/10"
            >
              {t("conn_retry_now")}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
