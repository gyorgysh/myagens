import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { config, repoRoot, allowedUserIds } from "../config.js";
import { schedules, parseWhen } from "../schedule/manager.js";
import { maintenance } from "../core/maintenance.js";
import { getClaudeUsage } from "../core/claudeUsage.js";
import { loadProbeResult, runProbe, startProbeScheduler } from "../core/usageProbe.js";
import {
  getPlanSettings,
  setPlanSettings,
  billingPeriodStart,
  daysUntilReset,
} from "../core/planSettings.js";
import { AGENT_LANGUAGES } from "../core/languages.js";
import { log, onLog, recentLogs, availableLogDates, readLogFile, type LogEntry } from "../logger.js";
import { getHealth } from "../core/health.js";
import { listSessions, listSchedules, usageSummary } from "../core/snapshot.js";
import { getPrompt, savePlaybook } from "../core/playbook.js";
import { listSkills, createSkill, updateSkill, deleteSkill } from "../core/skills.js";
import { listClaudeFiles, readClaudeFile, writeClaudeFile } from "../core/claudeFiles.js";
import {
  listTasks,
  createTask,
  updateTask,
  reorderTasks,
  deleteTask,
  getWip,
  setWip,
  pruneArchive,
  autoArchive,
} from "../core/tasks.js";
import {
  listColumns,
  addColumn,
  renameColumn,
  removeColumn,
  reorderColumns,
} from "../core/columnConfig.js";
import { taskDelegator } from "../core/taskRunner.js";
import { workers, describeWorkerSchedule, type Worker } from "../core/workers.js";
import { chat } from "../core/chat.js";
import { memory, type MemoryEntry } from "../core/memory.js";
import { getStatus } from "../core/status.js";
import { heartbeat } from "../core/heartbeat.js";
import { listConnectors, setConnector } from "../core/connectors.js";
import { vault, importProviderSecrets, resolveSecret } from "../core/vault.js";
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
} from "../core/providers.js";
import { fetchProviderModels } from "../core/providerModels.js";
import { mainSettingsView, setMainSettings } from "../core/mainSettings.js";
import { embeddingConfig, setEmbeddingsEnabled, preferredBackend, setPreferredBackend, activeBackend, envEmbeddingMode, embeddingsAuto, enterAutoMode, type PreferredBackend } from "../core/embeddings.js";
import { ollamaStatus, connectOllama } from "../core/ollama.js";
import { lmStudioStatus, connectLmStudio } from "../core/lmstudio.js";
import { serviceInstalled, restartService } from "../core/agentControl.js";
import { isActive } from "../core/activity.js";
import { getUpdateStatus, checkForUpdate, runUpdate, runRestore } from "../core/updateControl.js";
import { recentAudit } from "../core/audit.js";
import { sessions } from "../session/manager.js";
import { ptyManager } from "../core/ptyManager.js";
import { PanelHub } from "./hub.js";
import { runTurn } from "../claude/runner.js";

const STATIC_DIR = join(repoRoot, "panel", "dist");

/** Version from package.json, read once at startup (for the Updates view). */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
})();

/**
 * Start the embedded management panel. In-process so its handlers read the live
 * SessionManager / ScheduleManager / WorkerManager singletons directly — no IPC.
 * Returns a stop function for graceful shutdown. No-op when disabled.
 */
