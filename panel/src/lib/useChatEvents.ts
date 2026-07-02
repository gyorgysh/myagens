import { useCallback, useEffect, useRef, useState } from "react";
import { api, openHealthSocket, type ApprovalView, type AskQuestionView, type ChatMessage, type ChatView } from "../api.ts";

export interface ChatStream {
  id: string;
  text: string;
  tool?: string;
  diffLines?: string;
  diffSnippet?: string;
}

type ChatMsg =
  | { type: "chat"; event: "user" | "end"; message: ChatMessage }
  | { type: "chat"; event: "start"; id: string }
  | { type: "chat"; event: "delta"; id: string; delta: string }
  | { type: "chat"; event: "tool"; id: string; tool: string; arg: string }
  | { type: "chat"; event: "busy"; busy: boolean }
  | { type: "chat"; event: "cleared" };

/** The approval-queue broadcast pushed whenever the pending set changes. */
type ApprovalsMsg = { type: "approvals"; approvals: ApprovalView[] };

/** The ask-queue broadcast pushed whenever the pending question set changes. */
type AsksMsg = { type: "asks"; asks: AskQuestionView[] };

/** Subscribe to the shared chat stream over /ws and track the live conversation
 *  (mirrored from the main Telegram chat): messages, the in-flight turn, busy. */
export function useChatEvents(onAuthError: () => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stream, setStream] = useState<ChatStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ChatView | null>(null);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [asks, setAsks] = useState<AskQuestionView[]>([]);
  const retryRef = useRef<ReturnType<typeof setTimeout>>();
  const refreshRef = useRef<() => void>(() => {});

  const refresh = useCallback(() => {
    api
      .chat()
      .then((v) => {
        setView(v);
        setMessages(v.messages);
        setBusy(v.busy);
        setApprovals(v.approvals ?? []);
        setAsks(v.asks ?? []);
      })
      .catch((e) => {
        if (e?.name === "AuthError") onAuthError();
      });
  }, [onAuthError]);

  refreshRef.current = refresh;
  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      // Re-sync REST state on every (re)connect: messages sent during a backend
      // restart / socket gap arrive only as WS events, so without this the
      // transcript would be missing them until a manual reload.
      ws.onopen = () => {
        if (!closed) refreshRef.current();
      };
      ws.onmessage = (e) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          return;
        }
        const t = (parsed as { type?: string }).type;
        if (t === "approvals") {
          setApprovals((parsed as ApprovalsMsg).approvals);
          return;
        }
        if (t === "asks") {
          setAsks((parsed as AsksMsg).asks);
          return;
        }
        if (t !== "chat") return;
        const m = parsed as ChatMsg;
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
            setStream((s) => (s ? { ...s, tool: `${m.tool} ${m.arg}`.trim() } : s));
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
  }, []);

  return { messages, stream, busy, view, setView, approvals, asks, refresh };
}
