import { useEffect, useMemo, useRef, useState } from "react";
import { openHealthSocket, type PresenceClient } from "../api.ts";

const ID_KEY = "myagens.clientId";

/** Stable per-device id, persisted in localStorage (shared across this device's
 *  tabs). Falls back to an ephemeral id if storage is unavailable. */
function deviceId(): string {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return `c_${Math.random().toString(36).slice(2)}`;
  }
}

/** Best-effort human label like "Chrome on macOS" from the user agent. */
function deviceLabel(): string {
  const ua = navigator.userAgent || "";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "device";
  return `${browser} on ${os}`;
}

export interface PresenceState {
  /** This device's stable id. */
  self: string;
  /** All connected devices (deduped by id, oldest first). */
  clients: PresenceClient[];
  /** Other devices besides this one. */
  others: PresenceClient[];
}

/**
 * Subscribe to the panel presence roster over /ws. On connect this device sends
 * a `hello` handshake with its persisted id + label; the server replies (and
 * re-broadcasts on every join/leave) with the full device list. Used to show a
 * "multiple devices connected" banner so concurrent edits aren't a surprise.
 */
export function usePresence(): PresenceState {
  const self = useMemo(deviceId, []);
  const label = useMemo(deviceLabel, []);
  const [clients, setClients] = useState<PresenceClient[]>([]);
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: "hello", clientId: self, label }));
        } catch {
          /* socket raced shut */
        }
      };
      ws.onmessage = (e) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          return;
        }
        if ((parsed as { type?: string }).type !== "presence") return;
        setClients((parsed as { clients?: PresenceClient[] }).clients ?? []);
      };
      ws.onclose = () => {
        if (!closed) retryRef.current = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retryRef.current);
      ws?.close();
    };
  }, [self, label]);

  const others = useMemo(() => clients.filter((c) => c.clientId !== self), [clients, self]);
  return { self, clients, others };
}
