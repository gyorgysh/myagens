import { join } from "node:path";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { config, repoRoot } from "../config.js";
import { log } from "../logger.js";
import { getHealth } from "../core/health.js";
import { listSessions, listSchedules, usageSummary } from "../core/snapshot.js";

const HEALTH_PUSH_MS = 2000;
const STATIC_DIR = join(repoRoot, "panel", "dist");

/**
 * Start the embedded management panel. In-process so its handlers read the live
 * SessionManager / ScheduleManager singletons directly — no IPC. Returns a stop
 * function for graceful shutdown. No-op (returns undefined) when disabled.
 */
export async function startPanel(): Promise<(() => Promise<void>) | undefined> {
  if (!config.PANEL_ENABLED) return undefined;
  // parseConfig already refuses PANEL_ENABLED without a token, but guard anyway.
  if (!config.PANEL_TOKEN) {
    log.error("Panel enabled but PANEL_TOKEN missing — not starting panel");
    return undefined;
  }

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  // --- Auth: every /api and /ws request needs the shared token. Static SPA
  //     assets are served freely (they hold no secrets; the token gates data). ---
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") && !req.url.startsWith("/ws")) return;
    if (!tokenOk(req)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  registerApi(app);
  registerWs(app);
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
    await app.close();
  };
}

function tokenOk(req: FastifyRequest): boolean {
  const expected = config.PANEL_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization;
  const fromHeader = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const fromQuery =
    typeof (req.query as Record<string, unknown>)?.token === "string"
      ? ((req.query as Record<string, string>).token)
      : undefined;
  const provided = fromHeader ?? fromQuery;
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function registerApi(app: FastifyInstance): void {
  app.get("/api/health", async () => getHealth());
  app.get("/api/sessions", async () => ({ sessions: listSessions() }));
  app.get("/api/schedules", async () => ({ schedules: listSchedules() }));
  app.get("/api/usage", async () => usageSummary());
  // Cheap endpoint the frontend hits to validate a token on login.
  app.get("/api/me", async () => ({ ok: true }));
}

function registerWs(app: FastifyInstance): void {
  app.get("/ws", { websocket: true }, (socket) => {
    let alive = true;
    const send = async () => {
      if (!alive) return;
      try {
        socket.send(JSON.stringify({ type: "health", data: await getHealth() }));
      } catch {
        /* socket closed mid-flight */
      }
    };
    void send();
    const timer = setInterval(() => void send(), HEALTH_PUSH_MS);
    timer.unref?.();
    socket.on("close", () => {
      alive = false;
      clearInterval(timer);
    });
    socket.on("error", () => {
      alive = false;
      clearInterval(timer);
    });
  });
}

async function registerStatic(app: FastifyInstance): Promise<void> {
  if (!existsSync(STATIC_DIR)) {
    // No build yet: still serve a helpful message at the root.
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
  // SPA fallback: any non-API route that isn't a real file serves index.html
  // so client-side routing works on refresh.
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      await reply.code(404).send({ error: "not found" });
      return;
    }
    await reply.sendFile("index.html");
  });
}
