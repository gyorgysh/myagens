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
import { log, onLog, recentLogs } from "../logger.js";
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
import { memory } from "../core/memory.js";
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
import { serviceInstalled, restartService } from "../core/agentControl.js";
import { getUpdateStatus, checkForUpdate, runUpdate } from "../core/updateControl.js";
import { recentAudit } from "../core/audit.js";
import { sessions } from "../session/manager.js";
import { PanelHub } from "./hub.js";

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
  }));
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
      autonomy: autonomy as "supervised" | "standard" | "full" | undefined,
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
  app.delete("/api/schedules/:id", async (req, reply) => {
    if (!schedules.removeById((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.get("/api/usage", async () => usageSummary());
  app.get("/api/audit", async () => ({ events: recentAudit() }));
  app.get("/api/logs", async () => ({ logs: recentLogs() }));

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
  app.get("/api/update", async () => ({ ...getUpdateStatus(), serviceInstalled: serviceInstalled() }));
  app.post("/api/update/check", async () => ({ ...(await checkForUpdate()), serviceInstalled: serviceInstalled() }));
  app.post("/api/update/run", async () => {
    if (getUpdateStatus().updating) return { started: false };
    // Stream output to panel clients; don't await (the run may restart us).
    void runUpdate((line) => hub.broadcast({ type: "update", line })).catch(() => {});
    return { started: true };
  });

  // --- durable memory ---
  app.get("/api/memories", async (req) => {
    const { q, all } = req.query as { q?: string; all?: string };
    if (q) return { memories: all === "true" ? memory.searchAll(q, 50) : memory.search(q, 50) };
    return { memories: memory.list() };
  });
  app.post("/api/memories", async (req) => memory.create(req.body as never));
  app.put("/api/memories/:id", async (req, reply) => {
    const updated = memory.update((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.patch("/api/memories/:id/tier", async (req, reply) => {
    const { tier } = (req.body ?? {}) as { tier?: string };
    if (tier !== "hot" && tier !== "warm" && tier !== "cold")
      return reply.code(400).send({ error: "tier must be hot, warm, or cold" });
    const updated = memory.setTier((req.params as { id: string }).id, tier);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
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
  app.get("/api/tasks", async () => ({ tasks: listTasks(), columns: listColumns(), wip: getWip() }));
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
    // Kick off async; return immediately so the button feels responsive.
    void runProbe();
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
}

function registerWs(app: FastifyInstance, hub: PanelHub): void {
  app.get("/ws", { websocket: true }, (socket) => {
    hub.add(socket);
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
