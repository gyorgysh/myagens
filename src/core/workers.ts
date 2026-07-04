import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { AUTO_ALLOWED_TOOLS } from "../claude/runner.js";
import { getBackend } from "./backends.js";
import { memoryMcp } from "../mcp/memory.js";
import { createTasksMcp } from "../mcp/tasks.js";
import { skillsMcp } from "../mcp/skills.js";
import { selfUpdateMcp } from "../mcp/selfUpdate.js";
import { createCrewMcp } from "../mcp/crew.js";
import { nextRun, parseWhen, describeSpec } from "../schedule/manager.js";
import type { ScheduleSpec } from "../schedule/store.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { getSkill, recordSkillUse } from "./skills.js";
import { getProvider } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { audit } from "./audit.js";
import { fireWebhook } from "./webhook.js";
import { RunLogWriter } from "./runLog.js";
import { log, preview } from "../logger.js";
import { toolDiffMeta } from "../telegram/formatting.js";
import type { Autonomy } from "../session/manager.js";
import { getLeadProtocol } from "../prompt.js";
import { agentUsage } from "./agentUsage.js";
import { guardCwd, cwdFallbackNotice } from "./cwdGuard.js";

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
  /** Model id override; falls back to CLAUDE_MODEL when empty. For a local
   *  provider this is that server's model name (e.g. "qwen/qwen3.6-35b-a3b"). */
  model?: string;
  /** Optional model-endpoint provider (local LM Studio/Ollama, a proxy, …). */
  providerId?: string;
  /** Agent backend id (see core/backends.ts); "" / unset = the default Claude
   *  Agent SDK backend. Lets one worker run on Grok/Codex while others stay
   *  on Claude. */
  backendId?: string;
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
  /** Avatar slug (e.g. "panda") from the curated set in panel/public/avatars.
   *  When unset, the panel derives a deterministic default from the worker id. */
  avatar?: string;
  // MyAgens hierarchy fields
  role?: "lead" | "assistant";
  portfolio?: string; // e.g. "Finance", "DevOps", "Research"
  parentId?: string; // assistant → id of its Lead
  telegramToken?: string; // vault:<id> reference for the lead's own bot
  /** The Lead bot's resolved @username (from getMe), for a t.me link. */
  botUsername?: string;
  /**
   * Character and tone. Injected into the system prompt after the base personality.
   * Separate from systemPrompt (domain knowledge / task instructions).
   */
  persona?: string;
  /**
   * Autonomy level for runs.
   * supervised = only AUTO_ALLOWED_TOOLS pass, risky tools denied.
   * standard   = AUTO_ALLOWED_TOOLS pass, risky tools denied (unattended).
   * full       = bypass all permissions (default — current behaviour).
   */
  autonomy?: Autonomy;
  /** BCP 47 language tag for this worker's preferred response language. */
  language?: string;
  /** Optional URL POSTed a JSON outcome payload when a run completes. */
  webhookUrl?: string;
  /**
   * Telegram streaming mode for Lead bots. Falls back to the global STREAM_MODE
   * config when unset. "rich" = Bot API 10.1 rich messages (default), "draft" =
   * Bot API 9.3 animated preview, "edit" = edit-in-place (legacy, professional look).
   */
  streamMode?: "rich" | "draft" | "edit";
  /**
   * Persisted escalation state for `auto_until_error` autonomy.
   * When set, this worker has hit a tool error and is in supervised cooldown.
   * Cleared when the next run starts (same semantics as `resetEscalation` for
   * chat sessions) so stale escalation doesn't block the worker permanently.
   * Survives restarts — that's the whole point of persisting it here.
   */
  escalated?: boolean;
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
  private onChangeCb?: () => void;

  constructor() {
    // A crash/SIGKILL mid-run leaves runs persisted as "running" forever — only
    // execute()'s finally settles them, and isRunning() is false after a restart,
    // so the history shows a perpetual "running" entry and lastRunAt/webhook never
    // fire. Reconcile on boot, mirroring taskRunner.reconcileStuck for cards.
    let fixed = 0;
    for (const r of this.runs) {
      if (r.status === "running") {
        r.status = "error";
        r.error = r.error ?? "Interrupted by a restart before completion.";
        r.endedAt = r.endedAt ?? Date.now();
        fixed++;
      }
    }
    if (fixed > 0) {
      saveJson<RunFile>(RUNS_FILE, { version: 1, runs: this.runs });
      log.warn("Reconciled interrupted worker runs on boot", { count: fixed });
    }
  }

  /** Notify on any registry mutation (create/update/remove), so a watcher (the
   *  Lead bot manager) can reconcile live without a restart. Wired in index.ts
   *  to keep telegraf out of this module. */
  onChange(cb: () => void): void {
    this.onChangeCb = cb;
  }

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

  /** All workers with role === "lead" that have a telegramToken set. */
  leads(): Worker[] {
    return this.workers.filter((w) => w.role === "lead" && w.telegramToken && w.enabled);
  }

  /**
   * Pick the most relevant Lead to hand a suggestion to, so an accepted idea is
   * worked by the right specialist. If the suggestion was filed BY a Lead, it
   * routes straight back to that Lead. Otherwise (e.g. Atlas filed it) it scores
   * every enabled Lead by keyword overlap between the suggestion's category/title
   * and the Lead's portfolio/name, returning the best match or undefined (→ a
   * generic run) when nothing matches well.
   */
  routeFor(input: { fromAgentId?: string; category?: string; title?: string }): Worker | undefined {
    // 1. Filed by a Lead → back to that Lead.
    if (input.fromAgentId) {
      const self = this.get(input.fromAgentId);
      if (self && self.role === "lead" && self.enabled) return self;
    }
    // 2. Score enabled Leads by keyword overlap with portfolio/name.
    const leads = this.workers.filter((w) => w.role === "lead" && w.enabled);
    if (leads.length === 0) return undefined;
    const needle = tokenize(`${input.category ?? ""} ${input.title ?? ""}`);
    if (needle.size === 0) return undefined;
    let best: { lead: Worker; score: number } | undefined;
    for (const lead of leads) {
      const hay = tokenize(`${lead.portfolio ?? ""} ${lead.name}`);
      let score = 0;
      for (const w of needle) if (hay.has(w)) score++;
      if (score > 0 && (!best || score > best.score)) best = { lead, score };
    }
    return best?.lead;
  }

  create(input: WorkerInput): Worker {
    const now = Date.now();
    const worker: Worker = {
      id: randomBytes(4).toString("hex"),
      name: input.name.trim() || "Untitled",
      cwd: input.cwd?.trim() || config.WORKDIR,
      prompt: input.prompt,
      model: input.model?.trim() || undefined,
      providerId: input.providerId || undefined,
      backendId: input.backendId || undefined,
      systemPrompt: input.systemPrompt?.trim() || undefined,
      skillId: input.skillId || undefined,
      schedule: parseSchedule(input.when),
      enabled: input.enabled ?? true,
      role: input.role || undefined,
      portfolio: input.portfolio?.trim() || undefined,
      parentId: input.parentId || undefined,
      telegramToken: input.telegramToken?.trim() || undefined,
      persona: input.persona?.trim() || undefined,
      autonomy: input.autonomy || undefined,
      language: input.language?.trim() || undefined,
      webhookUrl: input.webhookUrl?.trim() || undefined,
      avatar: input.avatar?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.workers.push(worker);
    this.persist();
    audit("worker.create", { id: worker.id, name: worker.name });
    this.onChangeCb?.();
    return worker;
  }

  update(id: string, input: Partial<WorkerInput>): Worker | undefined {
    const w = this.get(id);
    if (!w) return undefined;
    if (input.name !== undefined) w.name = input.name.trim() || w.name;
    if (input.cwd !== undefined) w.cwd = input.cwd.trim();
    if (input.prompt !== undefined) w.prompt = input.prompt;
    if (input.model !== undefined) w.model = input.model.trim() || undefined;
    if (input.providerId !== undefined) w.providerId = input.providerId || undefined;
    if (input.backendId !== undefined) w.backendId = input.backendId || undefined;
    if (input.systemPrompt !== undefined) w.systemPrompt = input.systemPrompt.trim() || undefined;
    if (input.skillId !== undefined) w.skillId = input.skillId || undefined;
    if (input.enabled !== undefined) w.enabled = input.enabled;
    if (input.when !== undefined) w.schedule = parseSchedule(input.when);
    if (input.role !== undefined) w.role = input.role || undefined;
    if (input.portfolio !== undefined) w.portfolio = input.portfolio.trim() || undefined;
    if (input.parentId !== undefined) w.parentId = input.parentId || undefined;
    if (input.telegramToken !== undefined) w.telegramToken = input.telegramToken.trim() || undefined;
    if (input.persona !== undefined) w.persona = input.persona.trim() || undefined;
    if (input.autonomy !== undefined) w.autonomy = input.autonomy || undefined;
    if (input.language !== undefined) w.language = input.language.trim() || undefined;
    if (input.webhookUrl !== undefined) w.webhookUrl = input.webhookUrl.trim() || undefined;
    if (input.avatar !== undefined) w.avatar = input.avatar.trim() || undefined;
    w.updatedAt = Date.now();
    this.persist();
    audit("worker.update", { id });
    this.onChangeCb?.();
    return w;
  }

  remove(id: string): boolean {
    const next = this.workers.filter((w) => w.id !== id);
    if (next.length === this.workers.length) return false;
    this.workers = next;
    this.persist();
    audit("worker.delete", { id });
    this.onChangeCb?.();
    return true;
  }

  /** Record a Lead bot's resolved @username (captured at bot start). Persists
   *  only when it actually changed, and skips the onChange/audit churn since
   *  this is incidental metadata, not a user edit. */
  setBotUsername(id: string, username: string): void {
    const w = this.workers.find((x) => x.id === id);
    if (w && w.botUsername !== username) {
      w.botUsername = username;
      this.persist();
    }
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

  /**
   * Fire an autonomous run for a worker. `promptOverride` lets the panel's
   * "Run Agent" modal kick off an ad-hoc run with an edited prompt without
   * mutating the saved worker; when absent the worker's stored prompt is used.
   */
  run(workerId: string, promptOverride?: string): WorkerRun | undefined {
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
    log.info("Worker run starting", { worker: w.name, workerId: w.id, runId: run.id, model: w.model ?? config.CLAUDE_MODEL });

    void this.execute(w, run, abort, promptOverride);
    return run;
  }

  private async execute(
    w: Worker,
    run: WorkerRun,
    abort: AbortController,
    promptOverride?: string,
  ): Promise<void> {
    const skill = w.skillId ? getSkill(w.skillId) : undefined;
    if (skill && w.skillId) recordSkillUse(w.skillId);
    // Lead workers identify as themselves (not Atlas). The protocol block is
    // passed as workerIdentity so it replaces the Atlas personality, not appends.
    const protocol = w.role === "lead" ? getLeadProtocol(w.name, w.portfolio) : undefined;
    const append = [skill?.prompt, w.systemPrompt].filter(Boolean).join("\n\n") || undefined;
    // Point the run at a local model server / proxy if a provider is set.
    // Clear ANTHROPIC_API_KEY so the auth token (not a stale key) is used.
    const provider = w.providerId ? getProvider(w.providerId) : undefined;
    const env = provider
      ? {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
          ANTHROPIC_API_KEY: undefined,
        }
      : undefined;

    const autonomy = w.autonomy ?? "full";
    // For unattended workers there is no human to approve tool calls, so:
    //   full             → bypassPermissions (default — current behaviour).
    //   auto_until_error → bypassPermissions when not escalated; "default" + deny
    //                      risky tools when escalated (persisted across restarts).
    //   standard         → auto-allow safe tools, deny risky ones silently.
    //   supervised       → deny everything that isn't in AUTO_ALLOWED_TOOLS.
    const permissionMode =
      autonomy === "full" || (autonomy === "auto_until_error" && !w.escalated)
        ? "bypassPermissions"
        : "default";

    // auto_until_error: clear any persisted escalation at the start of each run,
    // matching how chat sessions call resetEscalation() at the top of each turn.
    // The new run gets a clean slate — if it errors again, it re-escalates below.
    if (autonomy === "auto_until_error" && w.escalated) {
      w.escalated = false;
      this.persist();
      log.info("auto_until_error worker: cleared escalation for new run", { worker: w.id });
    }

    // Unattended worker: no human chat, so crew_suggest just files into the
    // president's inbox (notify is a no-op; it never DMs from a worker run).
    const crewMcp = createCrewMcp({
      notify: async () => {},
      primaryChatId: 0,
      fromAgentId: w.id,
    });

    // Full transcript writer (uncapped, NDJSON on disk) for the panel's
    // "View full log". The capped run.output stays the live/summary view.
    const transcript = new RunLogWriter(run.id, { kind: "worker", ownerId: w.id, ownerName: w.name });

    // Unattended run: no human chat to /cd back to safety, so a deleted/
    // obsolete cwd would otherwise fail every run forever with a low-level
    // spawn ENOENT. Fall back to the default workdir and surface the notice
    // in the run's own output/transcript instead of silently relocating.
    const requestedCwd = w.cwd;
    const guardedCwd = guardCwd(requestedCwd, { workerId: w.id });
    if (guardedCwd !== requestedCwd) {
      w.cwd = guardedCwd;
      this.persist();
      const notice = `${cwdFallbackNotice(requestedCwd)}\n\n`;
      run.output = (run.output + notice).slice(-OUTPUT_CAP);
      transcript.event({ ts: Date.now(), kind: "text", text: notice });
      this.broadcast({ type: "worker", event: "delta", runId: run.id, workerId: w.id, delta: notice });
    }

    try {
      const res = await getBackend(w.backendId).runTurn({
        prompt: promptOverride?.trim() || w.prompt,
        cwd: w.cwd,
        model: w.model,
        env,
        systemPromptAppend: append,
        workerIdentity: protocol,
        persona: w.persona,
        language: w.language,
        permissionMode,
        // Load full project context (CLAUDE.md, settings) in the worker's cwd, so
        // it operates like a real Claude Code session. (The earlier "exit 1" this
        // skipped was a corrupt-memory bug, fixed in memory.ts, not CLAUDE.md.)
        abortController: abort,
        mcpServers: { memory: memoryMcp, tasks: createTasksMcp({ createdBy: w.id }), skills: skillsMcp, self_update: selfUpdateMcp, crew: crewMcp },
        canUseTool: async (toolName, input) => {
          if (autonomy === "full") {
            // full: bypassPermissions handles everything; canUseTool is a no-op.
            return { behavior: "allow", updatedInput: input };
          }
          if (autonomy === "auto_until_error") {
            // Not escalated: bypassPermissions is active, so this gate isn't
            // normally reached. Allow as a belt-and-suspenders fallback.
            // Escalated: deny the risky tools, allow the safe set.
            if (AUTO_ALLOWED_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
            return { behavior: "deny", message: "Tool not permitted for unattended worker (escalated after tool error)." };
          }
          // supervised/standard: only AUTO_ALLOWED_TOOLS pass for unattended workers.
          if (AUTO_ALLOWED_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
          return { behavior: "deny", message: "Tool not permitted for unattended worker." };
        },
        onText: (delta) => {
          run.output = (run.output + delta).slice(-OUTPUT_CAP);
          transcript.event({ ts: Date.now(), kind: "text", text: delta });
          this.broadcast({ type: "worker", event: "delta", runId: run.id, workerId: w.id, delta });
        },
        onToolUse: (name, input) => {
          const diff = toolDiffMeta(name, input);
          log.info("Tool use", { chatId: 0, tool: name, arg: preview(summarize(input), 300), worker: w.name, workerId: w.id, runId: run.id, ...(diff ?? {}) });
          transcript.event({ ts: Date.now(), kind: "tool", tool: name, arg: summarize(input) });
          this.broadcast({
            type: "worker",
            event: "tool",
            runId: run.id,
            workerId: w.id,
            tool: name,
            arg: summarize(input),
          });
        },
        onToolResult: (isError) => {
          transcript.event({ ts: Date.now(), kind: "result", isError });
          // auto_until_error: persist escalation when a tool errors so the state
          // survives a bot restart (the safety regression described in the card).
          if (isError && autonomy === "auto_until_error" && !w.escalated) {
            w.escalated = true;
            this.persist();
            log.info("auto_until_error worker: tool error — persisting escalation", { worker: w.id });
          }
        },
        onSessionId: () => {},
      });
      run.status = res.isError ? "error" : "ok";
      run.costUsd = res.costUsd;
      run.durationMs = res.durationMs;
      if (res.isError && res.text) run.error = res.text.slice(0, 500);
      agentUsage.record(w.name, w.role === "lead" ? "lead" : "worker", {
        costUsd: res.costUsd ?? 0,
        durationMs: res.durationMs ?? 0,
        inputTokens: res.tokens?.inputTokens ?? 0,
        outputTokens: res.tokens?.outputTokens ?? 0,
        cacheReadTokens: res.tokens?.cacheReadTokens ?? 0,
        cacheWriteTokens: res.tokens?.cacheWriteTokens ?? 0,
      });
    } catch (err) {
      run.status = abort.signal.aborted ? "stopped" : "error";
      if (!abort.signal.aborted) run.error = err instanceof Error ? err.message : String(err);
      log.error("Worker run failed", { worker: w.id, runId: run.id, error: run.error });
    } finally {
      run.endedAt = Date.now();
      transcript.close({ status: run.status, isError: run.status === "error", costUsd: run.costUsd, durationMs: run.durationMs });
      w.lastRunAt = run.endedAt;
      w.lastRunId = run.id;
      this.active.delete(w.id);
      this.persist();
      this.broadcast({ type: "worker", event: "end", run });
      // Outbound webhook: push this run's outcome to the worker's configured URL.
      if (w.webhookUrl) {
        fireWebhook(w.webhookUrl, {
          source: "worker",
          title: w.name,
          id: w.id,
          status: run.status === "running" ? "ok" : run.status,
          summary: run.output?.slice(-2_000) || undefined,
          costUsd: run.costUsd,
          durationMs: run.durationMs,
          error: run.error,
          completedAt: new Date(run.endedAt).toISOString(),
        });
      }
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
  providerId?: string;
  backendId?: string;
  systemPrompt?: string;
  skillId?: string;
  /** Schedule token: "30m", "2h", "HH:MM", or "" / undefined for manual-only. */
  when?: string;
  enabled?: boolean;
  role?: "lead" | "assistant";
  portfolio?: string;
  parentId?: string;
  telegramToken?: string;
  persona?: string;
  autonomy?: Autonomy;
  language?: string;
  webhookUrl?: string;
  avatar?: string;
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

const STOPWORDS = new Set([
  "the", "and", "for", "with", "a", "an", "to", "of", "in", "on", "add", "new",
  "fix", "update", "make", "lead", "support", "system",
]);

/** Lowercase word set (≥3 chars, stopwords dropped) for cheap keyword overlap. */
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

export const workers = new WorkerManager();
