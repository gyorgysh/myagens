import { useEffect, useRef, useState } from "react";
import { openHealthSocket, type TaskDelegation } from "../api.ts";

export interface LiveTask {
  runId: string;
  status: TaskDelegation["status"];
  output: string;
  tool?: string;
}

type TaskMsg =
  | { type: "task"; event: "start"; taskId: string; runId: string }
  | { type: "task"; event: "delta"; taskId: string; runId: string; delta: string }
  | { type: "task"; event: "tool"; taskId: string; runId: string; tool: string }
  | { type: "task"; event: "end"; taskId: string; runId: string; delegate?: TaskDelegation };

/**
 * Track live delegated-task runs over the shared /ws, keyed by task id. The
 * caller refreshes the board on `end` (via onEnd) to pick up the moved card.
 */
export function useTaskEvents(onEnd: () => void): Record<string, LiveTask> {
  const [byTask, setByTask] = useState<Record<string, LiveTask>>({});
  const retryRef = useRef<ReturnType<typeof setTimeout>>();
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const set = (id: string, patch: (p: LiveTask | undefined) => LiveTask) =>
      setByTask((m) => ({ ...m, [id]: patch(m[id]) }));

    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      ws.onmessage = (e) => {
        let m: TaskMsg;
        try {
          const parsed = JSON.parse(e.data);
          if (parsed.type !== "task") return;
          m = parsed as TaskMsg;
        } catch {
          return;
        }
        if (m.event === "start") {
          set(m.taskId, () => ({ runId: m.runId, status: "running", output: "" }));
        } else if (m.event === "delta") {
          set(m.taskId, (p) => ({
            runId: m.runId,
            status: "running",
            output: (p?.runId === m.runId ? p.output : "") + m.delta,
            tool: p?.runId === m.runId ? p.tool : undefined,
          }));
        } else if (m.event === "tool") {
          set(m.taskId, (p) => ({
            runId: m.runId,
            status: "running",
            output: p?.runId === m.runId ? p.output : "",
            tool: m.tool,
          }));
        } else if (m.event === "end") {
          set(m.taskId, (p) => ({
            runId: m.runId,
            status: m.delegate?.status ?? "ok",
            output: p?.runId === m.runId ? p.output : (m.delegate?.output ?? ""),
            tool: undefined,
          }));
          onEndRef.current();
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

  return byTask;
}
