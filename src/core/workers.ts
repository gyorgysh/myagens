import { randomBytes } from "node:crypto";
import { runTurn } from "../claude/runner.js";
import { nextRun, parseWhen, describeSpec } from "../schedule/manager.js";
import type { ScheduleSpec } from "../schedule/store.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { getSkill } from "./skills.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";

const FILE = "workers.json";
const RUNS_FILE = "workerRuns.json";
const TICK_MS = 30_000;
const RUN_HISTORY = 200;
const OUTPUT_CAP = 20_000; // chars of streamed output kept per run

export interface WorkerSchedule {
  spec: ScheduleSpec;
  nextRunAt: number;
}

/** A persisted, named autonomous agent. Runs `prompt` in `cwd` with bypassed
 *  permissions, optionally on a schedule, with an optional persona/skill. */
export interface Worker {
  id: string;
  name: string;
  cwd: string;
  /** The task prompt sent as the user turn each run. */
  prompt: string;
  /** Model id override; falls back to CLAUDE_MODEL when empty. */
  model?: string;
  /** Extra persona instructions appended to the system prompt. */
  systemPrompt?: string;
  /** Optional skill whose body augments the system prompt. */
  skillId?: string;
  schedule?: WorkerSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastRunId?: string;
}

export interface WorkerRun {
  id: string;
  workerId: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "ok" | "error" | "stopped";
  costUsd?: number;
  durationMs?: number;
  error?: string;
  /** Tail of streamed output (capped). */
  output: string;
}

interface WorkerFile {
  version: 1;
  workers: Worker[];
}
interface RunFile {
  version: 1;
  runs: WorkerRun[];
}

type Broadcaster = (msg: unknown) => void;

export class WorkerManager {
  private workers: Worker[] = loadJson<WorkerFile>(FILE, { version: 1, workers: [] }).workers;
  private runs: WorkerRun[] = loadJson<RunFile>(RUNS_FILE, { version: 1, runs: [] }).runs;
  private active = new Map<string, { abort: AbortController; run: WorkerRun }>();
  private timer?: ReturnType<typeof setInterval>;
  private broadcast: Broadcaster = () => {};

