import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
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
import { AGENT_LANGUAGES, languageName } from "../core/languages.js";
import {
  log,
  onLog,
  recentLogs,
  availableLogDates,
  readLogFile,
  searchAllLogs,
  summarizeUsage,
  type LogEntry,
} from "../logger.js";
import { getHealth } from "../core/health.js";
import { listSessions, listSchedules, usageSummary } from "../core/snapshot.js";
import { agentUsage } from "../core/agentUsage.js";
import { isValidWebhookUrl } from "../core/webhook.js";
import { getPrompt, restorePlaybook, savePlaybook } from "../core/playbook.js";
import { listSkills, createSkill, updateSkill, deleteSkill, exportSkill, importSkill } from "../core/skills.js";
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  templateVariables,
} from "../core/templates.js";
import { listClaudeFiles, readClaudeFile, writeClaudeFile } from "../core/claudeFiles.js";
import {
  listTasks,
  createTask,
  updateTask,
  reorderTasks,
  deleteTask,
  getWip,
  setWip,
  getTaskRunConfig,
  setTaskRunConfig,
  pruneArchive,
  autoArchive,
  blockingPrereqs,
  onRecurrenceFire,
} from "../core/tasks.js";
import {
  listColumns,
  addColumn,
  renameColumn,
  removeColumn,
  reorderColumns,
} from "../core/columnConfig.js";
import { taskDelegator, sanitizeCardField } from "../core/taskRunner.js";
import { TokenBucketLimiter } from "../core/rateLimiter.js";
import { workers, describeWorkerSchedule, type Worker } from "../core/workers.js";
import { leadBots } from "../telegram/leadBotManager.js";
import { readRunLog } from "../core/runLog.js";
import { chat } from "../core/chat.js";
import { agentChat } from "../core/agentChat.js";
import { sanitizeChatImages } from "../core/chatImages.js";
import { memory, type MemoryEntry } from "../core/memory.js";
import { suggestions } from "../core/suggestions.js";
import { getStatus } from "../core/status.js";
import { heartbeat } from "../core/heartbeat.js";
import {
  listConnectors,
  setConnector,
  addConnectorAccount,
  updateConnectorAccount,
  removeConnectorAccount,
} from "../core/connectors.js";
import { listImages, getImage, updateImage, deleteImage, listTags, type GalleryImage } from "../core/gallery.js";
import { generateImage, ImageGenError, type ImageProviderId } from "../core/imageGen.js";
import { listWebhookTools, createWebhookTool, updateWebhookTool, deleteWebhookTool } from "../core/webhookTools.js";
import { getBranding, setBranding, effectiveBranding } from "../core/branding.js";
import { searchConversations } from "../core/conversationSearch.js";
import { webhookTriggers, signWebhookBody, panelBaseHint } from "../core/webhookTriggers.js";
import { vault, importProviderSecrets, resolveSecret, vaultUsages } from "../core/vault.js";
import { backupManifest, exportBackup, importBackup } from "../core/backup.js";
import { dataPath } from "../core/jsonStore.js";
import {
  listProviders,
  listProviderViews,
  toProviderView,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  providerKind,
} from "../core/providers.js";
import { fetchProviderModels } from "../core/providerModels.js";
import { BlockedUrlError } from "../core/safeUrl.js";
import { voiceSettingsView, setVoiceSettings } from "../core/voiceSettings.js";
import { mainSettingsView, setMainSettings, resolveMainRun } from "../core/mainSettings.js";
import { embeddingConfig, setEmbeddingsEnabled, preferredBackend, setPreferredBackend, activeBackend, envEmbeddingMode, embeddingsAuto, enterAutoMode, type PreferredBackend } from "../core/embeddings.js";
import { ollamaStatus, connectOllama } from "../core/ollama.js";
import { lmStudioStatus, connectLmStudio } from "../core/lmstudio.js";
import { serviceInstalled, restartService } from "../core/agentControl.js";
import { isActive } from "../core/activity.js";
import { getUpdateStatus, checkForUpdate, runUpdate, runRestore } from "../core/updateControl.js";
import { recentAudit, searchAudit, auditFacets } from "../core/audit.js";
import { detectAnomalies, ANOMALY_DEFAULTS } from "../core/anomaly.js";
import { approvalQueue, APPROVAL_ACTIONS } from "../core/approvals.js";
import { askQueue } from "../core/askQueue.js";
import { push } from "../core/push.js";
import { sessions } from "../session/manager.js";
import { ptyManager } from "../core/ptyManager.js";
import { tunnelManager, BASIC_AUTH_USER } from "../core/tunnelManager.js";
import { PanelHub } from "./hub.js";
import { getBackend, listBackends } from "../core/backends.js";
import { runCouncil, deleteCouncilSession, getCouncilRule, setCouncilRule, type CouncilRule } from "../core/council.js";

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

  // 64MB body limit so a full-state backup import (base64 archive) fits; the
  // default 1MB is far too small once memory.json is in the payload.
  //
  // SEC: trust X-Forwarded-For only when the direct TCP peer is loopback — the
  // only address a legitimate proxy (tunnelManager's ngrok/cloudflared, or a
  // user's own reverse proxy per the README) can connect from, since the panel
  // always binds loopback by default (PANEL_HOST). Without this, req.ip is the
  // raw socket peer, which for ALL tunneled/proxied traffic is 127.0.0.1 (the
  // local relay process) regardless of the real internet-facing client — which
  // silently exempts every such request from the brute-force lockout below,
  // since isLoopback(clientIp(req)) then always sees 127.0.0.1 instead of the
  // real attacker IP. A client connecting directly (non-loopback socket peer)
  // gets no benefit from forging the header: that hop is never trusted.
  const app = Fastify({
    logger: false,
    // Modest global cap. The public, unauthenticated POST /hook/:id and any
    // non-/api path (served the SPA shell) reach the body reader before the auth
    // hook, so a large global limit let an unauthenticated caller force the server
    // to buffer huge bodies (and HMAC over them) with no token or rate limit. The
    // few routes that legitimately accept large payloads (store imports) raise
    // their own bodyLimit per-route below.
    bodyLimit: 1024 * 1024,
    trustProxy: (address) => isLoopback(address),
  });

  // Inbound webhook triggers (`POST /hook/:id`) authenticate by HMAC over the
  // EXACT request bytes, so we must keep the raw body before any JSON parsing.
  // This content-type parser captures the raw string on `req.rawBody` and still
  // hands JSON routes a parsed object (everything else gets the raw string). It
  // runs for all routes, which is harmless: the panel's own routes read the
  // parsed body as before.
  app.addContentTypeParser(
    ["application/json", "text/plain", "application/x-www-form-urlencoded"],
    { parseAs: "string" },
    (req, bodyStr, done) => {
      (req as { rawBody?: string }).rawBody = bodyStr as string;
      const s = (bodyStr as string).trim();
      if (!s) return done(null, undefined);
      if (req.headers["content-type"]?.includes("application/json")) {
        try {
          done(null, JSON.parse(s));
        } catch (err) {
          (err as { statusCode?: number }).statusCode = 400;
          done(err as Error, undefined);
        }
        return;
      }
      done(null, bodyStr);
    },
  );

  await app.register(fastifyWebsocket);
  const hub = new PanelHub();
  // Wire worker run events to all panel clients (worker tick already running).
  workers.start((m) => hub.broadcast(m));
  // Wire the in-panel chat session's stream to all clients.
  chat.start((m) => hub.broadcast(m));
  // Wire per-agent (worker/Lead) interactive chat streams to all clients.
  agentChat.start((m) => hub.broadcast(m));
  // Wire delegated-task run streams to all clients.
  taskDelegator.start((m) => hub.broadcast(m));
  // Wire approval queue updates to all panel clients.
  approvalQueue.start((m) => hub.broadcast(m));
  // Wire pending AskUserQuestion prompts to all panel clients.
  askQueue.start((m) => hub.broadcast(m));
  // Wire the PTY terminal session to all clients.
  ptyManager.start((m) => hub.broadcast(m));
  // Wire remote-access tunnel state changes to all clients.
  tunnelManager.start((m) => hub.broadcast(m));
  // Push suggestion-inbox changes to every panel client.
  suggestions.onChange(() => hub.broadcast({ type: "suggestion", suggestions: suggestions.list() }));
  // Push webhook-trigger changes (incl. fire counts) to every panel client.
  webhookTriggers.onChange(() =>
    hub.broadcast({ type: "webhook-trigger", triggers: webhookTriggers.list() }),
  );
  // Tell clients to reload the board when recurring templates spawn fresh cards.
  onRecurrenceFire(() => hub.broadcast({ type: "task", event: "refresh" }));
  // Stream live log lines to every panel client.
  const unsubLog = onLog((entry) => hub.broadcast({ type: "log", entry }));

  // Refresh the "update available" status in the background so the nav badge is
  // reasonably fresh: once shortly after boot, then every 6 hours.
  setTimeout(() => void checkForUpdate(), 10_000).unref();
  const updateTimer = setInterval(() => void checkForUpdate(), 6 * 3_600_000);
  updateTimer.unref();

  // SEC: security headers on every response. The panel SPA keeps the PANEL_TOKEN
  // in localStorage and sends it as the Bearer header, so a single XSS would let an
  // injected script read and exfiltrate it. A strict Content-Security-Policy is the
  // main mitigation: scripts/styles/connections are limited to same-origin (no
  // inline scripts, no eval), so injected <script> or `javascript:` payloads won't
  // run and data can't be POSTed to an attacker host. The theme bootstrap was moved
  // to an external file (/theme-init.js) so no inline script is needed. style-src
  // allows 'unsafe-inline' because React sets element style attributes at runtime
  // (inline styles can't exfiltrate data). connect-src is 'self' only: same-origin
  // covers the panel's own ws(s):// WebSocket, while the bare `ws: wss:` schemes it
  // used to carry matched ANY host — letting injected script exfiltrate the token
  // over a WebSocket despite this policy. The other headers are standard hardening.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
  });

  // Remote-access gate: when a request arrives through the public tunnel (ngrok /
  // cloudflared proxy to loopback and set x-forwarded-* headers), it must clear an
  // HTTP Basic Auth challenge (user `myagens` + the generated password) BEFORE anything
  // — including the SPA shell and the login page — is served. Local/LAN access to
  // the panel is unaffected (no forwarding header → gate skipped). This is a second
  // factor in front of the existing panel token, not a replacement.
  app.addHook("onRequest", async (req, reply) => {
    if (!tunnelManager.basicAuthActive) return;
    const forwarded = req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"];
    if (!forwarded) return; // direct loopback/LAN request, gate doesn't apply

    // IMPORTANT: HTTP Basic Auth and the panel's Bearer token both live in the
    // `Authorization` header, so they can't coexist on one request. The SPA sets
    // `Authorization: Bearer <panel-token>` on every /api + /ws call, which means
    // the browser can't also attach the cached Basic Auth creds there — the Basic
    // gate would always fail on those paths and pop a looping native dialog while
    // the cached shell renders behind it. So the Basic gate guards ONLY the document
    // + static assets (the entry point a phone hits): the browser does the native
    // login once for the navigation, then the loaded SPA authenticates /api + /ws
    // with the Bearer token as usual. The token is the access control for the data
    // and actions; Basic Auth is just a second factor in front of the entry page.
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return;

    if (tunnelManager.verifyBasic(req.headers.authorization)) return;
    await reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="MyAgens Remote Access", charset="UTF-8"')
      .header("cache-control", "no-store")
      .send("Authentication required");
  });

  // Auth: every /api and /ws request needs the shared token. Static SPA assets
  // are served freely (they hold no secrets; the token gates the data + actions).
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api") && !req.url.startsWith("/ws")) return;
    const ip = clientIp(req);
    // Lock out a client that has failed repeatedly, so the long random token
    // can't be brute-forced over the network. Loopback is exempt (handled inside
    // lockoutRemainingMs) so a local operator can't lock themselves out. Surface
    // the remaining time so the SPA can show "try again in N minutes".
    const lockedMs = lockoutRemainingMs(ip);
    if (lockedMs > 0) {
      const retryAfter = Math.ceil(lockedMs / 1000);
      await reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: "too many attempts, try again later", lockout: true, retryAfterMs: lockedMs });
      return;
    }
    // SEC-9 (CSRF): mutating requests must prove they are not a forged
    // cross-site request. The panel token is a Bearer header (which a browser
    // cannot attach to a cross-origin request without a CORS preflight the
    // server never grants), so the header itself is the primary defence. As an
    // explicit, defence-in-depth check we reject any non-GET/HEAD request that
    // both (a) carries no Authorization header and (b) declares a cross-origin
    // Origin/Referer. A same-origin SPA fetch always sends the Bearer header, so
    // this never affects legitimate use. The WS handshake (GET) is exempt by
    // method; its read-only ?token= query is handled in tokenOk.
    if (isCsrfRisk(req)) {
      await reply.code(403).send({ error: "cross-site request blocked" });
      return;
    }
    if (!tokenOk(req)) {
      noteAuthFailure(ip);
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    noteAuthSuccess(ip);
    // Throttle authenticated mutating requests so a token holder can't spam
    // costly endpoints. Reads (GET/HEAD) and the WS handshake are exempt; the
    // check runs only after auth so unauthenticated probes can't exhaust buckets.
    if (panelRateLimiter && isMutatingMethod(req.method) && !req.url.startsWith("/ws")) {
      if (!panelRateLimiter.tryConsume(ip)) {
        const retryMs = panelRateLimiter.retryAfterMs(ip);
        await reply
          .code(429)
          .header("Retry-After", String(Math.ceil(retryMs / 1000)))
          .send({ error: "rate limit exceeded, slow down" });
        return;
      }
    }
    // Separate high ceiling on expensive GET reads (memory search, logs, run
    // transcripts) so a runaway client can't pin CPU; normal fleet reads stay
    // well under it. The WS handshake is exempt by prefix.
    if (panelReadRateLimiter && isExpensiveRead(req.method, req.url) && !req.url.startsWith("/ws")) {
      if (!panelReadRateLimiter.tryConsume(ip)) {
        const retryMs = panelReadRateLimiter.retryAfterMs(ip);
        await reply
          .code(429)
          .header("Retry-After", String(Math.ceil(retryMs / 1000)))
          .send({ error: "read rate limit exceeded, slow down" });
        return;
      }
    }
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
    tunnelManager.kill();
    hub.stop();
    await app.close();
  };
}

