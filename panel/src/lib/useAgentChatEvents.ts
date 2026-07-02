import { useCallback, useEffect, useRef, useState } from "react";
import { api, openHealthSocket, type AgentChatView, type ChatMessage } from "../api.ts";
import type { ChatStream } from "./useChatEvents.ts";

type AgentMsg =
  | { type: "agentchat"; event: "user" | "end"; agentId: string; message: ChatMessage }
  | { type: "agentchat"; event: "start"; agentId: string; id: string }
  | { type: "agentchat"; event: "delta"; agentId: string; id: string; delta: string }
  | { type: "agentchat"; event: "tool"; agentId: string; id: string; tool: string; arg: string; diffLines?: string; diffSnippet?: string }
  | { type: "agentchat"; event: "busy"; agentId: string; busy: boolean }
  | { type: "agentchat"; event: "cleared"; agentId: string };

/**
 * Subscribe to the per-agent chat stream for one worker / Lead. Mirrors
 * useChatEvents but keyed on `agentId`: only frames for the selected agent are
 * applied, and switching agents re-fetches that agent's transcript.
 */
export function useAgentChatEvents(agentId: string | null, onAuthError: () => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stream, setStream] = useState<ChatStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<AgentChatView | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout>>();
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback(() => {
    if (!agentId) return;
    api
      .agentChat(agentId)
      .then((v) => {
        setView(v);
        setMessages(v.messages);
        setBusy(v.busy);
        setStream(null);
      })
      .catch((e) => {
        if (e?.name === "AuthError") onAuthError();
      });
  }, [agentId, onAuthError]);

  refreshRef.current = refresh;

  // Re-fetch whenever the selected agent changes.
  useEffect(() => {
    setMessages([]);
    setStream(null);
    setBusy(false);
    setView(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!agentId) return;
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      // Re-sync this agent's transcript on every (re)connect so frames missed
      // during a socket gap aren't permanently absent.
      ws.onopen = () => {
        if (!closed) refreshRef.current();
      };
      ws.onmessage = (e) => {
        let m: AgentMsg;
        try {
          const parsed = JSON.parse(e.data);
          if (parsed.type !== "agentchat" || parsed.agentId !== agentId) return;
          m = parsed as AgentMsg;
        } catch {
          return;
        }
        switch (m.event) {
          case "user":
            setMessages((xs) => [...xs, m.message]);
            break;
          case "start":
            setStream({ id: m.id, text: "" });
            break;
          case "delta":
            setStream((s) => (s ? { ...s, text: s.text + m.delta } : { id: m.id, text: m.delta }));
            break;
          case "tool":
            setStream((s) => s ? { ...s, tool: `${m.tool} ${m.arg}`.trim(), diffLines: m.diffLines, diffSnippet: m.diffSnippet } : s);
            break;
          case "end":
            setStream(null);
            setMessages((xs) => [...xs, m.message]);
            break;
          case "busy":
            setBusy(m.busy);
            if (!m.busy) setStream(null);
            break;
          case "cleared":
            setMessages([]);
            setStream(null);
            break;
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
  }, [agentId]);

  return { messages, stream, busy, view, setView, refresh };
}
