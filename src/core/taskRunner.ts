import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { runTurn, type RunResult } from "../claude/runner.js";
import { memoryMcp } from "../mcp/memory.js";
import { tasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { selfUpdateMcp } from "../mcp/selfUpdate.js";
import { getTask, setDelegate, updateTask } from "./tasks.js";
import { memory } from "./memory.js";
import { workers, type Worker } from "./workers.js";
import { getSkill } from "./skills.js";
import { getProvider } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";

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

  /**
   * Delegate a card to an autonomous run. Pass `leadId` to run it in that Lead's
   * persona/cwd/systemPrompt/skill/model/provider, so e.g. an Iris suggestion is
   * completed in Iris's voice and context. Without a leadId it's a generic run.
   */
  delegate(id: string, leadId?: string): { ok: boolean; error?: string } {
    const task = getTask(id);
    if (!task) return { ok: false, error: "not found" };
    if (this.active.has(id)) return { ok: false, error: "already running" };
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
    void this.execute(id, task.title, task.notes, runId, startedAt, abort, lead);
    return { ok: true };
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
        mcpServers: { memory: memoryMcp, tasks: tasksMcp, skills: skillsMcp, self_update: selfUpdateMcp },
        canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }),
        onText: (d) => {
          output += d;
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
        output: capOutput(output),
        error: res.isError ? res.text?.slice(0, 500) : undefined,
      });
      const finalColumn = res.isError ? undefined : "done";
      if (finalColumn) updateTask(id, { column: finalColumn });
      // On success, write a hot memory so the agent knows this task was done.
      // Useful for git commit messages and context across sessions.
      if (!res.isError) {
        const summary = (res.text ?? "").trim().slice(0, 400);
        const by = lead ? ` (by ${lead.name})` : "";
        memory.create({
          text: `Task completed${by}: ${title}${summary ? `. ${summary}` : ""}`,
          tags: ["task", "completed"],
          salience: 0.8,
          tier: "hot",
        });
      }
      await Promise.resolve(
        this.notify({ taskId: id, title, status: res.isError ? "error" : "ok", res, leadName: lead?.name }),
      ).catch(() => {});
    } catch (err) {
      const stopped = abort.signal.aborted;
      setDelegate(id, {
        status: stopped ? "stopped" : "error",
        runId,
        startedAt,
        endedAt: Date.now(),
        output: capOutput(output),
        error: stopped ? undefined : err instanceof Error ? err.message : String(err),
      });
      if (!stopped) log.error("Task delegation failed", { id, runId });
      await Promise.resolve(
        this.notify({
          taskId: id,
          title,
          status: stopped ? "stopped" : "error",
          error: stopped ? undefined : err instanceof Error ? err.message : String(err),
          leadName: lead?.name,
        }),
      ).catch(() => {});
    } finally {
      this.active.delete(id);
      const endTask = getTask(id);
      this.broadcast({ type: "task", event: "end", taskId: id, runId, delegate: endTask?.delegate, column: endTask?.column });
    }
  }
}

export const taskDelegator = new TaskDelegator();
