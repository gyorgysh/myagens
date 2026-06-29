// Single source of truth for backend liveness, shared across the whole app.
//
// The panel has ~9 feature-specific WS hooks that each silently retry on their
// own; none of them surfaced a global "the backend is down" signal, so a crash
// or a mid-restart looked like a frozen page. This hook owns ONE dedicated /ws
// connection purely for liveness and drives the global ConnectionBanner.
//
// States:
//   "live"         connected and receiving the hub's periodic health push
//   "reconnecting" we were connected and lost it; retrying with backoff
//   "offline"      repeated failures (or never connected) — backend likely down
//   "locked"       the backend returned 429 (brute-force lockout); we know the
//                  retry window, so we wait it out instead of hammering
//
// The hub broadcasts a health frame every ~2s on /ws, so a missing heartbeat for
// HEARTBEAT_TIMEOUT_MS means the socket is stale even if onclose never fired.

import { useCallback, useEffect, useRef, useState } from "react";
import { openHealthSocket, probeLockout } from "../api.ts";

export type ConnStatus = "live" | "reconnecting" | "offline" | "locked";

// After this many consecutive failed attempts we escalate reconnecting → offline.
const OFFLINE_AFTER_ATTEMPTS = 2;
// Retry backoff: capped so we keep probing roughly every few seconds.
const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 8000;
// If no frame arrives for this long while "connected", treat the socket as stale.
const HEARTBEAT_TIMEOUT_MS = 8000;

export interface Connection {
  status: ConnStatus;
  /** Seconds until the next automatic retry (0 when not waiting). */
  retryIn: number;
  /** Force an immediate reconnect attempt. */
  retryNow: () => void;
}

export function useConnection(): Connection {
  const [status, setStatus] = useState<ConnStatus>("reconnecting");
  const [retryIn, setRetryIn] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const closedRef = useRef(false);
  const attemptsRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const countdownTimer = useRef<ReturnType<typeof setInterval>>();
  const heartbeatTimer = useRef<ReturnType<typeof setTimeout>>();
  const connectRef = useRef<() => void>(() => {});

  const clearTimers = () => {
    clearTimeout(retryTimer.current);
    clearInterval(countdownTimer.current);
    clearTimeout(heartbeatTimer.current);
  };

  const armHeartbeat = useCallback(() => {
    clearTimeout(heartbeatTimer.current);
    heartbeatTimer.current = setTimeout(() => {
      // No frame in a while: the socket is silently stale. Drop it and let the
      // close handler kick off a fresh reconnect.
      try {
        wsRef.current?.close();
      } catch {
        /* already gone */
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }, []);

  // Start a live countdown to the next retry and arm the retry timer.
  const armRetry = useCallback((delayMs: number) => {
    let remaining = Math.ceil(delayMs / 1000);
    setRetryIn(remaining);
    clearInterval(countdownTimer.current);
    countdownTimer.current = setInterval(() => {
      remaining -= 1;
      setRetryIn(remaining > 0 ? remaining : 0);
      if (remaining <= 0) clearInterval(countdownTimer.current);
    }, 1000);
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => connectRef.current(), delayMs);
  }, []);

  const scheduleRetry = useCallback(() => {
    const attempt = attemptsRef.current;
    setStatus(attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    armRetry(delay);

    // The WS handshake can't read a 429, so a brute-force lockout is
    // indistinguishable from an outage here. Probe a REST endpoint to tell them
    // apart: if we're locked out, surface it and wait the full lockout window
    // (no point hammering — every attempt just refreshes nothing).
    void probeLockout().then((p) => {
      if (closedRef.current) return;
      if (p.locked) {
        setStatus("locked");
        if (p.retryAfterSec > 0) armRetry(p.retryAfterSec * 1000);
      }
    });
  }, [armRetry]);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    clearTimeout(retryTimer.current);
    clearInterval(countdownTimer.current);
    setRetryIn(0);

    let ws: WebSocket;
    try {
      ws = openHealthSocket();
    } catch {
      attemptsRef.current += 1;
      scheduleRetry();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      attemptsRef.current = 0;
      setStatus("live");
      armHeartbeat();
    };
    ws.onmessage = () => {
      // Any frame proves the backend is alive; reset the staleness timer.
      if (status !== "live") setStatus("live");
      armHeartbeat();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (closedRef.current) return;
      clearTimeout(heartbeatTimer.current);
      attemptsRef.current += 1;
      scheduleRetry();
    };
  }, [armHeartbeat, scheduleRetry, status]);

  // Keep a stable ref so the retry timer always calls the latest connect.
  connectRef.current = connect;

  const retryNow = useCallback(() => {
    attemptsRef.current = 0;
    clearTimers();
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
    setStatus("reconnecting");
    connectRef.current();
  }, []);

  useEffect(() => {
    closedRef.current = false;
    connectRef.current();

    // Reconnect promptly when the tab regains focus or the browser reports it's
    // back online — common after waking from sleep or a flaky network.
    const onWake = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      closedRef.current = true;
      clearTimers();
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", onWake);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, retryIn, retryNow };
}
