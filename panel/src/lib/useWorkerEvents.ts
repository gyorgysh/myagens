import { useEffect, useRef, useState } from "react";
import { openHealthSocket, type WorkerRun } from "../api.ts";

export interface LiveRun {
  runId: string;
  workerId: string;
  status: WorkerRun["status"];
  output: string;
  tool?: string;
}

type WorkerMsg =
  | { type: "worker"; event: "start" | "end"; run: WorkerRun }
  | { type: "worker"; event: "delta"; runId: string; workerId: string; delta: string }
  | { type: "worker"; event: "tool"; runId: string; workerId: string; tool: string; arg: string };

/** Subscribe to the shared /ws and track the latest run per worker live. */
export function useWorkerEvents(): Record<string, LiveRun> {
  const [byWorker, setByWorker] = useState<Record<string, LiveRun>>({});
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let closed = false;
    let ws: WebSocket;

    const set = (workerId: string, patch: (prev: LiveRun | undefined) => LiveRun) =>
      setByWorker((m) => ({ ...m, [workerId]: patch(m[workerId]) }));

    const connect = () => {
      if (closed) return;
      ws = openHealthSocket();
      // Clear the live overlay on every (re)connect: a run whose "end" frame was
      // missed during a socket gap would otherwise stay stuck "running" here. The
      // authoritative run list (loaded by the Workers view) shows through; any
      // genuinely-active run re-emits deltas.
      ws.onopen = () => {
        if (!closed) setByWorker({});
      };
      ws.onmessage = (e) => {
        let msg: WorkerMsg;
        try {
          const parsed = JSON.parse(e.data);
          if (parsed.type !== "worker") return;
          msg = parsed as WorkerMsg;
        } catch {
          return;
        }
        if (msg.event === "start") {
          set(msg.run.workerId, () => ({
            runId: msg.run.id,
            workerId: msg.run.workerId,
            status: "running",
            output: "",
          }));
        } else if (msg.event === "delta") {
          set(msg.workerId, (prev) => ({
            runId: msg.runId,
            workerId: msg.workerId,
            status: "running",
            output: (prev?.runId === msg.runId ? prev.output : "") + msg.delta,
            tool: prev?.runId === msg.runId ? prev.tool : undefined,
          }));
        } else if (msg.event === "tool") {
          set(msg.workerId, (prev) => ({
            runId: msg.runId,
            workerId: msg.workerId,
            status: "running",
            output: prev?.runId === msg.runId ? prev.output : "",
            tool: `${msg.tool} ${msg.arg}`.trim(),
          }));
        } else if (msg.event === "end") {
          set(msg.run.workerId, (prev) => ({
            runId: msg.run.id,
            workerId: msg.run.workerId,
            status: msg.run.status,
            output: prev?.runId === msg.run.id ? prev.output : msg.run.output,
            tool: undefined,
          }));
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

  return byWorker;
}