function tokenOk(req: FastifyRequest): boolean {
  const expected = config.PANEL_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization;
  const fromHeader = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  // The browser WebSocket API can't set an Authorization header, so the WS
  // handshake (and only it) may carry the token in the query string. REST must
  // use the header, so the token never lands in proxy/access logs or history.
  const isWs = req.url.startsWith("/ws");
  const q = req.query as Record<string, unknown>;
  const fromQuery = isWs && typeof q?.token === "string" ? q.token : undefined;
  const provided = fromHeader ?? fromQuery;
  return provided !== undefined && safeEqual(provided, expected);
}

/**
 * SEC-9 CSRF guard. Returns true when a request looks like a forged cross-site
 * write and must be rejected before token validation. A request is a risk when
 * its method is state-changing (anything but GET/HEAD/OPTIONS) AND it carries no
 * Authorization header AND it declares an Origin/Referer whose host differs from
 * the panel's own host. Legitimate SPA calls always carry the Bearer header, so
 * they short-circuit here; a classic CSRF (auto-submitted form / img / fetch
 * without credentials) carries no Authorization header and trips the check.
 */
function isCsrfRisk(req: FastifyRequest): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const hasAuth = typeof req.headers.authorization === "string" && req.headers.authorization.length > 0;
  if (hasAuth) return false; // header-authenticated calls are CSRF-safe by spec
  const origin = (req.headers.origin as string | undefined) ?? referrerOrigin(req);
  if (!origin) return false; // no Origin/Referer (e.g. server-to-server) → not a browser CSRF
  const host = (req.headers.host as string | undefined) ?? "";
  return !originMatchesHost(origin, host);
}

function referrerOrigin(req: FastifyRequest): string | undefined {
  const ref = req.headers.referer as string | undefined;
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}

function originMatchesHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Hard cap on a schedule prompt folded into the autonomous run prompt. A
 * schedule executes with `bypassPermissions`, so an unbounded prompt is both a
 * latent DoS and a prompt-injection vector — same threat model as a delegated
 * card, so it reuses `sanitizeCardField` with a comparable cap.
 */
const SCHEDULE_PROMPT_MAX = 20_000;

// --- Brute-force lockout -----------------------------------------------------
// A panel token grants host access, so throttle repeated auth failures per
// client IP. In-memory only (no dep): after MAX_FAILS failures the IP is locked
// for LOCKOUT_MS; a success clears the counter. Cleared on restart.
//
// Loopback (localhost / 127.0.0.1 / ::1) is exempt: a local operator with a few
// browser tabs or a stale token can otherwise lock themselves out of their own
// machine, which is pointless — there is no over-the-network brute-force threat
// from the host itself. The lockout only defends against remote attackers, so it
// only applies to non-loopback clients (the realistic attack surface, e.g. via a
// tunnel/reverse proxy).
const MAX_FAILS = 10;
const LOCKOUT_MS = 15 * 60_000;
const authFailures = new Map<string, { count: number; lockedUntil: number }>();

/** True for loopback addresses, which are exempt from the brute-force lockout. */
function isLoopback(ip: string): boolean {
  // Strip an IPv4-mapped-IPv6 prefix (::ffff:127.0.0.1) and any zone id.
  const a = ip.replace(/^::ffff:/i, "").replace(/%.*$/, "");
  return a === "127.0.0.1" || a.startsWith("127.") || a === "::1" || a === "localhost";
}

// --- Per-client rate limit on mutating API routes ----------------------------
// A valid PANEL_TOKEN grants full host access; even a legitimate holder must not
// be able to spam costly mutating endpoints (delegate runs, chat sends, schedule
// runs) unthrottled. A token bucket keyed by client IP throttles write requests
// (POST/PUT/PATCH/DELETE). Most GET/HEAD reads are exempt; a few expensive ones
// get a separate, much higher limit (see panelReadRateLimiter below). Disabled
// when PANEL_RATE_LIMIT is 0. In-memory only, cleared on restart.
const panelRateLimiter =
  config.PANEL_RATE_LIMIT > 0
    ? new TokenBucketLimiter<string>(config.PANEL_RATE_LIMIT, config.PANEL_RATE_WINDOW_MS)
    : undefined;

/** Per-route body cap for store-import endpoints, which legitimately accept large
 *  JSON bundles (whole memory/skill/vault/backup stores). Kept off the global
 *  limit so it doesn't widen the unauthenticated public-route attack surface. */
const IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

/** Per-IP rate limit for the PUBLIC, unauthenticated POST /hook/:id endpoint, so
 *  an attacker who can reach the panel can't flood it with signed-or-unsigned
 *  requests (each files/HMACs a payload). Generous enough for real webhooks. */