  /** Wire the panel hub and start the schedule tick. Idempotent. */
  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const { abort } of this.active.values()) abort.abort();
  }

  // --- registry CRUD ---

  list(): Worker[] {
    return [...this.workers].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Worker | undefined {
    return this.workers.find((w) => w.id === id);
  }

  create(input: WorkerInput): Worker {
    const now = Date.now();
    const worker: Worker = {
      id: randomBytes(4).toString("hex"),
      name: input.name.trim() || "Untitled",
      cwd: input.cwd.trim(),
      prompt: input.prompt,
      model: input.model?.trim() || undefined,
      systemPrompt: input.systemPrompt?.trim() || undefined,
      skillId: input.skillId || undefined,
      schedule: parseSchedule(input.when),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.workers.push(worker);
    this.persist();
    audit("worker.create", { id: worker.id, name: worker.name });
    return worker;
  }

  update(id: string, input: Partial<WorkerInput>): Worker | undefined {
    const w = this.get(id);
    if (!w) return undefined;
    if (input.name !== undefined) w.name = input.name.trim() || w.name;
    if (input.cwd !== undefined) w.cwd = input.cwd.trim();
    if (input.prompt !== undefined) w.prompt = input.prompt;
    if (input.model !== undefined) w.model = input.model.trim() || undefined;
    if (input.systemPrompt !== undefined) w.systemPrompt = input.systemPrompt.trim() || undefined;
    if (input.skillId !== undefined) w.skillId = input.skillId || undefined;
    if (input.enabled !== undefined) w.enabled = input.enabled;
    if (input.when !== undefined) w.schedule = parseSchedule(input.when);
    w.updatedAt = Date.now();
    this.persist();
    audit("worker.update", { id });
    return w;
  }

  remove(id: string): boolean {
    const next = this.workers.filter((w) => w.id !== id);
    if (next.length === this.workers.length) return false;
    this.workers = next;
    this.persist();
    audit("worker.delete", { id });
    return true;
  }

  // --- runs ---

  /** Recent runs, newest first, optionally filtered to one worker. */
  history(workerId?: string, limit = 50): WorkerRun[] {
    const all = [...this.runs].sort((a, b) => b.startedAt - a.startedAt);
    return (workerId ? all.filter((r) => r.workerId === workerId) : all).slice(0, limit);
  }

  isRunning(workerId: string): boolean {
    return this.active.has(workerId);
  }

  stopRun(workerId: string): boolean {
    const a = this.active.get(workerId);
    if (!a) return false;
    a.abort.abort();
    return true;
  }

  /** Launch a worker run. Rejects if one is already in flight for that worker. */
  run(workerId: string): WorkerRun | undefined {
    const w = this.get(workerId);
    if (!w) return undefined;
    if (this.active.has(workerId)) return this.active.get(workerId)!.run;

    const run: WorkerRun = {
      id: randomBytes(4).toString("hex"),
      workerId,
      startedAt: Date.now(),
      status: "running",
      output: "",
    };
    const abort = new AbortController();
    this.active.set(workerId, { abort, run });
    this.runs.push(run);
    this.trimRuns();
    this.persist();
    this.broadcast({ type: "worker", event: "start", run });
    audit("worker.run", { id: workerId, runId: run.id });

    void this.execute(w, run, abort);
    return run;
  }

  private async execute(w: Worker, run: WorkerRun, abort: AbortController): Promise<void> {
    const skill = w.skillId ? getSkill(w.skillId) : undefined;
    const append = [skill?.prompt, w.systemPrompt].filter(Boolean).join("\n\n") || undefined;
    try {
      const res = await runTurn({
        prompt: w.prompt,
        cwd: w.cwd,
        model: w.model,
        systemPromptAppend: append,
        permissionMode: "bypassPermissions",
        abortController: abort,
        mcpServers: {},
        canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
        onText: (delta) => {
          run.output = (run.output + delta).slice(-OUTPUT_CAP);
          this.broadcast({ type: "worker", event: "delta", runId: run.id, workerId: w.id, delta });
        },
        onToolUse: (name, input) => {
          this.broadcast({
            type: "worker",
            event: "tool",
            runId: run.id,
            workerId: w.id,
            tool: name,
            arg: summarize(input),
          });
        },
        onSessionId: () => {},
      });
      run.status = res.isError ? "error" : "ok";
      run.costUsd = res.costUsd;
      run.durationMs = res.durationMs;
      if (res.isError && res.text) run.error = res.text.slice(0, 500);
    } catch (err) {
      run.status = abort.signal.aborted ? "stopped" : "error";
      if (!abort.signal.aborted) run.error = err instanceof Error ? err.message : String(err);
      log.error("Worker run failed", { worker: w.id, runId: run.id, error: run.error });
    } finally {
      run.endedAt = Date.now();
      w.lastRunAt = run.endedAt;
      w.lastRunId = run.id;
      this.active.delete(w.id);
      this.persist();
      this.broadcast({ type: "worker", event: "end", run });
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const w of this.workers) {
      if (!w.enabled || !w.schedule) continue;
      if (w.schedule.nextRunAt > now) continue;
      if (this.active.has(w.id)) continue; // still running — try next tick
      w.schedule.nextRunAt = nextRun(w.schedule.spec, now);
      this.persist();
      this.run(w.id);
    }
  }

  private persist(): void {
    saveJson<WorkerFile>(FILE, { version: 1, workers: this.workers });
    saveJson<RunFile>(RUNS_FILE, { version: 1, runs: this.runs });
  }

  private trimRuns(): void {
    if (this.runs.length > RUN_HISTORY) {
      this.runs = this.runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, RUN_HISTORY);
    }
  }
}

export interface WorkerInput {
  name: string;
  cwd: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  skillId?: string;
  /** Schedule token: "30m", "2h", "HH:MM", or "" / undefined for manual-only. */
  when?: string;
  enabled?: boolean;
}

function parseSchedule(when?: string): WorkerSchedule | undefined {
  if (!when?.trim()) return undefined;
  const spec = parseWhen(when);
  if (!spec) return undefined;
  return { spec, nextRunAt: nextRun(spec, Date.now()) };
}

/** Human label for a worker's schedule, or "manual". */
export function describeWorkerSchedule(w: Worker): string {
  return w.schedule ? describeSpec(w.schedule.spec) : "manual";
}

function summarize(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  return String(o.command ?? o.file_path ?? o.pattern ?? o.path ?? "").slice(0, 80);
}

export const workers = new WorkerManager();