export async function startPanel(): Promise<(() => Promise<void>) | undefined> {
  if (!config.PANEL_ENABLED) return undefined;
  if (!config.PANEL_TOKEN) {
    log.error("Panel enabled but PANEL_TOKEN missing — not starting panel");
    return undefined;
  }

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  const hub = new PanelHub();
  // Wire worker run events to all panel clients (worker tick already running).
  workers.start((m) => hub.broadcast(m));
  // Wire the in-panel chat session's stream to all clients.
  chat.start((m) => hub.broadcast(m));
  // Wire delegated-task run streams to all clients.
  taskDelegator.start((m) => hub.broadcast(m));
  // Wire the PTY terminal session to all clients.
  ptyManager.start((m) => hub.broadcast(m));
  // Stream live log lines to every panel client.
  const unsubLog = onLog((entry) => hub.broadcast({ type: "log", entry }));

  // Refresh the "update available" status in the background so the nav badge is
  // reasonably fresh: once shortly after boot, then every 6 hours.
  setTimeout(() => void checkForUpdate(), 10_000).unref();
  const updateTimer = setInterval(() => void checkForUpdate(), 6 * 3_600_000);
  updateTimer.unref();

  // Auth: every /api and /ws request needs the shared token. Static SPA assets
  // are served freely (they hold no secrets; the token gates the data + actions).
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") && !req.url.startsWith("/ws")) return;
    if (!tokenOk(req)) await reply.code(401).send({ error: "unauthorized" });
  });

  registerApi(app, hub);
  registerWs(app, hub);
  await registerStatic(app);

  try {
    await app.listen({ host: config.PANEL_HOST, port: config.PANEL_PORT });
    log.info("Management panel listening", {
      url: `http://${config.PANEL_HOST}:${config.PANEL_PORT}`,
      static: existsSync(STATIC_DIR) ? "built" : "missing (run npm run build:panel)",
    });
  } catch (err) {
    log.error("Panel failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  return async () => {
    unsubLog();
    clearInterval(updateTimer);
    workers.stop();
    taskDelegator.stopAll();
    ptyManager.kill();
    hub.stop();
    await app.close();
  };
}