const hookRateLimiter = new TokenBucketLimiter<string>(30, 60_000);

/** True for state-changing HTTP methods that should be rate limited. */
function isMutatingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

// --- Per-client rate limit on *expensive* GET reads --------------------------
// GETs are exempt from the mutating limiter above, but a few read endpoints are
// genuinely costly: memory semantic search embeds up to 50 entries, log reads
// scan/parse retained NDJSON files, and per-run transcripts can be large. An
// authenticated client hammering these could still pin CPU. This is a SEPARATE,
// deliberately HIGH bucket: on localhost dozens of agents read memory/logs all
// the time, so it must never throttle normal fleet traffic — it only trips on a
// runaway flood (hundreds of heavy reads/min). Disabled when the limit is 0.
const panelReadRateLimiter =
  config.PANEL_READ_RATE_LIMIT > 0
    ? new TokenBucketLimiter<string>(config.PANEL_READ_RATE_LIMIT, config.PANEL_RATE_WINDOW_MS)
    : undefined;

/** URL path prefixes whose GET handlers are expensive enough to rate limit. */
const EXPENSIVE_GET_PREFIXES = ["/api/memories", "/api/logs", "/api/runs", "/api/conversations"];

/** True when a GET request targets one of the expensive read endpoints. */
function isExpensiveRead(method: string, url: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const path = url.split("?")[0];
  return EXPENSIVE_GET_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

let warnedUnknownIp = false;

function clientIp(req: FastifyRequest): string {
  const ip = req.ip || req.socket.remoteAddress;
  if (ip) return ip;
  if (!warnedUnknownIp) {
    warnedUnknownIp = true;
    log.warn(
      "panel: request has no resolvable client IP (req.ip and socket.remoteAddress both empty); " +
        "brute-force lockout will bucket all such clients together — check your reverse-proxy / network setup",
    );
  }
  return "unknown";
}

/** Milliseconds remaining on an active lockout for this IP, else 0. */
function lockoutRemainingMs(ip: string): number {
  if (isLoopback(ip)) return 0; // loopback is never locked out
  const e = authFailures.get(ip);
  if (!e || !e.lockedUntil) return 0;
  const remaining = e.lockedUntil - Date.now();
  if (remaining > 0) return remaining;
  // Lockout window elapsed: reset so the client gets a fresh allowance.
  authFailures.delete(ip);
  return 0;
}

function noteAuthFailure(ip: string): void {
  if (isLoopback(ip)) return; // never lock a local operator out of their own host
  const e = authFailures.get(ip) ?? { count: 0, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_FAILS) {
    e.lockedUntil = Date.now() + LOCKOUT_MS;
    log.warn("Panel auth lockout", { ip, count: e.count });
  }
  authFailures.set(ip, e);
}

function noteAuthSuccess(ip: string): void {
  authFailures.delete(ip);
}

/**
 * Map a task's stored creator id to a friendly display name: the main agent's
 * configured name for "atlas", a worker/lead's name when the id matches one,
 * "Panel" for panel/REST-created cards, else the raw id.
 */
function creatorName(id: string): string {
  if (id === "atlas") return config.ATLAS_NAME;
  if (id === "panel") return "Panel";
  return workers.get(id)?.name ?? id;
}

/** Panel view of a worker: registry fields + derived run state. */
function workerView(w: Worker) {
  // CLAUDE.md in the worker's own cwd is auto-loaded by the SDK on every turn
  // via settingSources "project". Flag it when it's large so the panel can
  // nudge the user to trim it or point the worker at a different directory.
  let claudeMdBytes = 0;
  try {
    const p = join(w.cwd, "CLAUDE.md");
    if (existsSync(p)) claudeMdBytes = statSync(p).size;
  } catch { /* non-fatal */ }

  return {
    id: w.id,
    name: w.name,
    cwd: w.cwd,
    prompt: w.prompt,
    model: w.model ?? "",
    providerId: w.providerId ?? "",
    backendId: w.backendId ?? "",
    fallbackBackendId: w.fallbackBackendId ?? "",
    fallbackProviderId: w.fallbackProviderId ?? "",
    fallbackModel: w.fallbackModel ?? "",
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
    botUsername: w.botUsername ?? "",
    persona: w.persona ?? "",
    autonomy: w.autonomy ?? "standard",
    language: w.language ?? "",
    promptExclude: w.promptExclude ?? [],
    webhookUrl: w.webhookUrl ?? "",
    avatar: w.avatar ?? "",
    streamMode: w.streamMode ?? "",
    /** True when the worker is in auto_until_error and hit a tool error. */
    escalated: w.escalated === true,
    // True when this Lead has a live Telegram bot listening (role lead + token
    // + enabled). The panel warns when a Lead is enabled but has no token.
    listening: w.role === "lead" && !!w.telegramToken && w.enabled,
    // Byte size of CLAUDE.md in the worker's cwd (0 if absent). The SDK
    // auto-loads it as project context on every turn; large files cost tokens.
    claudeMdBytes,
  };
}

function registerApi(app: FastifyInstance, hub: PanelHub): void {
  app.get("/api/me", async () => ({
    ok: true,
    chatEnabled: chat.isEnabled(),
    version: VERSION,
    updateAvailable: getUpdateStatus().available,
    updateCount: getUpdateStatus().behindBy,
    // Effective branding: the saved white-label overrides, env-default names as
    // fallback. The panel chrome renders from these.
    atlasName: effectiveBranding().agentName,
    brandName: effectiveBranding().brandName,
    branding: effectiveBranding(),
    // Claude Pro/Max are flat-rate subscriptions where Claude Code usage costs
    // nothing extra, so the SDK's per-token cost estimate is misleading. The
    // panel hides every USD figure when this is true (the OAuth probe can also
    // detect it, but this config-set value works even when the probe is stale).
    subscriptionPlan: getPlanSettings().plan !== "api",
    defaultLanguage: config.DEFAULT_LANGUAGE,
    defaultWorkdir: config.WORKDIR,
    homeDir: homedir(),
    // Host platform, so the panel can pick a Windows vs Unix path example for
    // the worker cwd placeholder hint.
    platform: process.platform,
    languages: AGENT_LANGUAGES,
    // Read-only deployment facts for the Setup view (all .env-sourced; not
    // editable from the panel by design — see SEC notes in CLAUDE.md).
    allowedUserCount: allowedUserIds.size,
    panelHost: config.PANEL_HOST,
    panelPort: config.PANEL_PORT,
    tunnelEnabled: config.PANEL_TUNNEL_ENABLED,
    terminalEnabled: config.PANEL_TERMINAL_ENABLED,
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
    const {
      model,
      providerId,
      backendId,
      persona,
      autonomy,
      defaultLanguage,
      dryRun,
      fallbackProviderId,
      fallbackBackendId,
      fallbackModel,
      fallbackThreshold,
      knownPaths,
      updateNotifyOptOut,
      promptExclude,
    } = (req.body ?? {}) as {
      model?: string;
      providerId?: string;
      backendId?: string;
      persona?: string;
      autonomy?: string;
      defaultLanguage?: string;
      dryRun?: boolean;
      fallbackProviderId?: string;
      fallbackBackendId?: string;
      fallbackModel?: string;
      fallbackThreshold?: number;
      knownPaths?: Array<{ label: string; path: string }>;
      updateNotifyOptOut?: boolean;
      promptExclude?: string[];
    };
    setMainSettings({
      model,
      providerId,
      backendId,
      persona,
      autonomy: autonomy as "supervised" | "standard" | "full" | "auto_until_error" | undefined,
      defaultLanguage,
      dryRun,
      fallbackProviderId,
      fallbackBackendId,
      fallbackModel,
      fallbackThreshold,
      knownPaths,
      updateNotifyOptOut,
      promptExclude,
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
    const { prompt, when, cwd, chatId, webhookUrl } = (req.body ?? {}) as {
      prompt?: string;
      when?: string;
      cwd?: string;
      chatId?: number;
      webhookUrl?: string;
    };
    if (!prompt?.trim()) return reply.code(400).send({ error: "prompt required" });
    // A schedule prompt runs as an autonomous `bypassPermissions` turn, so the
    // same cap + injection sanitisation applied to delegated card content guards
    // it against an unbounded / adversarial prompt (latent DoS + prompt-injection).
    const cleanPrompt = sanitizeCardField(prompt, SCHEDULE_PROMPT_MAX);
    if (!cleanPrompt) return reply.code(400).send({ error: "prompt required" });
    const spec = parseWhen(when ?? "");
    if (!spec) return reply.code(400).send({ error: "invalid schedule (use 30m, 2h, 1d, or HH:MM)" });
    if (webhookUrl?.trim() && !(await isValidWebhookUrl(webhookUrl)))
      return reply.code(400).send({ error: "invalid or blocked webhook URL" });
    const target = chatId ?? [...allowedUserIds][0];
    if (target === undefined) return reply.code(400).send({ error: "no allowed user to own the schedule" });
    schedules.add(target, cwd?.trim() || config.WORKDIR, cleanPrompt, spec, webhookUrl);
    return { schedules: listSchedules() };
  });
  app.put("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as {
      prompt?: string;
      when?: string;
      cwd?: string;
      chatId?: number;
      webhookUrl?: string;
    };
    if (patch.webhookUrl?.trim() && !(await isValidWebhookUrl(patch.webhookUrl)))
      return reply.code(400).send({ error: "invalid or blocked webhook URL" });
    // Sanitise + cap an updated prompt the same way as on create (autonomous run).
    if (typeof patch.prompt === "string") {
      const cleanPrompt = sanitizeCardField(patch.prompt, SCHEDULE_PROMPT_MAX);
      if (!cleanPrompt) return reply.code(400).send({ error: "prompt required" });
      patch.prompt = cleanPrompt;
    }
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

  // --- Inbound webhook triggers ---
  // Management routes are token-gated like the rest of /api. The actual firing
  // endpoint is PUBLIC (`POST /hook/:id`, registered below outside the /api
  // prefix) and authenticates by HMAC-SHA256 over the raw body instead.
  app.get("/api/webhook-triggers", async () => ({
    triggers: webhookTriggers.list(),
    baseUrl: panelBaseHint(),
  }));
  app.post("/api/webhook-triggers", async (req, reply) => {
    const { name, prompt, cwd, leadId, enabled } = (req.body ?? {}) as {
      name?: string;
      prompt?: string;
      cwd?: string;
      leadId?: string;
      enabled?: boolean;
    };
    // The prompt runs as an autonomous bypassPermissions turn, so cap + sanitise
    // it the same way scheduled/delegated prompts are guarded.
    const cleanPrompt = sanitizeCardField(prompt ?? "", SCHEDULE_PROMPT_MAX);
    if (!cleanPrompt) return reply.code(400).send({ error: "prompt required" });
    const view = webhookTriggers.add({ name: name ?? "", prompt: cleanPrompt, cwd, leadId, enabled });
    return { trigger: view, triggers: webhookTriggers.list() };
  });
  app.put("/api/webhook-triggers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = (req.body ?? {}) as {
      name?: string;
      prompt?: string;
      cwd?: string;
      leadId?: string;
      enabled?: boolean;
    };
    if (typeof patch.prompt === "string") {
      const cleanPrompt = sanitizeCardField(patch.prompt, SCHEDULE_PROMPT_MAX);
      if (!cleanPrompt) return reply.code(400).send({ error: "prompt required" });
      patch.prompt = cleanPrompt;
    }
    const view = webhookTriggers.update(id, patch);
    if (!view) return reply.code(404).send({ error: "not found" });
    return { trigger: view, triggers: webhookTriggers.list() };
  });
  app.post("/api/webhook-triggers/:id/rotate", async (req, reply) => {
    const view = webhookTriggers.rotateSecret((req.params as { id: string }).id);
    if (!view) return reply.code(404).send({ error: "not found" });
    return { trigger: view, triggers: webhookTriggers.list() };
  });
  // Reveal the signing secret + a ready-to-paste signed example for testing.
  app.get("/api/webhook-triggers/:id/secret", async (req, reply) => {
    const { id } = req.params as { id: string };
    const secret = webhookTriggers.reveal(id);
    if (!secret) return reply.code(404).send({ error: "not found" });
    const sampleBody = '{"hello":"world"}';
    return {
      secret,
      header: "X-Signature-256",
      sampleBody,
      sampleSignature: `sha256=${signWebhookBody(sampleBody, secret)}`,
    };
  });
  app.delete("/api/webhook-triggers/:id", async (req, reply) => {
    if (!webhookTriggers.remove((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true, triggers: webhookTriggers.list() };
  });

  // PUBLIC inbound firing endpoint. Not under /api, so the bearer-token auth hook
  // skips it; authentication is HMAC-SHA256 over the raw request body using the
  // trigger's own secret. Accepts the digest in `X-Signature-256` or GitHub's
  // `X-Hub-Signature-256` header (with or without the `sha256=` prefix).
  app.post("/hook/:id", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    if (!hookRateLimiter.tryConsume(clientIp(req))) {
      return reply.code(429).send({ error: "rate limited" });
    }
    const { id } = req.params as { id: string };
    const sig =
      (req.headers["x-signature-256"] as string | undefined) ??
      (req.headers["x-hub-signature-256"] as string | undefined) ??
      (req.headers["x-signature"] as string | undefined);
    const rawBody = (req as { rawBody?: string }).rawBody ?? "";
    const res = webhookTriggers.fire(id, rawBody, sig);
    if (!res.ok) return reply.code(res.status).send({ error: res.error ?? "rejected" });
    return reply.code(res.status).send({ ok: true, taskId: res.taskId });
  });

  app.get("/api/usage", async () => usageSummary());
  app.get("/api/usage/agents", async () => ({
    agents: agentUsage.list(),
    dailyByRole: agentUsage.dailyByRole(),
  }));
  app.get("/api/audit", async () => ({ events: recentAudit() }));
  // Searchable audit view: filter by actor (source), action, resource (action
  // prefix), free text, and a time floor. Reads the full retained log.
  app.get("/api/audit/search", async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const num = (v: string | undefined) => {
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      events: searchAudit({
        q: q.q,
        actor: q.actor,
        action: q.action,
        resource: q.resource,
        since: num(q.since),
        limit: num(q.limit),
      }),
    };
  });
  // Distinct actors / resources / actions for the panel's filter dropdowns.
  app.get("/api/audit/facets", async () => auditFacets());
  // Preview the anomaly detector against the current audit log using either the
  // saved heartbeat config or defaults (so the panel can show findings before
  // anomaly alerting is even enabled).
  app.get("/api/audit/anomalies", async () => {
    const cfg = heartbeat.view().config.anomaly ?? ANOMALY_DEFAULTS;
    // Force a scan regardless of the persisted enabled flag, so the preview
    // always returns findings; the live heartbeat still respects `enabled`.
    return { anomalies: detectAnomalies({ ...cfg, enabled: true }) };
  });
  app.get("/api/approvals", async () => ({ approvals: approvalQueue.list() }));
  app.post("/api/approvals/resolve", async (req, reply) => {
    const { id, action } = (req.body ?? {}) as { id?: string; action?: string };
    if (!id || !action) return reply.code(400).send({ error: "id and action required" });
    if (!APPROVAL_ACTIONS.has(action)) return reply.code(400).send({ error: "invalid action" });
    const ok = approvalQueue.resolve(id, action);
    if (!ok) return reply.code(409).send({ error: "approval expired or unknown" });
    return { ok: true };
  });

  // Pending AskUserQuestion prompts (mirrored from the main Telegram chat) and
  // the endpoint to answer them from the panel — settles the same blocking
  // promise the Telegram inline buttons settle.
  app.get("/api/asks", async () => ({ asks: askQueue.list() }));
  app.post("/api/asks/resolve", async (req, reply) => {
    const { id, optionIndices, text } = (req.body ?? {}) as {
      id?: string;
      optionIndices?: unknown;
      text?: unknown;
    };
    if (!id) return reply.code(400).send({ error: "id required" });
    const idxs = Array.isArray(optionIndices)
      ? optionIndices.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0)
      : undefined;
    const answer = { optionIndices: idxs, text: typeof text === "string" ? text : undefined };
    if ((!idxs || idxs.length === 0) && !answer.text?.trim()) {
      return reply.code(400).send({ error: "optionIndices or text required" });
    }
    const ok = askQueue.resolve(id, answer);
    if (!ok) return reply.code(409).send({ error: "question expired or unknown" });
    return { ok: true };
  });

  // --- Web Push: VAPID key, browser subscriptions, test send ---
  // The public VAPID key is generated lazily on first read so an install that
  // never opens the Notifications card never provisions a keypair.
  app.get("/api/push", async () => ({ ...push.view(), publicKey: push.publicKey() }));
  app.post("/api/push/subscribe", async (req, reply) => {
    const body = (req.body ?? {}) as {
      subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      label?: string;
    };
    const sub = body.subscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return reply.code(400).send({ error: "valid subscription required" });
    }
    try {
      const { id } = push.subscribe(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        typeof body.label === "string" ? body.label : undefined,
      );
      return { ok: true, id };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "subscribe failed" });
    }
  });
  app.delete("/api/push/subscribe/:id", async (req, reply) => {
    if (!push.unsubscribe((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.post("/api/push/test", async () => {
    await push.notify({
      title: "MyAgens",
      body: "Test notification — push is working.",
      kind: "test",
      tag: "myagens-test",
    });
    return { ok: true, subscribers: push.subscriberCount() };
  });
  // GET /api/logs
  //   ?date=YYYY-MM-DD  — read from the persisted file for that date
  //                        (omit to get the live in-memory ring for today)
  //   &q=text           — case-insensitive substring search across msg + meta
  //   &level=info       — filter to a single level
  //   &limit=N          — cap to the last N entries (omit for the full file)
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

  // GET /api/logs/search — smart search across ALL retained log files at once
  //   &q=text   — case-insensitive substring search across msg + meta
  //   &level=   — filter to a single level
  //   &hours=72 — only entries from the last N hours (default 72 = full window)
  //   &limit=N  — keep the most recent N matches (omit for all)
  app.get("/api/logs/search", async (req) => {
    const { q, level, hours, limit } = (req.query ?? {}) as Record<string, string | undefined>;
    const h = hours ? Number(hours) : 72;
    const sinceMs = Number.isFinite(h) && h > 0 ? Date.now() - h * 3_600_000 : undefined;
    return {
      logs: searchAllLogs({
        q,
        level: level as LogEntry["level"] | undefined,
        sinceMs,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  });

  // GET /api/logs/summary — most-used tools and shell commands across all files
  //   &hours=72 — window to summarise (default 72 = full retained window)
  app.get("/api/logs/summary", async (req) => {
    const { hours } = (req.query ?? {}) as Record<string, string | undefined>;
    const h = hours ? Number(hours) : 72;
    const sinceMs = Number.isFinite(h) && h > 0 ? Date.now() - h * 3_600_000 : undefined;
    return summarizeUsage({ sinceMs });
  });

  // --- system prompt / playbook ---
  app.get("/api/prompt", async () => getPrompt());
  app.put("/api/prompt", async (req) => {
    const { content } = (req.body ?? {}) as { content?: string };
    return savePlaybook(typeof content === "string" ? content : "");
  });
  app.post("/api/prompt/restore", async (_req, reply) => {
    try {
      return restorePlaybook();
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
  app.get("/api/skills/:id/export", async (req, reply) => {
    const bundle = exportSkill((req.params as { id: string }).id);
    if (!bundle) return reply.code(404).send({ error: "not found" });
    return bundle;
  });
  app.post("/api/skills/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const res = importSkill(req.body);
    if ("error" in res) return reply.code(400).send({ error: res.error });
    return res.skill;
  });

  // --- prompt templates (reusable turn prompts with {{variable}} slots) ---
  const withVars = (t: ReturnType<typeof listTemplates>[number]) => ({
    ...t,
    variables: templateVariables(t.body),
  });
  app.get("/api/templates", async () => ({ templates: listTemplates().map(withVars) }));
  app.post("/api/templates", async (req) => withVars(createTemplate(req.body as never)));
  app.put("/api/templates/:id", async (req, reply) => {
    const updated = updateTemplate((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return withVars(updated);
  });
  app.delete("/api/templates/:id", async (req, reply) => {
    if (!deleteTemplate((req.params as { id: string }).id))
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

  // --- feedback: forward a bug report / suggestion to the project endpoint ---
  // The panel "Send feedback" form POSTs here; we relay it to the central
  // collector (FEEDBACK_URL, defaulting to gyorgy.sh) with a little deployment
  // context so reports can be triaged server-side later. Fire-and-await with a
  // short timeout so a slow collector can't hang the panel; failures surface as
  // a 502 so the UI can tell the user it didn't go through.
  app.post("/api/feedback", async (req, reply) => {
    const { kind, message, email } = (req.body ?? {}) as { kind?: string; message?: string; email?: string };
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) return reply.code(400).send({ error: "message required" });
    if (text.length > 5000) return reply.code(400).send({ error: "message too long (max 5000 chars)" });
    // Email is optional; validate loosely only when provided, and cap the length.
    const mail = typeof email === "string" ? email.trim() : "";
    if (mail && (mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))) {
      return reply.code(400).send({ error: "invalid email" });
    }
    const category = kind === "bug" || kind === "suggestion" || kind === "other" ? kind : "other";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(config.FEEDBACK_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": `${config.BRAND_NAME}-feedback` },
        body: JSON.stringify({
          kind: category,
          message: text,
          ...(mail ? { email: mail } : {}),
          version: VERSION,
          brand: config.BRAND_NAME,
          platform: process.platform,
          submittedAt: new Date().toISOString(),
        }),
        signal: ctrl.signal,
      });
      // Pass a collector rate-limit (429) straight through so the panel can show
      // the real "too many submissions" message instead of a generic failure.
      if (res.status === 429) {
        log.warn("Feedback relay rate-limited", { status: 429 });
        return reply.code(429).send({ error: "Too many submissions. Please try again later." });
      }
      if (!res.ok) {
        log.warn("Feedback relay returned non-2xx", { status: res.status });
        return reply.code(502).send({ error: "feedback endpoint unavailable" });
      }
      log.info("Feedback submitted", { kind: category });
      return { ok: true };
    } catch (err) {
      log.warn("Feedback relay failed", { error: err instanceof Error ? err.message : String(err) });
      return reply.code(502).send({ error: "feedback endpoint unavailable" });
    } finally {
      clearTimeout(timer);
    }
  });

  // --- self-update ---
  app.get("/api/update", async () => ({ ...getUpdateStatus(), serviceInstalled: serviceInstalled(), platform: process.platform, active: isActive() }));
  app.post("/api/update/check", async () => ({ ...(await checkForUpdate()), serviceInstalled: serviceInstalled(), platform: process.platform, active: isActive() }));
  app.post("/api/update/run", async () => {
    if (getUpdateStatus().updating) return { started: false };
    // Stream output to panel clients; don't await (the run may restart us).
    void runUpdate((line) => {
      log.info(`[update] ${line}`);
      hub.broadcast({ type: "update", line });
    }).catch(() => {});
    return { started: true };
  });
  app.post("/api/update/restore", async () => {
    if (getUpdateStatus().updating) return { started: false };
    // Recovery: hard-reset code to the remote (keeps data/config), rebuild,
    // restart. Stream to panel clients; don't await (the run may restart us).
    void runRestore((line) => {
      log.info(`[restore] ${line}`);
      hub.broadcast({ type: "update", line });
    }).catch(() => {});
    return { started: true };
  });
  // Local CHANGELOG.md fallback for the Updates view: when the panel can't reach
  // the public GitHub raw URL (offline, GitHub down), it falls back to the file
  // shipped with the installed checkout. Fixed internal path, same class as the
  // log endpoints — no user input reaches the path.
  app.get("/api/update/changelog", async (_req, reply) => {
    const file = join(repoRoot, "CHANGELOG.md");
    if (!existsSync(file)) return reply.code(404).send({ error: "not found" });
    try {
      return { content: readFileSync(file, "utf8") };
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  // --- durable memory ---
  // Drop the (large) raw embedding vector from API responses; the panel never
  // needs it and it would bloat every payload.
  const stripEmbedding = (e: MemoryEntry): Omit<MemoryEntry, "embedding"> & { embedded: boolean } => {
    const { embedding, ...rest } = e;
    return { ...rest, embedded: !!(embedding && embedding.length) };
  };
  app.get("/api/memories/stats", async () => memory.stats());
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
  // Portable JSON dump of every entry (hot/warm/cold), embeddings stripped.
  app.get("/api/memories/export", async (_req, reply) => {
    const dump = memory.export();
    reply.header("content-disposition", `attachment; filename="memories-${new Date().toISOString().slice(0, 10)}.json"`);
    return dump;
  });
  // Merge an exported dump; dedup by text. Body is the export object or a bare array.
  app.post("/api/memories/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const body = req.body as { entries?: unknown } | unknown[];
    const rawEntries = Array.isArray(body) ? body : (body?.entries as unknown);
    if (!Array.isArray(rawEntries))
      return reply.code(400).send({ error: "expected an array of entries or { entries: [...] }" });
    return memory.import(rawEntries as never);
  });

  // --- conversation search (live chat + run transcripts) ---
  app.get("/api/conversations/search", async (req) => {
    const { q, limit } = req.query as { q?: string; limit?: string };
    const n = Math.min(100, Math.max(1, Number(limit) || 25));
    const hits = q ? await searchConversations(q, n) : [];
    return { hits };
  });

  // --- suggestion inbox ---
  app.get("/api/suggestions", async (req) => {
    const { status } = req.query as { status?: string };
    const filter =
      status === "pending" || status === "accepted" || status === "dismissed" ? status : undefined;
    return { suggestions: suggestions.list(filter) };
  });
  app.post("/api/suggestions/:id/accept", async (req, reply) => {
    const updated = suggestions.accept((req.params as { id: string }).id);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.post("/api/suggestions/:id/delegate", async (req, reply) => {
    const { leadId } = (req.body ?? {}) as { leadId?: string };
    const { suggestion, leadName, started } = suggestions.delegate(
      (req.params as { id: string }).id,
      typeof leadId === "string" && leadId ? leadId : undefined,
    );
    if (!suggestion) return reply.code(404).send({ error: "not found" });
    return { suggestion, leadName, started };
  });
  app.post("/api/suggestions/:id/dismiss", async (req, reply) => {
    const updated = suggestions.dismiss((req.params as { id: string }).id);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });

  // --- external connectors ---
  app.get("/api/connectors", async () => ({ connectors: listConnectors() }));
  app.put("/api/connectors/:id", async (req, reply) => {
    const body = (req.body ?? {}) as {
      secretId?: string;
      enabled?: boolean;
      scope?: string;
      expiresAt?: number | null;
    };
    // null clears expiry, a number sets it, undefined leaves it untouched.
    const expiresAt =
      body.expiresAt === null ? null : typeof body.expiresAt === "number" ? body.expiresAt : undefined;
    const updated = setConnector((req.params as { id: string }).id, {
      secretId: body.secretId,
      enabled: body.enabled,
      scope: body.scope === "write" ? "write" : body.scope === "read" ? "read" : undefined,
      expiresAt,
    });
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  // Multi-account (social) connectors: named accounts, each with its own credential.
  app.post("/api/connectors/:id/accounts", async (req, reply) => {
    const body = (req.body ?? {}) as { label?: string; secretId?: string };
    const result = addConnectorAccount((req.params as { id: string }).id, {
      label: body.label ?? "",
      secretId: body.secretId ?? "",
    });
    if ("error" in result) return reply.code(400).send(result);
    return result;
  });
  app.put("/api/connectors/:id/accounts/:accountId", async (req, reply) => {
    const p = req.params as { id: string; accountId: string };
    const body = (req.body ?? {}) as { label?: string; secretId?: string };
    const result = updateConnectorAccount(p.id, p.accountId, { label: body.label, secretId: body.secretId });
    if ("error" in result) return reply.code(result.error === "account not found" ? 404 : 400).send(result);
    return result;
  });
  app.delete("/api/connectors/:id/accounts/:accountId", async (req, reply) => {
    const p = req.params as { id: string; accountId: string };
    const result = removeConnectorAccount(p.id, p.accountId);
    if ("error" in result) return reply.code(404).send(result);
    return result;
  });

  // --- image gallery (generated images from Recraft/Ideogram etc.) ---
  app.get("/api/gallery", async (req) => {
    const q = req.query as { tag?: string; provider?: string; from?: string; to?: string; q?: string };
    const images = await listImages({
      tag: q.tag || undefined,
      provider: q.provider || undefined,
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      q: q.q || undefined,
    });
    return { images, tags: listTags() };
  });
  app.get("/api/gallery/:id", async (req, reply) => {
    const image = getImage((req.params as { id: string }).id);
    if (!image) return reply.code(404).send({ error: "not found" });
    return image;
  });
  app.get("/api/gallery/:id/file", async (req, reply) => {
    const image = getImage((req.params as { id: string }).id);
    if (!image) return reply.code(404).send({ error: "not found" });
    const full = dataPath(image.path);
    if (!existsSync(full)) return reply.code(404).send({ error: "file missing" });
    const ext = image.path.split(".").pop()?.toLowerCase();
    const contentType =
      ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    reply.header("content-type", contentType).header("cache-control", "private, max-age=31536000, immutable");
    return reply.send(readFileSync(full));
  });
  app.put("/api/gallery/:id", async (req, reply) => {
    const body = (req.body ?? {}) as { tags?: string[] };
    const updated = updateImage((req.params as { id: string }).id, { tags: body.tags });
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.delete("/api/gallery/:id", async (req, reply) => {
    const ok = deleteImage((req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.post("/api/gallery/generate", async (req, reply) => {
    const body = (req.body ?? {}) as {
      providerId?: string;
      prompt?: string;
      size?: string;
      style?: string;
      model?: string;
      negativePrompt?: string;
      steps?: number;
      extraInput?: Record<string, unknown>;
    };
    const validProviders = ["recraft", "ideogram", "replicate", "fal", "local_sd"];
    if (!body.providerId || !validProviders.includes(body.providerId)) {
      return reply.code(400).send({ error: `providerId must be one of: ${validProviders.join(", ")}` });
    }
    if (!body.prompt || !body.prompt.trim()) return reply.code(400).send({ error: "prompt is required" });
    if ((body.providerId === "replicate" || body.providerId === "fal") && !body.model?.trim()) {
      return reply.code(400).send({ error: "model is required for the Replicate/fal.ai connectors" });
    }
    try {
      const image: GalleryImage = await generateImage({
        providerId: body.providerId as ImageProviderId,
        prompt: body.prompt,
        size: body.size,
        style: body.style,
        model: body.model,
        negativePrompt: body.negativePrompt,
        steps: body.steps,
        extraInput: body.extraInput,
      });
      return image;
    } catch (err) {
      const msg = err instanceof ImageGenError ? err.message : err instanceof Error ? err.message : "generation failed";
      return reply.code(400).send({ error: msg });
    }
  });

  // --- generic webhook tools (custom HTTP endpoints exposed as MCP tools) ---
  app.get("/api/webhook-tools", async () => ({ tools: listWebhookTools() }));
  app.post("/api/webhook-tools", async (req) => createWebhookTool((req.body ?? {}) as never));
  app.put("/api/webhook-tools/:id", async (req, reply) => {
    const updated = updateWebhookTool((req.params as { id: string }).id, (req.body ?? {}) as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });
  app.delete("/api/webhook-tools/:id", async (req, reply) => {
    const ok = deleteWebhookTool((req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // --- white-label branding ---
  app.get("/api/branding", async () => ({
    branding: getBranding(),
    effective: effectiveBranding(),
  }));
  app.put("/api/branding", async (req) => ({
    branding: setBranding((req.body ?? {}) as never),
    effective: effectiveBranding(),
  }));

  // --- secret vault ---
  app.get("/api/vault", async () => ({
    secrets: vault.list(),
    usages: vaultUsages(),
    keyRotatedAt: vault.lastRotatedAt(),
  }));
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
  app.post("/api/vault/rotate", async (_req, reply) => {
    try {
      return vault.rotateKey();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "rotation failed" });
    }
  });
  app.post("/api/vault/export", async (req, reply) => {
    const passphrase = (req.body as { passphrase?: string })?.passphrase ?? "";
    try {
      return { blob: vault.exportBackup(passphrase) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "export failed" });
    }
  });
  app.post("/api/vault/import-backup", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const { blob, passphrase } = (req.body as { blob?: string; passphrase?: string }) ?? {};
    if (!blob || !passphrase) return reply.code(400).send({ error: "blob and passphrase required" });
    try {
      return vault.importBackup(blob, passphrase);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "import failed" });
    }
  });

  // --- full-state backup & restore ---
  app.get("/api/backup", async () => backupManifest());
  app.post("/api/backup/export", async (req, reply) => {
    const passphrase = (req.body as { passphrase?: string })?.passphrase ?? "";
    try {
      const buf = exportBackup(passphrase);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="myagens-backup-${stamp}.mag"`);
      return reply.send(buf);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "export failed" });
    }
  });
  app.post("/api/backup/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const { archive, passphrase, includeVault } =
      (req.body as { archive?: string; passphrase?: string; includeVault?: boolean }) ?? {};
    if (!archive || !passphrase)
      return reply.code(400).send({ error: "archive and passphrase required" });
    let buf: Buffer;
    try {
      buf = Buffer.from(archive, "base64");
    } catch {
      return reply.code(400).send({ error: "archive is not valid base64" });
    }
    try {
      return importBackup(buf, passphrase, { includeVault: includeVault !== false });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "import failed" });
    }
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
  app.get("/api/tasks", async () => {
    pruneArchive();
    autoArchive();
    // Resolve each card's creator id to a friendly display name for the board,
    // and annotate which prerequisite ids (blockedBy) are still unsatisfied so
    // the board can render a "blocked" badge + dependency arrows.
    const tasks = listTasks().map((t) => ({
      ...t,
      createdByName: t.createdBy ? creatorName(t.createdBy) : undefined,
      blockingIds: t.blockedBy?.length ? blockingPrereqs(t.id).map((p) => p.id) : undefined,
      waitingOnPrereq: taskDelegator.isBlocked(t.id) || undefined,
      // A failed card carries a resume token if its last run captured a Claude
      // session, so a retry can continue that conversation. Surface a boolean
      // (never the raw token) so the panel can label the Retry action.
      canResume: !!t.delegate?.sessionId || !!t.resumeSessionId || undefined,
    }));
    return {
      tasks,
      columns: listColumns(),
      wip: getWip(),
      config: getTaskRunConfig(),
      queue: { paused: taskDelegator.isQueuePaused(), queued: taskDelegator.queuedCount(), blocked: taskDelegator.blockedCount() },
    };
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
  // Global delegation timeout + concurrency limit.
  app.get("/api/tasks/config", async () => ({ config: getTaskRunConfig() }));
  app.put("/api/tasks/config", async (req) => {
    const { timeoutMs, maxConcurrent } = (req.body ?? {}) as { timeoutMs?: number; maxConcurrent?: number };
    return { config: setTaskRunConfig({ timeoutMs, maxConcurrent }) };
  });
  app.post("/api/tasks/:id/delegate", async (req, reply) => {
    const { leadId } = (req.body ?? {}) as { leadId?: string };
    const r = taskDelegator.delegate(
      (req.params as { id: string }).id,
      typeof leadId === "string" && leadId ? leadId : undefined,
    );
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { ok: true };
  });
  app.post("/api/tasks/:id/stop", async (req) => ({
    ok: taskDelegator.stop((req.params as { id: string }).id),
  }));
  // Queue controls: pause holds dispatch of queued cards (in-flight runs keep
  // going); resume fills free slots again; clear drops all waiting cards.
  app.get("/api/tasks/queue", async () => ({
    paused: taskDelegator.isQueuePaused(),
    queued: taskDelegator.queuedCount(),
  }));
  app.post("/api/tasks/queue/pause", async () => {
    taskDelegator.pauseQueue();
    return { paused: true, queued: taskDelegator.queuedCount() };
  });
  app.post("/api/tasks/queue/resume", async () => {
    taskDelegator.resumeQueue();
    return { paused: false, queued: taskDelegator.queuedCount() };
  });
  app.post("/api/tasks/queue/clear", async () => ({
    cleared: taskDelegator.clearQueue(),
    paused: taskDelegator.isQueuePaused(),
  }));
  // Retry a failed card: reset to backlog (clear error, bump retryCount) and
  // re-delegate in one click.
  app.post("/api/tasks/:id/retry", async (req, reply) => {
    const r = taskDelegator.retry((req.params as { id: string }).id);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { ok: true, retryCount: r.retryCount };
  });
  // Unstick a card jammed in a queued/running/error state (e.g. orphaned by a
  // crash): abort any live run, drop it from the queue, and clear its
  // delegation without re-running it.
  app.post("/api/tasks/:id/unstick", async (req, reply) => {
    const ok = taskDelegator.unstick((req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
  app.post("/api/tasks", async (req) => {
    const body = (req.body ?? {}) as Parameters<typeof createTask>[0];
    // Cards made through the panel/REST are attributed to "panel" unless the
    // caller explicitly passes a creator id.
    return createTask({ ...body, createdBy: body.createdBy || "panel" });
  });
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
    providers: listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      kind: providerKind(p.baseUrl),
    })),
    backends: listBackends().map((b) => ({ id: b.id, displayName: b.displayName })),
  }));
  app.post("/api/workers", async (req, reply) => {
    const hook = (req.body as { webhookUrl?: string })?.webhookUrl;
    if (hook?.trim() && !(await isValidWebhookUrl(hook)))
      return reply.code(400).send({ error: "invalid or blocked webhook URL" });
    return workerView(workers.create(req.body as never));
  });
  app.put("/api/workers/:id", async (req, reply) => {
    const hook = (req.body as { webhookUrl?: string })?.webhookUrl;
    if (hook?.trim() && !(await isValidWebhookUrl(hook)))
      return reply.code(400).send({ error: "invalid or blocked webhook URL" });
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
    const { prompt } = (req.body ?? {}) as { prompt?: string };
    const run = workers.run(
      (req.params as { id: string }).id,
      typeof prompt === "string" ? prompt : undefined,
    );
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });
  app.post("/api/workers/:id/stop", async (req) => ({
    ok: workers.stopRun((req.params as { id: string }).id),
  }));
  // Force a Lead's Telegram bot instance to restart — the watchdog already
  // self-heals a dead poll within 60s, but this gives a way to force it right
  // now (e.g. while diagnosing a report of a Lead not responding).
  app.post("/api/workers/:id/restart-bot", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const worker = workers.list().find((w) => w.id === id);
    if (!worker || worker.role !== "lead" || !worker.telegramToken || !worker.enabled) {
      return reply.code(404).send({ error: "not a live Lead bot" });
    }
    return { ok: await leadBots.restartOne(id) };
  });
  app.get("/api/workers/:id/runs", async (req) => ({
    runs: workers.history((req.params as { id: string }).id),
  }));
  app.get("/api/runs", async () => ({ runs: workers.history() }));

  // Full uncapped transcript for one run (worker or delegated task), read from
  // the runs/YYYY-MM-DD/<runId>.ndjson files. Returns [] when absent/expired.
  app.get("/api/runs/:runId/log", async (req) => ({
    events: readRunLog((req.params as { runId: string }).runId),
  }));

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

    // Run the generation on the same model/provider the main agent is configured
    // to use, so the wizard works when the bot runs on a local model or proxy
    // (otherwise it falls back to config.CLAUDE_MODEL and the CLI exits non-zero
    // when no Anthropic credential is present, surfacing as an opaque 500).
    const mainRun = resolveMainRun();
    // Config generation benefits from a stronger model than whatever the main
    // agent happens to be set to — but only on the default Anthropic cloud path.
    // If mainRun.env carries a local/proxy override (Ollama, LM Studio, custom
    // base URL) a hardcoded cloud model id would break the wizard entirely, so
    // fall back to mainRun.model there exactly as before.
    const isCloud = !mainRun.env || Object.keys(mainRun.env).length === 0;
    const WIZARD_CLOUD_MODEL = "claude-sonnet-5";
    const WIZARD_CLOUD_THINKING_BUDGET = 24_000;
    // Generate the human-readable fields in the user's configured language so
    // they can actually understand the config they're about to create, rather
    // than always getting English back regardless of their panel/agent language.
    const wizardLang = mainRun.defaultLanguage;
    const languageInstruction =
      wizardLang && wizardLang !== "en"
        ? `\n\nWrite all human-readable text fields (name, portfolio, prompt, persona, systemPrompt) in ${languageName(wizardLang)}, since that's the user's configured language. Keep JSON keys and enum values (role, autonomy) exactly as specified in English.`
        : "";

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
- language: string — BCP 47 code, "${wizardLang ?? ""}" so this worker's own future runs also respond in that language, or "" for default
- enabled: boolean

Rules:
- If crew=false, return exactly one worker object (role: "").
- If crew=true, design a minimal effective crew: one lead and 1-3 assistants that each own a slice of the work.
- The prompt must be a complete, standalone task description — the agent has no other context when it runs.
- Autonomy should be "full" for unattended work, "standard" if the task touches risky resources.
- Be specific and practical. No placeholders.${languageInstruction}

Respond with ONLY a JSON array, no markdown fences, no explanation. Example format:
[{"name":"Finance Lead","role":"lead","portfolio":"Finance","parentId":"","cwd":"/home/user","prompt":"...","persona":"...","systemPrompt":"...","autonomy":"full","when":"09:00","model":"","language":"${wizardLang ?? ""}","enabled":true}]`;

    const abort = new AbortController();
    // Bound the turn so a stuck/slow CLI doesn't hang the request indefinitely
    // (the model occasionally takes ~30s; give it generous headroom then abort).
    const timeout = setTimeout(() => abort.abort(), 120_000);
    try {
      let output = "";
      // Use os.tmpdir() as the cwd when none is provided: avoids loading the
      // project's CLAUDE.md (which can be very large) into a config-gen turn.
      const wizardCwd = cwd?.trim() || tmpdir();
      const result = await getBackend(mainRun.backendId).runTurn({
        prompt,
        cwd: wizardCwd,
        model: isCloud ? WIZARD_CLOUD_MODEL : mainRun.model,
        maxThinkingTokens: isCloud ? WIZARD_CLOUD_THINKING_BUDGET : undefined,
        env: mainRun.env,
        promptExclude: mainRun.promptExclude,
        permissionMode: "bypassPermissions",
        settingSources: ["user"],
        abortController: abort,
        mcpServers: {},
        canUseTool: async (_name, input) => ({ behavior: "allow" as const, updatedInput: input }),
        onText: (delta) => { output += delta; },
        onToolUse: () => {},
        onSessionId: () => {},
      });
      if (result.isError) {
        const detail = result.text?.trim() || "No output from model";
        log.error("wizard: model turn returned isError", { detail: detail.slice(0, 300) });
        return reply.code(502).send({ error: `Model returned an error: ${detail.slice(0, 200)}` });
      }
      // Extract the JSON array from the output. Prefer a fenced ```json block if
      // present, else the outermost [...] span; tolerate stray prose around it.
      const fenced = output.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
      const span = fenced?.[1] ?? output.match(/\[[\s\S]*\]/)?.[0];
      if (!span) {
        log.warn("wizard: model returned no JSON array", { rawTail: output.slice(-500) });
        return reply.code(502).send({ error: "Model returned no JSON", raw: output.slice(0, 500) });
      }
      let configs: unknown[];
      try {
        configs = JSON.parse(span) as unknown[];
      } catch {
        log.warn("wizard: model JSON failed to parse", { rawTail: output.slice(-500) });
        return reply.code(502).send({ error: "Model returned malformed JSON", raw: span.slice(0, 500) });
      }
      if (!Array.isArray(configs) || configs.length === 0) {
        return reply.code(502).send({ error: "Model returned no worker configs", raw: span.slice(0, 500) });
      }
      return { configs };
    } catch (err) {
      const aborted = abort.signal.aborted;
      const message = aborted
        ? "Generation timed out — the model took too long to respond. Try again."
        : err instanceof Error ? err.message : String(err);
      log.error("wizard generation failed", { error: message, aborted });
      return reply.code(aborted ? 504 : 500).send({ error: message });
    } finally {
      clearTimeout(timeout);
    }
  });

  // --- in-panel chat (dedicated Claude session) ---
  app.get("/api/chat", async () => chat.view());
  app.post("/api/chat/send", async (req, reply) => {
    const { text, planning, images } = (req.body ?? {}) as { text?: string; planning?: boolean; images?: unknown };
    const r = chat.send(typeof text === "string" ? text : "", planning === true, sanitizeChatImages(images));
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
    const { cwd, auto, autonomy } = (req.body ?? {}) as {
      cwd?: string;
      auto?: boolean;
      autonomy?: string;
    };
    if (typeof cwd === "string") chat.setCwd(cwd);
    if (typeof auto === "boolean") chat.setAuto(auto);
    if (autonomy === "supervised" || autonomy === "standard" || autonomy === "full") {
      chat.setAutonomy(autonomy);
    }
    return chat.view();
  });
  app.post("/api/chat/approve", async (req, reply) => {
    const { approvalId, allow } = (req.body ?? {}) as { approvalId?: string; allow?: boolean };
    if (!approvalId) return reply.code(400).send({ error: "approvalId required" });
    return { ok: chat.resolveApproval(approvalId, Boolean(allow)) };
  });
  // React to an assistant message: a thumbs-up files the response as a durable
  // memory (so the agent reuses it); a thumbs-down lands a suggestion in the
  // president's inbox flagging it as unhelpful. Text comes from the client (the
  // bubble it already has) so this needs no message lookup.
  app.post("/api/chat/react", async (req, reply) => {
    const { reaction, text } = (req.body ?? {}) as { reaction?: string; text?: string };
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) return reply.code(400).send({ error: "text required" });
    if (reaction === "up") {
      const snippet = body.length > 280 ? `${body.slice(0, 277)}…` : body;
      memory.create({ text: snippet, tags: ["chat-feedback", "helpful"], salience: 0.6 });
      return { ok: true, kind: "memory" };
    }
    if (reaction === "down") {
      const title = body.split("\n")[0]?.slice(0, 80) || "Unhelpful chat response";
      suggestions.add({
        fromAgentId: "panel",
        fromAgentName: "Panel feedback",
        title: `Unhelpful response: ${title}`,
        detail: `The president marked this chat response as unhelpful:\n\n${body}`,
        category: "chat-feedback",
      });
      return { ok: true, kind: "suggestion" };
    }
    return reply.code(400).send({ error: "reaction must be up or down" });
  });

  // --- per-agent interactive chat (talk to a specific worker / Lead) ---
  app.get("/api/agent-chat/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = agentChat.view(id);
    if (!v) return reply.code(404).send({ error: "agent not found" });
    return v;
  });
  app.post("/api/agent-chat/:id/send", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, planning, images } = (req.body ?? {}) as { text?: string; planning?: boolean; images?: unknown };
    const r = agentChat.send(id, typeof text === "string" ? text : "", planning === true, sanitizeChatImages(images));
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return agentChat.view(id);
  });
  app.post("/api/agent-chat/:id/stop", async (req) => {
    const { id } = req.params as { id: string };
    agentChat.stop(id);
    return { ok: true };
  });
  app.post("/api/agent-chat/:id/clear", async (req, reply) => {
    const { id } = req.params as { id: string };
    agentChat.clear(id);
    const v = agentChat.view(id);
    if (!v) return reply.code(404).send({ error: "agent not found" });
    return v;
  });
  app.put("/api/agent-chat/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { cwd } = (req.body ?? {}) as { cwd?: string };
    if (typeof cwd === "string") agentChat.setCwd(id, cwd);
    const v = agentChat.view(id);
    if (!v) return reply.code(404).send({ error: "agent not found" });
    return v;
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
  app.post("/api/maintenance/preview", async () => maintenance.previewCompaction());
  app.post("/api/maintenance/run", async () => maintenance.runOnce());

  // --- language catalogue ---
  app.get("/api/languages", async () => ({ languages: AGENT_LANGUAGES }));

  // --- council vote log ---
  app.get("/api/council", async (req) => {
    const limitParam = (req.query as { limit?: string }).limit;
    const limit = Math.min(parseInt(limitParam ?? "20", 10), 100);
    const file = dataPath("council.jsonl");
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

  // Get / set the council decision rule (majority / supermajority / unanimous)
  app.get("/api/council/rule", async () => ({ rule: getCouncilRule() }));

  app.put("/api/council/rule", async (req, reply) => {
    const { rule } = (req.body ?? {}) as { rule?: string };
    const valid: CouncilRule[] = ["majority", "supermajority", "unanimous"];
    if (!rule || !valid.includes(rule as CouncilRule)) {
      return reply.code(400).send({ error: "rule must be majority, supermajority, or unanimous" });
    }
    return { rule: setCouncilRule(rule as CouncilRule) };
  });

  // Trigger a council vote (same flow as the Telegram /council command)
  app.post("/api/council", async (req, reply) => {
    const { proposal } = (req.body ?? {}) as { proposal?: string };
    if (!proposal?.trim()) return reply.code(400).send({ error: "proposal required" });
    try {
      const session = await runCouncil(proposal.trim());
      return { session };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Panel council vote failed", { error: message });
      return reply.code(500).send({ error: message });
    }
  });

  // Delete a single council session from the history
  app.delete("/api/council/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = deleteCouncilSession(id);
    if (!ok) return reply.code(404).send({ error: "Session not found" });
    return { ok: true };
  });

  // --- delegation log (inter-agent crew communication) ---
  app.get("/api/delegations", async (req) => {
    const limitParam = (req.query as { limit?: string }).limit;
    const limit = Math.min(parseInt(limitParam ?? "50", 10), 200);
    const file = dataPath("delegations.jsonl");
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

  // --- model providers (local LM Studio/Ollama, proxies; also voice STT/TTS keys) ---
  app.get("/api/providers", async (req) => {
    const { purpose } = (req.query ?? {}) as { purpose?: string };
    return { providers: listProviderViews({ purpose: purpose === "voice" ? "voice" : "chat" }) };
  });
  // Fetch the model list for an unsaved endpoint (provider form).
  app.post("/api/providers/models", async (req, reply) => {
    const { baseUrl, authToken } = (req.body ?? {}) as { baseUrl?: string; authToken?: string };
    if (!baseUrl) return reply.code(400).send({ error: "baseUrl required" });
    try {
      return { models: await fetchProviderModels(baseUrl, authToken) };
    } catch (err) {
      // A blocked URL (SSRF guard) is a bad request, not an upstream failure.
      const code = err instanceof BlockedUrlError ? 400 : 502;
      return reply.code(code).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // Fetch the model list for a saved provider (worker form).
  app.get("/api/providers/:id/models", async (req, reply) => {
    const p = getProvider((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "not found" });
    try {
      return { models: await fetchProviderModels(p.baseUrl, resolveSecret(p.authToken)) };
    } catch (err) {
      const code = err instanceof BlockedUrlError ? 400 : 502;
      return reply.code(code).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/providers", async (req) => toProviderView(createProvider(req.body as never)));
  app.put("/api/providers/:id", async (req, reply) => {
    const updated = updateProvider((req.params as { id: string }).id, req.body as never);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return toProviderView(updated);
  });
  app.delete("/api/providers/:id", async (req, reply) => {
    if (!deleteProvider((req.params as { id: string }).id))
      return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  // --- voice settings (STT/TTS engine + provider selection) ---
  app.get("/api/voice", async () => voiceSettingsView());
  app.put("/api/voice", async (req) => {
    setVoiceSettings(req.body as never);
    return voiceSettingsView();
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
    // Why it's unavailable, so the UI can show the right hint: "disabled" (the
    // PANEL_TERMINAL_ENABLED flag is off) vs "unsupported" (node-pty missing).
    reason: !ptyManager.enabled ? "disabled" : ptyManager.available ? null : "unsupported",
    shell: ptyManager.currentShell,
  }));
  app.post("/api/terminal/spawn", async (req, reply) => {
    if (!ptyManager.enabled) return reply.code(403).send({ error: "terminal disabled" });
    const { cols, rows } = (req.body ?? {}) as { cols?: number; rows?: number };
    ptyManager.spawn(cols ?? 120, rows ?? 30);
    return { ok: true };
  });
  app.post("/api/terminal/resize", async (req, reply) => {
    if (!ptyManager.enabled) return reply.code(403).send({ error: "terminal disabled" });
    const { cols, rows } = (req.body ?? {}) as { cols?: number; rows?: number };
    if (typeof cols === "number" && typeof rows === "number") ptyManager.resize(cols, rows);
    return { ok: true };
  });

  // --- Remote access (tunnel relay) ---
  app.get("/api/tunnel", async () => tunnelManager.view());
  app.put("/api/tunnel", async (req, reply) => {
    if (!tunnelManager.enabled) return reply.code(403).send({ error: "remote access disabled" });
    const { provider, authToken, domain, autoStart, basicAuth } = (req.body ?? {}) as {
      provider?: "ngrok" | "cloudflare";
      authToken?: string;
      domain?: string;
      autoStart?: boolean;
      basicAuth?: boolean;
    };
    tunnelManager.setConfig({ provider, authToken, domain, autoStart, basicAuth });
    // Turning the gate on generates the password immediately if none exists yet.
    if (basicAuth === true) tunnelManager.ensurePassword();
    return tunnelManager.view();
  });
  // Reveal / rotate / set the Basic Auth password. Username is fixed to `myagens`.
  app.get("/api/tunnel/password", async (_req, reply) => {
    if (!tunnelManager.enabled) return reply.code(403).send({ error: "remote access disabled" });
    const password = tunnelManager.revealPassword();
    return { user: BASIC_AUTH_USER, password: password ?? null };
  });
  app.post("/api/tunnel/password", async (req, reply) => {
    if (!tunnelManager.enabled) return reply.code(403).send({ error: "remote access disabled" });
    const { password } = (req.body ?? {}) as { password?: string };
    if (typeof password === "string" && password.trim()) {
      if (!tunnelManager.setPassword(password)) {
        return reply.code(400).send({ error: "password must be at least 6 characters" });
      }
      return { user: BASIC_AUTH_USER, password: password.trim() };
    }
    // No password supplied → rotate to a fresh random one.
    return { user: BASIC_AUTH_USER, password: tunnelManager.rotatePassword() };
  });
  app.post("/api/tunnel/start", async (_req, reply) => {
    if (!tunnelManager.enabled) return reply.code(403).send({ error: "remote access disabled" });
    const r = tunnelManager.start_relay();
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return tunnelManager.view();
  });
  app.post("/api/tunnel/stop", async (_req, reply) => {
    if (!tunnelManager.enabled) return reply.code(403).send({ error: "remote access disabled" });
    tunnelManager.stop();
    return tunnelManager.view();
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

    // Send the current presence roster so a fresh client sees who else is on.
    try {
      socket.send(JSON.stringify({ type: "presence", clients: hub.presenceList() }));
    } catch { /* client gone */ }

    // Relay client frames: terminal input to the PTY, and the `hello` device
    // handshake that registers this socket in the presence roster.
    socket.on("message", (raw) => {
      let msg: { type?: string; event?: string; data?: unknown; clientId?: unknown; label?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch { return; /* ignore malformed frames */ }
      if (msg?.type === "hello" && typeof msg.clientId === "string") {
        hub.register(socket, { clientId: msg.clientId, label: String(msg.label ?? "") });
        return;
      }
      if (!ptyManager.enabled) return;
      if (msg?.type === "terminal" && msg.event === "input" && typeof msg.data === "string") {
        ptyManager.write(msg.data);
      }
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
  await app.register(fastifyStatic, {
    root: STATIC_DIR,
    setHeaders: (res, path) => {
      // The entry point and the service worker must always revalidate, otherwise
      // a rebuilt panel keeps serving stale (the old SW/HTML references old asset
      // hashes). Hashed assets under /assets are content-addressed, so cache them
      // hard. Path separators differ per-OS, so match both.
      if (/\.(html)$/.test(path) || /(^|[\\/])(sw\.js|manifest\.webmanifest)$/.test(path)) {
        res.setHeader("cache-control", "no-cache");
      } else if (/[\\/]assets[\\/]/.test(path)) {
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
      }
    },
  });
  // SPA fallback so client-side routing survives a refresh.
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      await reply.code(404).send({ error: "not found" });
      return;
    }
    await reply.sendFile("index.html");
  });
}
