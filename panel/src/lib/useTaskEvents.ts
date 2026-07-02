import { useEffect, useRef, useState } from "react";
import { openHealthSocket, type TaskDelegation } from "../api.ts";

export interface LiveTask {
  runId: string;
  status: TaskDelegation["status"];
  output: string;
  tool?: string;
  /** Epoch ms when this run started, captured from the "start" event (for the live timer). */
  startedAt?: number;
}

type TaskMsg =
  | { type: "task"; event: "start"; taskId: string; runId: string; column?: string }
  | { type: "task"; event: "delta"; taskId: string; runId: string; delta: string }
  | { type: "task"; event: "tool"; taskId: string; runId: string; tool: string }
  | { type: "task"; event: "queued"; taskId: string; column?: string }
  | { type: "task"; event: "queue"; paused: boolean }
  | { type: "task"; event: "refresh" }
  | { type: "task"; event: "end"; taskId: string; runId: string; delegate?: TaskDelegation; column?: string };

/**
 * Track live delegated-task runs over the shared /ws, keyed by task id.
 * onColumnMove is called on start and end when the server moved the card to a
 * different column, enabling the board to update optimistically without a
 * full reload. onQueuePaused fires when the queue is paused/resumed globally.
 */
export function useTaskEvents(
  onEnd: () => void,
  onColumnMove?: (taskId: string, column: string) => void,
  onQueuePaused?: (paused: boolean) => void,
): Record<string, LiveTask> {
  const [byTask, setByTask] = useState<Record<string, LiveTask>>({});
  const retryRef = useRef<ReturnType<typeof setTimeout>>();
  const onEndRef = useRef(onEnd);
  const onMoveRef = useRef(onColumnMove);
  const onQueueRef = useRef(onQueuePaused);
  onEndRef.current = onEnd;
  onMoveRef.current = onColumnMove;
  onQueueRef.current = onQueuePaused;

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const set = (id: string, patch: (p: LiveTask | undefined) => LiveTask) =>
      setByTask((m) => ({ ...m, [id]: patch(m[id]) }));

    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      // Reload the board on every (re)connect so a run whose "end" frame was
      // missed during a socket gap can't stay stuck showing "running" forever.
      ws.onopen = () => {
        if (!closed) onEndRef.current();
      };
      ws.onmessage = (e) => {
        let m: TaskMsg;
        try {
          const parsed = JSON.parse(e.data);
          if (parsed.type !== "task") return;
          m = parsed as TaskMsg;
        } catch {
          return;
        }
        if (m.event === "queue") {
          onQueueRef.current?.(m.paused);
          return;
        }
        if (m.event === "refresh") {
          // Recurring templates spawned new backlog cards — reload the board.
          onEndRef.current();
          return;
        }
        if (m.event === "queued") {
          set(m.taskId, () => ({ runId: "", status: "queued", output: "" }));
          if (m.column) onMoveRef.current?.(m.taskId, m.column);
          return;
        }
        if (m.event === "start") {
          set(m.taskId, () => ({ runId: m.runId, status: "running", output: "", startedAt: Date.now() }));
          if (m.column) onMoveRef.current?.(m.taskId, m.column);
        } else if (m.event === "delta") {
          set(m.taskId, (p) => ({
            runId: m.runId,
            status: "running",
            output: (p?.runId === m.runId ? p.output : "") + m.delta,
            tool: p?.runId === m.runId ? p.tool : undefined,
            startedAt: p?.runId === m.runId ? p.startedAt : Date.now(),
          }));
        } else if (m.event === "tool") {
          set(m.taskId, (p) => ({
            runId: m.runId,
            status: "running",
            output: p?.runId === m.runId ? p.output : "",
            tool: m.tool,
            startedAt: p?.runId === m.runId ? p.startedAt : Date.now(),
          }));
        } else if (m.event === "end") {
          set(m.taskId, (p) => ({
            runId: m.runId,
            status: m.delegate?.status ?? "ok",
            output: p?.runId === m.runId ? p.output : (m.delegate?.output ?? ""),
            tool: undefined,
          }));
          if (m.column) onMoveRef.current?.(m.taskId, m.column);
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