function tokenOk(req: FastifyRequest): boolean {
  const expected = config.PANEL_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization;
  const fromHeader = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const q = req.query as Record<string, unknown>;
  const fromQuery = typeof q?.token === "string" ? q.token : undefined;
  const provided = fromHeader ?? fromQuery;
  return provided !== undefined && safeEqual(provided, expected);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Panel view of a worker: registry fields + derived run state. */
function workerView(w: Worker) {
  return {
    id: w.id,
    name: w.name,
    cwd: w.cwd,
    prompt: w.prompt,
    model: w.model ?? "",
    providerId: w.providerId ?? "",
    systemPrompt: w.systemPrompt ?? "",
    skillId: w.skillId ?? "",
    schedule: describeWorkerSchedule(w),
    when: w.schedule
      ? w.schedule.spec.kind === "interval"
        ? `${Math.round(w.schedule.spec.everyMs / 60000)}m`
        : `${String(w.schedule.spec.hour).padStart(2, "0")}:${String(w.schedule.spec.minute).padStart(2, "0")}`
      : "",
    nextRunAt: w.schedule?.nextRunAt,
    enabled: w.enabled,
    running: workers.isRunning(w.id),
    lastRunAt: w.lastRunAt,
    lastRunId: w.lastRunId,
    role: w.role ?? "",
    portfolio: w.portfolio ?? "",
    parentId: w.parentId ?? "",
    telegramToken: w.telegramToken ?? "",
    persona: w.persona ?? "",
    autonomy: w.autonomy ?? "full",
    language: w.language ?? "",
  };
}

function registerApi(app: FastifyInstance, hub: PanelHub): void {
  app.get("/api/me", async () => ({
    ok: true,
    chatEnabled: chat.isEnabled(),
    version: VERSION,
    updateAvailable: getUpdateStatus().available,
    atlasName: config.ATLAS_NAME,
    brandName: config.BRAND_NAME,
    defaultLanguage: config.DEFAULT_LANGUAGE,
    languages: AGENT_LANGUAGES,
  }));

  // --- main agent: runtime model/provider + lifecycle controls ---
  app.get("/api/agent", async () => ({
    ...mainSettingsView(),
    serviceInstalled: serviceInstalled(),
    embeddings: embeddingConfig(),
    preferredBackend: preferredBackend(),
    activeBackend: activeBackend(),
    // "auto" follows the startup probe; "on"/"off" are forced by EMBEDDING_ENABLED
    // in .env and lock the panel control. embeddingAuto reflects runtime auto mode.
    embeddingEnvMode: envEmbeddingMode(),
    embeddingAuto: embeddingsAuto(),
  }));
  app.put("/api/agent/embeddings", async (req) => {
    const { enabled, provider, baseUrl, model } = (req.body ?? {}) as {
      enabled: boolean;
      provider?: "ollama" | "openai";
      baseUrl?: string;
      model?: string;
    };
    setEmbeddingsEnabled(enabled, { provider, baseUrl, model });
    return { embeddings: embeddingConfig(), activeBackend: activeBackend(), embeddingAuto: embeddingsAuto() };
  });
  // Return embeddings to auto mode (drop a manual pin) and probe backends now.
  app.post("/api/agent/embeddings/auto", async () => {
    await enterAutoMode();
    return { embeddings: embeddingConfig(), activeBackend: activeBackend(), embeddingAuto: embeddingsAuto() };
  });
  // Preferred local backend when both Ollama and LM Studio are running.
  app.put("/api/agent/embeddings/preferred", async (req) => {
    const { preferredBackend: pref } = (req.body ?? {}) as { preferredBackend?: PreferredBackend | null };
    setPreferredBackend(pref === "ollama" || pref === "lmstudio" ? pref : null);
    return { preferredBackend: preferredBackend() };
  });
  app.put("/api/agent", async (req) => {
    const { model, providerId, persona, autonomy, defaultLanguage } = (req.body ?? {}) as {
      model?: string;
      providerId?: string;
      persona?: string;
      autonomy?: string;
      defaultLanguage?: string;
    };
    setMainSettings({
      model,
      providerId,
      persona,
      autonomy: autonomy as "supervised" | "standard" | "full" | "auto_until_error" | undefined,
      defaultLanguage,
    });
    return mainSettingsView();
  });
  // Abort in-flight turns and clear all conversation context (fresh slate).
  app.post("/api/agent/reset", async () => sessions.resetAll());
  // Full process respawn via the service manager (no-op if not a service).
  app.post("/api/agent/restart", async (_req, reply) => {
    if (!serviceInstalled())
      return reply.code(409).send({ error: "no service manager detected — restart manually" });
    restartService();
    return { ok: true, restarting: true };
  });

  // --- read-only dashboards ---
  app.get("/api/health", async () => getHealth());
  app.get("/api/status", async () => getStatus());
  app.get("/api/sessions", async () => ({ sessions: listSessions() }));
  app.get("/api/schedules", async () => ({ schedules: listSchedules() }));
  app.post("/api/schedules", async (req, reply) => {
    const { prompt, when, cwd, chatId } = (req.body ?? {}) as {
      prompt?: string;
      when?: string;
      cwd?: string;
      chatId?: number;
    };
    if (!prompt?.trim()) return reply.code(400).send({ error: "prompt required" });
    const spec = parseWhen(when ?? "");
    if (!spec) return reply.code(400).send({ error: "invalid schedule (use 30m, 2h, 1d, or HH:MM)" });
    const target = chatId ?? [...allowedUserIds][0];
    if (target === undefined) return reply.code(400).send({ error: "no allowed user to own the schedule" });
    schedules.add(target, cwd?.trim() || config.WORKDIR, prompt.trim(), spec);
    return { schedules: listSchedules() };
  });
  app.put("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as { prompt?: string; when?: string; cwd?: string; chatId?: number };
    const updated = schedules.updateById(id, patch);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return { schedules: listSchedules() };
  });
  app.put("/api/schedules/:id/enabled", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled (boolean) required" });
    const updated = schedules.setEnabled(id, enabled);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return { schedules: listSchedules() };
  });
  app.post("/api/schedules/:id/run", async (req, reply) => {
    const result = await schedules.runNow((req.params as { id: string }).id);
    if (result === "not_found") return reply.code(404).send({ error: "not found" });
    if (result === "no_runner") return reply.code(503).send({ error: "scheduler not started" });
    if (result === "busy") return reply.code(409).send({ error: "chat busy" });
    return { ok: true, schedules: listSchedules() };
  });
  app.delete("/api/schedules/:id", async (req, reply) => {
    if (!schedules.removeById((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.get("/api/usage", async () => usageSummary());
  app.get("/api/audit", async () => ({ events: recentAudit() }));
  // GET /api/logs
  //   ?date=YYYY-MM-DD  — read from the persisted file for that date
  //                        (omit to get the live in-memory ring for today)
  //   &q=text           — case-insensitive substring search across msg + meta
  //   &level=info       — filter to a single level
  //   &limit=2000       — max entries returned (default 2000)
  // GET /api/logs/dates — list available log dates, newest first
  app.get("/api/logs/dates", async () => ({ dates: availableLogDates() }));
  app.get("/api/logs", async (req) => {
    const { date, q, level, limit } = (req.query ?? {}) as Record<string, string | undefined>;
    if (date) {
      // Validate date format before hitting the filesystem.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { logs: [] };
      }
      return {
        logs: readLogFile(date, {
          q,
          level: level as LogEntry["level"] | undefined,
          limit: limit ? Number(limit) : undefined,
        }),
      };
    }
    // No date — return live ring buffer, with optional client-side-compatible
    // in-process filtering so the panel can reuse the same path.
    let logs = recentLogs();
    if (level) logs = logs.filter((e) => e.level === level);
    if (q) {
      const needle = q.toLowerCase();
      logs = logs.filter(
        (e) =>
          e.msg.toLowerCase().includes(needle) ||
          (e.meta ? JSON.stringify(e.meta).toLowerCase().includes(needle) : false),
      );
    }
    if (limit) logs = logs.slice(-Number(limit));
    return { logs };
  });

  // --- system prompt / playbook ---
  app.get("/api/prompt", async () => getPrompt());
  app.put("/api/prompt", async (req) => {
    const { content } = (req.body ?? {}) as { content?: string };
    return savePlaybook(typeof content === "string" ? content : "");
  });

  // --- prompt library (skills) ---
  app.get("/api/skills", async (req) => {
    const q = req.query as { archived?: string };
    return { skills: listSkills(q.archived === "true") };
  });
  app.post("/api/skills", async (req) => createSkill(req.body as never));
  app.put("/api/skills/:id", async (req, reply) => {
    const updated = updateSkill((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.delete("/api/skills/:id", async (req, reply) => {
    if (!deleteSkill((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // --- heartbeat (proactive monitoring) ---
  app.get("/api/heartbeat", async () => heartbeat.view());
  app.put("/api/heartbeat", async (req) => {
    heartbeat.setConfig((req.body ?? {}) as never);
    return heartbeat.view();
  });
  app.post("/api/heartbeat/run", async () => heartbeat.runOnce("panel"));
  // Send a usage/cost report to Telegram right now (panel "Test" button).
  app.post("/api/plan/report-test", async () => heartbeat.sendCostReport());

  // --- self-update ---
  app.get("/api/update", async () => ({ ...getUpdateStatus(), serviceInstalled: serviceInstalled(), active: isActive() }));
  app.post("/api/update/check", async () => ({ ...(await checkForUpdate()), serviceInstalled: serviceInstalled(), active: isActive() }));
  app.post("/api/update/run", async () => {
    if (getUpdateStatus().updating) return { started: false };
    // Stream output to panel clients; don't await (the run may restart us).
    void runUpdate((line) => hub.broadcast({ type: "update", line })).catch(() => {});
    return { started: true };
  });
  app.post("/api/update/restore", async () => {
    if (getUpdateStatus().updating) return { started: false };
    // Recovery: hard-reset code to the remote (keeps data/config), rebuild,
    // restart. Stream to panel clients; don't await (the run may restart us).
    void runRestore((line) => hub.broadcast({ type: "update", line })).catch(() => {});
    return { started: true };
  });

  // --- durable memory ---
  // Drop the (large) raw embedding vector from API responses; the panel never
  // needs it and it would bloat every payload.
  const stripEmbedding = (e: MemoryEntry): Omit<MemoryEntry, "embedding"> & { embedded: boolean } => {
    const { embedding, ...rest } = e;
    return { ...rest, embedded: !!(embedding && embedding.length) };
  };
  app.get("/api/memories", async (req) => {
    const { q, all } = req.query as { q?: string; all?: string };
    if (q) {
      const hits = await memory.semanticSearch(q, 50, all === "true");
      return { memories: hits.map(stripEmbedding) };
    }
    return { memories: memory.list().map(stripEmbedding) };
  });
  app.post("/api/memories", async (req) => stripEmbedding(memory.create(req.body as never)));
  app.put("/api/memories/:id", async (req, reply) => {
    const updated = memory.update((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return stripEmbedding(updated);
  });
  app.patch("/api/memories/:id/tier", async (req, reply) => {
    const { tier } = (req.body ?? {}) as { tier?: string };
    if (tier !== "hot" && tier !== "warm" && tier !== "cold")
      return reply.code(400).send({ error: "tier must be hot, warm, or cold" });
    const updated = memory.setTier((req.params as { id: string }).id, tier);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return stripEmbedding(updated);
  });
  app.delete("/api/memories/:id", async (req, reply) => {
    if (!memory.remove((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // --- external connectors (placeholders) ---
  app.get("/api/connectors", async () => ({ connectors: listConnectors() }));
  app.put("/api/connectors/:id", async (req, reply) => {
    const updated = setConnector((req.params as { id: string }).id, (req.body ?? {}) as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });

  // --- secret vault ---
  app.get("/api/vault", async () => ({ secrets: vault.list() }));
  app.post("/api/vault", async (req) => vault.create(req.body as never));
  app.put("/api/vault/:id", async (req, reply) => {
    const updated = vault.update((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.delete("/api/vault/:id", async (req, reply) => {
    if (!vault.remove((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.get("/api/vault/:id/reveal", async (req, reply) => {
    const value = vault.reveal((req.params as { id: string }).id);
    if (value === undefined) return reply.code(404).send({ error: "not found" });
    return { value };
  });
  app.post("/api/vault/import", async () => importProviderSecrets());

  // --- on-disk .claude files ---
  app.get("/api/claude-files", async () => ({ roots: listClaudeFiles() }));
  app.get("/api/claude-files/content", async (req, reply) => {
    const path = (req.query as { path?: string }).path;
    const content = path ? readClaudeFile(path) : undefined;
    if (content === undefined) return reply.code(404).send({ error: "not found or not allowed" });
    return { path, content };
  });
  app.put("/api/claude-files/content", async (req, reply) => {
    const { path, content } = (req.body ?? {}) as { path?: string; content?: string };
    if (!path || typeof content !== "string")
      return reply.code(400).send({ error: "path and content required" });
    if (!writeClaudeFile(path, content))
      return reply.code(403).send({ error: "write not allowed" });
    return { ok: true };
  });

  // --- task board ---
  app.get("/api/tasks", async () => {
    pruneArchive();
    autoArchive();
    return { tasks: listTasks(), columns: listColumns(), wip: getWip() };
  });
  // Column config CRUD
  app.get("/api/tasks/columns", async () => ({ columns: listColumns() }));
  app.post("/api/tasks/columns", async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: "name required" });
    return addColumn(name);
  });
  app.put("/api/tasks/columns/:id", async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    const updated = renameColumn((req.params as { id: string }).id, name ?? "");
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.delete("/api/tasks/columns/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // Refuse if any task is in this column.
    const inCol = listTasks().filter((t) => t.column === id);
    if (inCol.length > 0) return reply.code(409).send({ error: `${inCol.length} task(s) still in this column. Move them first.` });
    if (!removeColumn(id)) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.post("/api/tasks/columns/reorder", async (req) => {
    const { ids } = (req.body ?? {}) as { ids?: string[] };
    return { columns: reorderColumns(ids ?? []) };
  });
  app.put("/api/tasks/wip", async (req) => {
    const { column, limit } = (req.body ?? {}) as { column?: string; limit?: number | null };
    return { wip: setWip(column ?? "", limit ?? null) };
  });
  app.post("/api/tasks/:id/delegate", async (req, reply) => {
    const r = taskDelegator.delegate((req.params as { id: string }).id);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { ok: true };
  });
  app.post("/api/tasks/:id/stop", async (req) => ({
    ok: taskDelegator.stop((req.params as { id: string }).id),
  }));
  app.post("/api/tasks", async (req) => createTask(req.body as never));
  app.patch("/api/tasks/:id", async (req, reply) => {
    const updated = updateTask((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.post("/api/tasks/reorder", async (req) => {
    const { moves } = (req.body ?? {}) as { moves?: Array<{ id: string; column: string; order: number }> };
    return { tasks: reorderTasks(moves ?? []) };
  });
  app.delete("/api/tasks/:id", async (req, reply) => {
    if (!deleteTask((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // --- sub-agent workers ---
  app.get("/api/workers", async () => ({
    workers: workers.list().map(workerView),
    skills: listSkills().map((s) => ({ id: s.id, name: s.name })),
    providers: listProviders().map((p) => ({ id: p.id, name: p.name })),
  }));
  app.post("/api/workers", async (req) => workerView(workers.create(req.body as never)));
  app.put("/api/workers/:id", async (req, reply) => {
    const updated = workers.update((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return workerView(updated);
  });
  app.delete("/api/workers/:id", async (req, reply) => {
    if (!workers.remove((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.post("/api/workers/:id/run", async (req, reply) => {
    const run = workers.run((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });
  app.post("/api/workers/:id/stop", async (req) => ({
    ok: workers.stopRun((req.params as { id: string }).id),
  }));
  app.get("/api/workers/:id/runs", async (req) => ({
    runs: workers.history((req.params as { id: string }).id),
  }));
  app.get("/api/runs", async () => ({ runs: workers.history() }));

  // --- worker wizard: generate pre-filled worker config(s) from user intent ---
  app.post("/api/workers/wizard", async (req, reply) => {
    const { goal, context, crew, schedule, cwd } = req.body as {
      goal?: string;
      context?: string;
      crew?: boolean;
      schedule?: string;
      cwd?: string;
    };
    if (!goal?.trim()) return reply.code(400).send({ error: "goal required" });

    const existingLeads = workers.list().filter((w) => w.role === "lead");
    const existingLeadList =
      existingLeads.length > 0
        ? `Existing leads: ${existingLeads.map((w) => `${w.name} (${w.portfolio ?? "general"})`).join(", ")}`
        : "No existing leads.";

    const prompt = `You are a configuration generator for an AI agent orchestration system.

The user wants to set up an autonomous agent (or crew of agents) to handle a recurring task.

User's intent:
- Goal: ${goal.trim()}
${context?.trim() ? `- Context / domain: ${context.trim()}` : ""}
${schedule?.trim() ? `- Desired schedule: ${schedule.trim()}` : "- No schedule (manual run only)"}
${cwd?.trim() ? `- Working directory: ${cwd.trim()}` : "- No specific cwd"}
- Wants full crew setup: ${crew ? "yes" : "no"}
${existingLeadList}

Generate a JSON array of worker configuration objects. Each object must include:
- name: string — short display name
- role: "" | "lead" | "assistant"
- portfolio: string — domain (for lead/assistant roles)
- parentId: string — leave "" (will be resolved by name post-creation)
- cwd: string — working directory path
- prompt: string — the standing task prompt this worker runs each time (detailed, actionable, first-person)
- persona: string — character and tone (e.g. "Concise and direct. Lead with results.")
- systemPrompt: string — domain knowledge or context injected into every run
- autonomy: "supervised" | "standard" | "full"
- when: string — schedule token like "09:00", "1h", "30m", or "" for manual
- model: string — leave "" for default
- enabled: boolean

Rules:
- If crew=false, return exactly one worker object (role: "").
- If crew=true, design a minimal effective crew: one lead and 1-3 assistants that each own a slice of the work.
- The prompt must be a complete, standalone task description — the agent has no other context when it runs.
- Autonomy should be "full" for unattended work, "standard" if the task touches risky resources.
- Be specific and practical. No placeholders.

Respond with ONLY a JSON array, no markdown fences, no explanation. Example format:
[{"name":"Finance Lead","role":"lead","portfolio":"Finance","parentId":"","cwd":"/home/user","prompt":"...","persona":"...","systemPrompt":"...","autonomy":"full","when":"09:00","model":"","enabled":true}]`;

    try {
      let output = "";
      await runTurn({
        prompt,
        cwd: cwd?.trim() || process.cwd(),
        permissionMode: "bypassPermissions",
        abortController: new AbortController(),
        mcpServers: {},
        canUseTool: async (_name, input) => ({ behavior: "allow" as const, updatedInput: input }),
        onText: (delta) => { output += delta; },
        onToolUse: () => {},
        onSessionId: () => {},
      });
      // Extract JSON array from the output (handle any stray text before/after).
      const match = output.match(/\[[\s\S]*\]/);
      if (!match) return reply.code(502).send({ error: "Model returned no JSON", raw: output.slice(0, 500) });
      const configs = JSON.parse(match[0]) as unknown[];
      return { configs };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- in-panel chat (dedicated Claude session) ---
  app.get("/api/chat", async () => chat.view());
  app.post("/api/chat/send", async (req, reply) => {
    const { text } = (req.body ?? {}) as { text?: string };
    const r = chat.send(typeof text === "string" ? text : "");
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return chat.view();
  });
  app.post("/api/chat/stop", async () => {
    chat.stop();
    return { ok: true };
  });
  app.post("/api/chat/clear", async () => {
    chat.clear();
    return chat.view();
  });
  app.put("/api/chat/settings", async (req) => {
    const { cwd, auto } = (req.body ?? {}) as { cwd?: string; auto?: boolean };
    if (typeof cwd === "string") chat.setCwd(cwd);
    if (typeof auto === "boolean") chat.setAuto(auto);
    return chat.view();
  });
  app.post("/api/chat/approve", async (req, reply) => {
    const { approvalId, allow } = (req.body ?? {}) as { approvalId?: string; allow?: boolean };
    if (!approvalId) return reply.code(400).send({ error: "approvalId required" });
    return { ok: chat.resolveApproval(approvalId, Boolean(allow)) };
  });

  // --- claude cli usage (legacy stats-cache.json path) ---
  app.get("/api/claude-usage", async () => getClaudeUsage());

  // --- usage probe (OAuth API: real session/weekly limits + profile) ---
  app.get("/api/usage-probe", async () => loadProbeResult() ?? { source: "none", limits: [] });
  app.post("/api/usage-probe/run", async () => {
    // Explicit user action — force past any rate-limit cooldown. Kick off async
    // so the button feels responsive.
    void runProbe({ force: true });
    return { ok: true, message: "Probe started" };
  });

  // --- plan / budget settings ---
  app.get("/api/plan", async () => {
    const s = getPlanSettings();
    const summary = usageSummary();
    const periodStart = billingPeriodStart(s.billingDay);
    // Sum daily costs from the billing period start through today.
    const periodCost = summary.daily
      .filter((d) => d.day >= periodStart)
      .reduce((acc, d) => acc + d.costUsd, 0);
    const daysSoFar = Math.max(
      1,
      Math.ceil((Date.now() - new Date(periodStart).getTime()) / 86_400_000),
    );
    const dailyAvg = periodCost / daysSoFar;
    return {
      ...s,
      periodStart,
      periodCostUsd: periodCost,
      daysUntilReset: daysUntilReset(s.billingDay),
      dailyAvgUsd: dailyAvg,
      estimatedMonthlyUsd: dailyAvg * 30,
      pctUsed: s.monthlyCap > 0 ? (periodCost / s.monthlyCap) * 100 : 0,
    };
  });
  app.put("/api/plan", async (req) => {
    const patch = (req.body ?? {}) as Parameters<typeof setPlanSettings>[0];
    const s = setPlanSettings(patch);
    // Restart probe scheduler if the interval changed.
    if (patch.probeIntervalMs !== undefined) startProbeScheduler(s.probeIntervalMs);
    return s;
  });

  // --- maintenance scheduler ---
  app.get("/api/maintenance", async () => maintenance.view());
  app.post("/api/maintenance/run", async () => maintenance.runOnce());

  // --- language catalogue ---
  app.get("/api/languages", async () => ({ languages: AGENT_LANGUAGES }));

  // --- council vote log ---
  app.get("/api/council", async (req) => {
    const limitParam = (req.query as { limit?: string }).limit;
    const limit = Math.min(parseInt(limitParam ?? "20", 10), 100);
    const file = join(config.WORKDIR, "..", "council.jsonl");
    if (!existsSync(file)) return { sessions: [] };
    try {
      const sessions = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .reverse()
        .slice(0, limit);
      return { sessions };
    } catch {
      return { sessions: [] };
    }
  });

  // --- delegation log (inter-agent crew communication) ---
  app.get("/api/delegations", async (req) => {
    const limitParam = (req.query as { limit?: string }).limit;
    const limit = Math.min(parseInt(limitParam ?? "50", 10), 200);
    const file = join(config.WORKDIR, "..", "delegations.jsonl");
    if (!existsSync(file)) return { delegations: [] };
    try {
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .reverse()
        .slice(0, limit);
      return { delegations: lines };
    } catch {
      return { delegations: [] };
    }
  });

  // --- model providers (local LM Studio/Ollama, proxies) ---
  app.get("/api/providers", async () => ({ providers: listProviders() }));
  // Fetch the model list for an unsaved endpoint (provider form).
  app.post("/api/providers/models", async (req, reply) => {
    const { baseUrl, authToken } = (req.body ?? {}) as { baseUrl?: string; authToken?: string };
    if (!baseUrl) return reply.code(400).send({ error: "baseUrl required" });
    try {
      return { models: await fetchProviderModels(baseUrl, authToken) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // Fetch the model list for a saved provider (worker form).
  app.get("/api/providers/:id/models", async (req, reply) => {
    const p = getProvider((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "not found" });
    try {
      return { models: await fetchProviderModels(p.baseUrl, resolveSecret(p.authToken)) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/providers", async (req) => createProvider(req.body as never));
  app.put("/api/providers/:id", async (req, reply) => {
    const updated = updateProvider((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.delete("/api/providers/:id", async (req, reply) => {
    if (!deleteProvider((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // --- Integrations (local Ollama / LM Studio) ---
  app.get("/api/integrations/ollama", async () => ollamaStatus());
  app.post("/api/integrations/ollama/connect", async (_req, reply) => {
    try {
      return await connectOllama();
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get("/api/integrations/lmstudio", async () => lmStudioStatus());
  app.post("/api/integrations/lmstudio/connect", async (_req, reply) => {
    try {
      return await connectLmStudio();
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Terminal ---
  app.get("/api/terminal", async () => ({
    available: ptyManager.available,
    shell: ptyManager.currentShell,
  }));
  app.post("/api/terminal/spawn", async (req) => {
    const { cols, rows } = (req.body ?? {}) as { cols?: number; rows?: number };
    ptyManager.spawn(cols ?? 120, rows ?? 30);
    return { ok: true };
  });
  app.post("/api/terminal/resize", async (req) => {
    const { cols, rows } = (req.body ?? {}) as { cols?: number; rows?: number };
    if (typeof cols === "number" && typeof rows === "number") ptyManager.resize(cols, rows);
    return { ok: true };
  });
}

function registerWs(app: FastifyInstance, hub: PanelHub): void {
  app.get("/ws", { websocket: true }, (socket) => {
    hub.add(socket);

    // Send terminal scrollback history to this client immediately.
    const history = ptyManager.getHistory();
    if (history) {
      try {
        socket.send(JSON.stringify({ type: "terminal", event: "history", data: history }));
      } catch { /* client gone */ }
    }

    // Relay terminal input from this client to the PTY.
    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "terminal" && msg.event === "input" && typeof msg.data === "string") {
          ptyManager.write(msg.data);
        }
      } catch { /* ignore malformed frames */ }
    });
  });
}

async function registerStatic(app: FastifyInstance): Promise<void> {
  if (!existsSync(STATIC_DIR)) {
    app.get("/", async (_req, reply) => {
      await reply
        .type("text/html")
        .send(
          "<h1>Panel not built</h1><p>Run <code>npm run build:panel</code> (or <code>npm run build</code>) and restart.</p>",
        );
    });
    return;
  }
  await app.register(fastifyStatic, { root: STATIC_DIR });
  // SPA fallback so client-side routing survives a refresh.
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      await reply.code(404).send({ error: "not found" });
      return;
    }
    await reply.sendFile("index.html");
  });
}
