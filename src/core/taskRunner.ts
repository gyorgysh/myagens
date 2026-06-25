import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { runTurn, type RunResult } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { tasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { selfUpdateMcp } from "../mcp/selfUpdate.js";
import { getTask, setDelegate, updateTask } from "./tasks.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";

const OUTPUT_CAP = 8_000;

type Broadcaster = (msg: unknown) => void;

/** Fired when a delegated run settles, so the President can be told over Telegram. */
export type TaskReport = {
  taskId: string;
  title: string;
  status: "ok" | "error" | "stopped";
  /** The run result, present when the run completed (ok or error, not stopped). */
  res?: RunResult;
  error?: string;
};
type Notifier = (report: TaskReport) => void | Promise<void>;

/**
 * Delegate a kanban card to an autonomous agent run: the card's title + notes
 * become the prompt, the card moves to "doing", output streams to panel clients
 * over the hub (`{type:"task", …}` frames), and the card lands in "done" (or
 * keeps an error on its delegation state) when the run finishes. One run per
 * card at a time; reuses runTurn directly like the worker manager.
 */
export class TaskDelegator {
  private active = new Map<string, AbortController>();
  private broadcast: Broadcaster = () => {};
  private notify: Notifier = () => {};

  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  /** Register a Telegram reporter, called when a delegated run settles. */
  onReport(notify: Notifier): void {
    this.notify = notify;
  }

  stopAll(): void {
    for (const a of this.active.values()) a.abort();
  }

  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  stop(id: string): boolean {
    const a = this.active.get(id);
    if (!a) return false;
    a.abort();
    return true;
  }

  delegate(id: string): { ok: boolean; error?: string } {
    const task = getTask(id);
    if (!task) return { ok: false, error: "not found" };
    if (this.active.has(id)) return { ok: false, error: "already running" };

    const runId = randomBytes(4).toString("hex");
    const startedAt = Date.now();
    const abort = new AbortController();
    this.active.set(id, abort);
    setDelegate(id, { status: "running", runId, startedAt, output: "" });
    if (task.column === "backlog") updateTask(id, { column: "doing" });
    this.broadcast({ type: "task", event: "start", taskId: id, runId });
    audit("task.delegate", { id, runId });
    void this.execute(id, task.title, task.notes, runId, startedAt, abort);
    return { ok: true };
  }

  private async execute(
    id: string,
    title: string,
    notes: string,
    runId: string,
    startedAt: number,
    abort: AbortController,
  ): Promise<void> {
    let output = "";
    const prompt =
      `You are autonomously completing this kanban card.\n\nTitle: ${title}` +
      (notes ? `\n\nNotes:\n${notes}` : "") +
      `\n\nDo the work end to end. If it's too big, use the task_create tool to break it into ` +
      `subtasks (pass parentId "${id}"). When finished, give a short summary of what you did.`;
    try {
      const res = await runTurn({
        prompt,
        cwd: config.WORKDIR,
        permissionMode: "bypassPermissions",
        abortController: abort,
        mcpServers: { memory: memoryMcp, tasks: tasksMcp, skills: skillsMcp, self_update: selfUpdateMcp },
        canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }),
        onText: (d) => {
          output = (output + d).slice(-OUTPUT_CAP);
          this.broadcast({ type: "task", event: "delta", taskId: id, runId, delta: d });
        },
        onToolUse: (name) => this.broadcast({ type: "task", event: "tool", taskId: id, runId, tool: name }),
        onSessionId: () => {},
      });
      setDelegate(id, {
        status: res.isError ? "error" : "ok",
        runId,
        startedAt,
        endedAt: Date.now(),
        output,
        error: res.isError ? res.text?.slice(0, 500) : undefined,
      });
      if (!res.isError) updateTask(id, { column: "done" });
      await Promise.resolve(
        this.notify({ taskId: id, title, status: res.isError ? "error" : "ok", res }),
      ).catch(() => {});
    } catch (err) {
      const stopped = abort.signal.aborted;
      setDelegate(id, {
        status: stopped ? "stopped" : "error",
        runId,
        startedAt,
        endedAt: Date.now(),
        output,
        error: stopped ? undefined : err instanceof Error ? err.message : String(err),
      });
      if (!stopped) log.error("Task delegation failed", { id, runId });
      await Promise.resolve(
        this.notify({
          taskId: id,
          title,
          status: stopped ? "stopped" : "error",
          error: stopped ? undefined : err instanceof Error ? err.message : String(err),
        }),
      ).catch(() => {});
    } finally {
      this.active.delete(id);
      this.broadcast({ type: "task", event: "end", taskId: id, runId, delegate: getTask(id)?.delegate });
    }
  }
}

export const taskDelegator = new TaskDelegator();
