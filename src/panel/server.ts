import { join } from "node:path";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { config, repoRoot } from "../config.js";
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
  COLUMNS,
} from "../core/tasks.js";
import { workers, describeWorkerSchedule, type Worker } from "../core/workers.js";
import { recentAudit } from "../core/audit.js";
import { PanelHub } from "./hub.js";

const STATIC_DIR = join(repoRoot, "panel", "dist");

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
  // Stream live log lines to every panel client.
  const unsubLog = onLog((entry) => hub.broadcast({ type: "log", entry }));

  // Auth: every /api and /ws request needs the shared token. Static SPA assets
  // are served freely (they hold no secrets; the token gates the data + actions).
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") && !req.url.startsWith("/ws")) return;
    if (!tokenOk(req)) await reply.code(401).send({ error: "unauthorized" });
  });

  registerApi(app);
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
    workers.stop();
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
  };
}

function registerApi(app: FastifyInstance): void {
  app.get("/api/me", async () => ({ ok: true }));

  // --- read-only dashboards ---
  app.get("/api/health", async () => getHealth());
  app.get("/api/sessions", async () => ({ sessions: listSessions() }));
  app.get("/api/schedules", async () => ({ schedules: listSchedules() }));
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
  app.get("/api/skills", async () => ({ skills: listSkills() }));
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
  app.get("/api/tasks", async () => ({ tasks: listTasks(), columns: COLUMNS }));
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
