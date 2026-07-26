import { useEffect, useRef } from "react";
import { openHealthSocket } from "../api.ts";
import { toast } from "./useToast.ts";

/**
 * Surface owner notices (heartbeat alerts, delegated-task outcomes, update
 * news, agent reports) as toasts.
 *
 * These are broadcast as `{ type: "notice", text }` by the server's notify hub,
 * which fans the same message out to every configured surface. The panel is one
 * of them — and on a panel-only install it is the only one, so without this the
 * user would never hear about anything happening in the background.
 */
export function useNoticeEvents(): void {
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;

    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      ws.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          if (parsed.type !== "notice" || typeof parsed.text !== "string") return;
          // Long-lived: a background alert is worth reading, and the user may
          // not have been looking at the tab when it arrived.
          toast.info(parsed.text, { durationMs: 15_000 });
        } catch {
          /* ignore non-JSON / unrelated frames */
        }
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
  }, []);
}
