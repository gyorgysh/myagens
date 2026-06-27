import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { runTurn, type RunResult } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { selfUpdateMcp } from "../mcp/selfUpdate.js";
import { buildConnectorMcps } from "../mcp/connectorsMcp.js";
import { getTask, setDelegate, updateTask, listTasks, archiveTask, prepareRetry, getTaskRunConfig } from "./tasks.js";
import { memory } from "./memory.js";
import { workers, type Worker } from "./workers.js";
import { getSkill } from "./skills.js";
import { getProvider } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { audit } from "./audit.js";
import { RunLogWriter } from "./runLog.js";
import { log, preview } from "../logger.js";
import { toolDiffMeta } from "../telegram/formatting.js";

const OUTPUT_HEAD = 3_000;
const OUTPUT_TAIL = 5_000;
const OUTPUT_MARKER = "\n\n[...TRUNCATED...]\n\n";

/**
 * Cap accumulated run output by keeping the first `OUTPUT_HEAD` and last
 * `OUTPUT_TAIL` chars with a marker between, so errors at the start aren't lost
 * to a plain tail-slice. Returns the string unchanged when it fits.
 */
function capOutput(s: string): string {
  if (s.length <= OUTPUT_HEAD + OUTPUT_TAIL) return s;
  return s.slice(0, OUTPUT_HEAD) + OUTPUT_MARKER + s.slice(-OUTPUT_TAIL);
}

type Broadcaster = (msg: unknown) => void;

/** Fired when a delegated run settles, so the President can be told over Telegram. */
export type TaskReport = {
  taskId: string;
  title: string;
  status: "ok" | "error" | "stopped";
  /** The run result, present when the run completed (ok or error, not stopped). */
  res?: RunResult;
  error?: string;
  /** Name of the Lead that ran it, when the card was routed to one. */
  leadName?: string;
};
type Notifier = (report: TaskReport) => void | Promise<void>;

/**
 * Delegate a kanban card to an autonomous agent run: the card's title + notes
 * become the prompt, the card moves to "doing", output streams to panel clients
 * over the hub (`{type:"task", …}` frames), and the card lands in "done" (or
 * keeps an error on its delegation state) when the run finishes. One run per
 * card at a time; reuses runTurn directly like the worker manager.
 */
/** A card waiting for a free concurrency slot. */
interface QueuedRun {
  id: string;
  leadId?: string;
}

