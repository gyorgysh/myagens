import { useCallback, useEffect, useRef } from "react";
import { openHealthSocket } from "../api.ts";

type AgentTermFrame =
  | { type: "agent-term"; agentId: string; event: "history"; data: string }
  | { type: "agent-term"; agentId: string; event: "data"; data: string }
  | { type: "agent-term"; agentId: string; event: "exit" }
  | { type: "agent-term"; agentId: string; event: "state"; state: string; rcUrl?: string }
  | { type: "agent-term"; agentId: string; event: "error"; error?: string };

export interface AgentTermHandlers {
  onData: (data: string) => void;
  onExit: () => void;
  onState?: (state: string, rcUrl?: string) => void;
  onError?: (error: string) => void;
}

/**
 * Subscribe to one agent's persistent tmux-instance terminal over the shared
 * /ws connection (frames are `{type:"agent-term", agentId, ...}`; this hook
 * filters to the given agentId). Sends "sub" on connect and "unsub" on
 * teardown; input frames are only forwarded by the server while take-control
 * is enabled via `setControl(true)`.
 */
export function useAgentTermSocket(
  agentId: string,
  handlers: AgentTermHandlers,
): {
  sendInput: (data: string) => void;
  setControl: (enabled: boolean) => void;
} {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "agent-term", agentId, event: "sub" }));
      };

      ws.onmessage = (e) => {
        let frame: AgentTermFrame;
        try {
          const parsed = JSON.parse(e.data as string);
          if (parsed?.type !== "agent-term" || parsed.agentId !== agentId) return;
          frame = parsed as AgentTermFrame;
        } catch {
          return;
        }
        if (frame.event === "history" || frame.event === "data") {
          handlersRef.current.onData(frame.data);
        } else if (frame.event === "exit") {
          handlersRef.current.onExit();
        } else if (frame.event === "state") {
          handlersRef.current.onState?.(frame.state, frame.rcUrl);
        } else if (frame.event === "error") {
          handlersRef.current.onError?.(frame.error ?? "viewer unavailable");
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!closed) retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      try {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "agent-term", agentId, event: "unsub" }));
        }
      } catch {
        /* socket already gone */
      }
      ws?.close();
      wsRef.current = null;
    };
  }, [agentId]);

  const sendInput = useCallback(
    (data: string) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "agent-term", agentId, event: "input", data }));
      }
    },
    [agentId],
  );

  const setControl = useCallback(
    (enabled: boolean) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "agent-term", agentId, event: "control", enabled }));
      }
    },
    [agentId],
  );

  return { sendInput, setControl };
}