export class TaskDelegator {
  private active = new Map<string, AbortController>();
  /** Cards waiting for a free slot when maxConcurrent is reached. */
  private queue: QueuedRun[] = [];
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
    this.queue = [];
    for (const a of this.active.values()) a.abort();
  }

  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  /** True when the card is queued (waiting for a concurrency slot). */
  isQueued(id: string): boolean {
    return this.queue.some((q) => q.id === id);
  }

  stop(id: string): boolean {
    // Drop from the wait queue if it hasn't started yet.
    const qi = this.queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      setDelegate(id, { status: "stopped", runId: "", startedAt: Date.now(), endedAt: Date.now() });
      this.broadcast({ type: "task", event: "end", taskId: id, runId: "", delegate: getTask(id)?.delegate, column: getTask(id)?.column });
      return true;
    }
    const a = this.active.get(id);
    if (!a) return false;
    a.abort();
    return true;
  }

  /**
   * Delegate a card to an autonomous run. Pass `leadId` to run it in that Lead's
   * persona/cwd/systemPrompt/skill/model/provider, so e.g. an Iris suggestion is
   * completed in Iris's voice and context. Without a leadId it's a generic run.
   */
  delegate(id: string, leadId?: string): { ok: boolean; error?: string; queued?: boolean } {
    const task = getTask(id);
    if (!task) return { ok: false, error: "not found" };
    if (this.active.has(id)) return { ok: false, error: "already running" };
    if (this.isQueued(id)) return { ok: false, error: "already queued" };

    // Respect the global concurrency limit: if all slots are full, park the
    // card in the queue and mark it "queued" so the panel can show it waiting.
    const { maxConcurrent } = getTaskRunConfig();
    if (maxConcurrent > 0 && this.active.size >= maxConcurrent) {
      this.queue.push({ id, leadId });
      setDelegate(id, { status: "queued", runId: "", startedAt: Date.now() });
      this.broadcast({ type: "task", event: "queued", taskId: id, column: task.column });
      log.info("Task delegate queued (at concurrency limit)", { taskId: id, title: task.title, active: this.active.size, max: maxConcurrent });
      return { ok: true, queued: true };
    }

    this.startRun(id, leadId);
    return { ok: true };
  }

  /** Actually launch a delegated run (capacity already checked by the caller). */
  private startRun(id: string, leadId?: string): void {
    const task = getTask(id);
    if (!task) return;
    const lead = leadId ? workers.get(leadId) : undefined;

    const runId = randomBytes(4).toString("hex");
    const startedAt = Date.now();
    const abort = new AbortController();
    this.active.set(id, abort);
    setDelegate(id, { status: "running", runId, startedAt, output: "" });
    const movedTo = task.column === "backlog" ? "doing" : task.column;
    if (task.column === "backlog") updateTask(id, { column: "doing" });
    this.broadcast({ type: "task", event: "start", taskId: id, runId, column: movedTo });
    audit("task.delegate", { id, runId, leadId: lead?.id });
    log.info("Task delegate starting", { taskId: id, title: task.title, runId, lead: lead?.name, model: lead?.model ?? config.CLAUDE_MODEL });
    void this.execute(id, task.title, task.notes, runId, startedAt, abort, lead);
  }

  /** After a run finishes, start the next queued card if a slot is free. */
  private pump(): void {
    const { maxConcurrent } = getTaskRunConfig();
    while (this.queue.length > 0 && (maxConcurrent <= 0 || this.active.size < maxConcurrent)) {
      const next = this.queue.shift()!;
      // Skip cards deleted/changed while waiting.
      if (!getTask(next.id)) continue;
      this.startRun(next.id, next.leadId);
    }
  }

  /**
   * Retry a failed card: reset it to backlog (clearing the error, bumping
   * retryCount), then immediately re-delegate. Returns the same shape as
   * delegate(). Used by the panel Retry button and the Telegram Retry inline
   * button. Refuses if the card is currently running.
   */
  retry(id: string, leadId?: string): { ok: boolean; error?: string; retryCount?: number } {
    if (this.active.has(id)) return { ok: false, error: "already running" };
    const task = prepareRetry(id);
    if (!task) return { ok: false, error: "not found" };
    const r = this.delegate(id, leadId);
    return { ...r, retryCount: task.retryCount };
  }

  private async execute(
    id: string,
    title: string,
    notes: string,
    runId: string,
    startedAt: number,
    abort: AbortController,
    lead?: Worker,
  ): Promise<void> {
    let output = "";
    // Full uncapped transcript on disk for the panel's "View full log".
    const transcript = new RunLogWriter(runId, { kind: "task", ownerId: id, ownerName: title });
    // Compact label for the Logs activity feed: a delegated card's full title can
    // be huge (especially "Run as one task" merges that glue many titles with
    // "; "), so the feed shows a short "Task"/"Bulk task" badge, the full title
    // rides along in `taskTitle` for the tooltip.
    const taskLabel = title.includes("; ") ? "Bulk task" : "Task";
    // Abort the run if it overruns the configured timeout (0 = no limit), so a
    // delegated card can't run indefinitely and burn tokens.
    const { timeoutMs } = getTaskRunConfig();
    let timedOut = false;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            log.warn("Task delegation timed out, aborting", { id, runId, timeoutMs });
            abort.abort();
          }, timeoutMs)
        : undefined;
    const prompt =
      `You are autonomously completing this kanban card.\n\nTitle: ${title}` +
      (notes ? `\n\nNotes:\n${notes}` : "") +
      `\n\nDo the work end to end. If it's too big, use the task_create tool to break it into ` +
      `subtasks (pass parentId "${id}"). When finished, give a short summary of what you did.`;
    // When routed to a Lead, run with that Lead's full context (mirrors crew_delegate).
    const skill = lead?.skillId ? getSkill(lead.skillId) : undefined;
    const append = lead
      ? [skill?.prompt, lead.systemPrompt].filter(Boolean).join("\n\n") || undefined
      : undefined;
    const provider = lead?.providerId ? getProvider(lead.providerId) : undefined;
    const env = provider
      ? {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
          ANTHROPIC_API_KEY: undefined,
        }
      : undefined;
    try {
      const res = await runTurn({
        prompt,
        cwd: lead?.cwd || config.WORKDIR,
        model: lead?.model,
        env,
        systemPromptAppend: append,
        persona: lead?.persona,
        permissionMode: "bypassPermissions",
        abortController: abort,
        mcpServers: { memory: memoryMcp, tasks: createTasksMcp({ createdBy: lead?.id ?? "atlas" }), skills: skillsMcp, self_update: selfUpdateMcp, ...buildConnectorMcps() },
        canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }),
        onText: (d) => {
          output += d;
          transcript.event({ ts: Date.now(), kind: "text", text: d });
          this.broadcast({ type: "task", event: "delta", taskId: id, runId, delta: d });
        },
        onToolUse: (name, input) => {
          const diff = toolDiffMeta(name, input);
          const arg = preview(typeof input === "string" ? input : JSON.stringify(input), 300);
          log.info("Tool use", { chatId: 0, tool: name, arg, task: taskLabel, taskTitle: title, taskId: id, lead: lead?.name, runId, ...(diff ?? {}) });
          transcript.event({ ts: Date.now(), kind: "tool", tool: name, arg });
          this.broadcast({ type: "task", event: "tool", taskId: id, runId, tool: name });
        },
        onToolResult: (isError) => transcript.event({ ts: Date.now(), kind: "result", isError }),
        onSessionId: () => {},
      });
      setDelegate(id, {
        status: res.isError ? "error" : "ok",
        runId,
        startedAt,
        endedAt: Date.now(),
        output: capOutput(output),
        error: res.isError ? res.text?.slice(0, 500) : undefined,
      });
      const finalColumn = res.isError ? undefined : "done";
      if (finalColumn) updateTask(id, { column: finalColumn });
      // If the run broke the card into subtasks, archive the parent card to
      // keep the backlog clean — the children carry the actual work forward.
      if (!res.isError) {
        const hadChildren = listTasks().some((t) => t.parentId === id);
        if (hadChildren) {
          archiveTask(id);
          log.info("Task parent archived after subtask breakdown", { taskId: id });
        }
      }
      // On success, write a hot memory so the agent knows this task was done.
      // Useful for git commit messages and context across sessions.
      if (!res.isError) {
        const summary = (res.text ?? "").trim().slice(0, 400);
        const by = lead ? ` (by ${lead.name})` : "";
        memory.create({
          text: `Task completed${by}: ${title}${summary ? `. ${summary}` : ""}`,
          tags: ["task", "completed"],
          salience: 0.8,
          tier: "warm",
        });
      }
      await Promise.resolve(
        this.notify({ taskId: id, title, status: res.isError ? "error" : "ok", res, leadName: lead?.name }),
      ).catch(() => {});
    } catch (err) {
      // A timeout aborts the run too, but it's a failure (error), not a manual stop.
      const stopped = abort.signal.aborted && !timedOut;
      const errMsg = timedOut ? "Timeout exceeded" : err instanceof Error ? err.message : String(err);
      setDelegate(id, {
        status: stopped ? "stopped" : "error",
        runId,
        startedAt,
        endedAt: Date.now(),
        output: capOutput(output),
        error: stopped ? undefined : errMsg,
      });
      if (!stopped) log.error("Task delegation failed", { id, runId, timedOut });
      await Promise.resolve(
        this.notify({
          taskId: id,
          title,
          status: stopped ? "stopped" : "error",
          error: stopped ? undefined : errMsg,
          leadName: lead?.name,
        }),
      ).catch(() => {});
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.active.delete(id);
      const endTask = getTask(id);
      const st = endTask?.delegate?.status ?? "ok";
      transcript.close({ status: st, isError: st === "error", durationMs: Date.now() - startedAt });
      this.broadcast({ type: "task", event: "end", taskId: id, runId, delegate: endTask?.delegate, column: endTask?.column });
      // A slot just freed up — start the next queued card.
      this.pump();
    }
  }
}

export const taskDelegator = new TaskDelegator();
