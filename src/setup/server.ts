/**
 * First-run setup server: a loopback-only, single-use web wizard that collects
 * and validates the required configuration (bot token, owner id, Claude auth),
 * writes .env, and hands off to the real app.
 *
 * Security model — this process can execute nothing on behalf of the browser
 * beyond the setup steps themselves, but it does end up holding secrets, so:
 *  - binds 127.0.0.1 only, and rejects any request whose Host header isn't a
 *    loopback name (DNS-rebinding guard);
 *  - every /setup/api call must carry the per-boot random key from the URL the
 *    server printed/opened (constant-time compare);
 *  - one-shot: the moment setup finishes, the API surface answers 410 and the
 *    process exits (service handoff) or respawns into the real app;
 *  - secrets never appear in responses or logs (the bot token is write-only
 *    once validated; the panel token is returned exactly once, at finish).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { log } from "../logger.js";
import { repoRootFromHere } from "./paths.js";
import { writeEnvValues } from "./env.js";
import { CandidatePoller, getMe, sendMessage, TelegramError, type BotInfo, type Candidate } from "./telegram.js";
import { claudeAuthStatus, validateApiKey, SetupTokenFlow } from "./claude.js";
import { wizardHtml } from "./wizardHtml.js";

const BASE_PORT = Number(process.env.PANEL_PORT) || 8787;
const PORT_ATTEMPTS = 10;

const MODEL_CHOICES = new Set([
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
]);
const DEFAULT_MODEL = "claude-sonnet-5";

interface SetupSession {
  botToken?: string;
  botInfo?: BotInfo;
  poller?: CandidatePoller;
  confirmedUser?: Candidate;
  claudeMethod: "none" | "cli" | "apikey";
  apiKey?: string;
  finished: boolean;
}

function sha(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

function keyMatches(candidate: unknown, expected: string): boolean {
  return typeof candidate === "string" && timingSafeEqual(sha(candidate), sha(expected));
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  const bare = (hostHeader ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}

function openBrowser(url: string): void {
  if (process.env.MYAGENS_NO_BROWSER === "1") return;
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      // explorer.exe, not `start`: under the elevated installer a plain
      // ShellExecute often fails to hand off to the user's (non-elevated)
      // default browser; explorer opens the URL in the user's context.
      spawn("explorer.exe", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return; // headless box
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* the printed URL is the fallback */
  }
}

export async function startSetupServer(): Promise<void> {
  const setupKey = randomBytes(16).toString("hex");
  const session: SetupSession = { claudeMethod: "none", finished: false };
  const loginFlow = new SetupTokenFlow();
  const repoRoot = repoRootFromHere(import.meta.url);

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  // Tiny per-IP rate limit — loopback-only and key-gated already, this is just
  // a backstop against a runaway local script hammering the Telegram helpers.
  const hits = new Map<string, { count: number; resetAt: number }>();
  const rateLimited = (ip: string): boolean => {
    const now = Date.now();
    const cur = hits.get(ip);
    if (!cur || cur.resetAt < now) {
      hits.set(ip, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    cur.count++;
    return cur.count > 300;
  };

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // no-store everywhere: the wizard polls the same GET URLs across boots
    // (and across setup re-runs on the same port), and without this a browser
    // may heuristically replay an old empty response — the page then never
    // sees the detected owner even though the server has it.
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'",
    );
    if (!isLoopbackHost(req.headers.host)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (req.url.startsWith("/setup/api")) {
      if (session.finished) return reply.code(410).send({ error: "setup already completed" });
      if (rateLimited(req.ip)) return reply.code(429).send({ error: "slow down" });
      if (!keyMatches(req.headers["x-setup-key"], setupKey)) {
        return reply.code(401).send({ error: "bad or missing setup key — open the link shown in your terminal" });
      }
    }
  });

  // ---------------------------------------------------------------- state ---
  app.get("/setup/api/state", async () => ({
    bot: session.botInfo ? { username: session.botInfo.username, name: session.botInfo.firstName } : null,
    confirmedUser: session.confirmedUser
      ? { id: session.confirmedUser.id, firstName: session.confirmedUser.firstName, username: session.confirmedUser.username }
      : null,
    claudeMethod: session.claudeMethod,
    models: [...MODEL_CHOICES],
    defaultModel: DEFAULT_MODEL,
  }));

  // ------------------------------------------------------------- telegram ---
  app.post("/setup/api/telegram/token", async (req, reply) => {
    const token = String((req.body as { token?: unknown })?.token ?? "").trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return reply.code(400).send({ error: "That doesn't look like a bot token. It has the shape 123456789:AbCdEf…" });
    }
    try {
      const me = await getMe(token);
      session.poller?.stop();
      session.botToken = token;
      session.botInfo = me;
      session.confirmedUser = undefined;
      const poller = new CandidatePoller(token);
      session.poller = poller;
      poller.start();
      log.info("Setup: bot token verified — now watching for a DM to detect the owner", { bot: `@${me.username}` });
      return { ok: true, username: me.username, name: me.firstName };
    } catch (err) {
      if (err instanceof TelegramError && err.code === 401) {
        return reply.code(400).send({ error: "Telegram rejected this token. Copy it again from @BotFather — the whole line." });
      }
      return reply.code(502).send({ error: "Couldn't reach Telegram. Check your internet connection and try again." });
    }
  });

  app.get("/setup/api/telegram/candidates", async (_req, reply) => {
    if (!session.poller) return reply.code(400).send({ error: "verify the bot token first" });
    return {
      candidates: [...session.poller.candidates.values()].sort((a, b) => b.at - a.at).slice(0, 10),
      warning: session.poller.warning,
    };
  });

  app.post("/setup/api/telegram/confirm", async (req, reply) => {
    const id = Number((req.body as { userId?: unknown })?.userId);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "invalid user id" });
    if (!session.botToken) return reply.code(400).send({ error: "verify the bot token first" });
    try {
      // Delivery proof: if this succeeds, the id is real AND the bot can reach it.
      await sendMessage(
        session.botToken,
        id,
        "✅ It's you! Setup is finishing in your browser — I'll be ready to chat here in a minute.",
      );
    } catch (err) {
      const hint =
        err instanceof TelegramError && (err.code === 403 || err.code === 400)
          ? "I can't message that account yet. Open your bot in Telegram and press START first, then it appears in the list here."
          : "Telegram didn't accept the confirmation message. Try again in a moment.";
      return reply.code(400).send({ error: hint });
    }
    const known = session.poller?.candidates.get(id);
    session.confirmedUser = known ?? { id, firstName: "", at: Date.now() };
    log.info("Setup: owner confirmed", { userId: id });
    return { ok: true };
  });

  // --------------------------------------------------------------- claude ---
  app.get("/setup/api/claude/status", async () => {
    const status = await claudeAuthStatus();
    if (status.loggedIn && session.claudeMethod === "none") session.claudeMethod = "cli";
    return { ...status, method: session.claudeMethod };
  });

  app.post("/setup/api/claude/apikey", async (req, reply) => {
    const key = String((req.body as { key?: unknown })?.key ?? "").trim();
    if (!key.startsWith("sk-ant-")) {
      return reply.code(400).send({ error: "Anthropic API keys start with sk-ant-. Copy the whole key." });
    }
    const result = await validateApiKey(key);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    session.apiKey = key;
    session.claudeMethod = "apikey";
    log.info("Setup: API key validated");
    return { ok: true };
  });

  app.post("/setup/api/claude/login", async () => {
    await loginFlow.start();
    return { ok: true };
  });

  app.get("/setup/api/claude/login/status", async () => {
    // When the CLI exits cleanly, re-check auth so the wizard flips to ✓.
    let loggedIn = false;
    if (!loginFlow.state.running && loginFlow.state.exitCode === 0) {
      loggedIn = (await claudeAuthStatus()).loggedIn;
      if (loggedIn) session.claudeMethod = "cli";
    }
    return { ...loginFlow.state, loggedIn };
  });

  app.post("/setup/api/claude/login/code", async (req, reply) => {
    const code = String((req.body as { code?: unknown })?.code ?? "").trim();
    if (!code || code.length > 512) return reply.code(400).send({ error: "invalid code" });
    loginFlow.sendCode(code);
    return { ok: true };
  });

  app.post("/setup/api/claude/login/cancel", async () => {
    loginFlow.cancel();
    return { ok: true };
  });

  // --------------------------------------------------------------- finish ---
  app.post("/setup/api/finish", async (req, reply) => {
    if (!session.botToken || !session.botInfo) return reply.code(400).send({ error: "bot token not verified" });
    if (!session.confirmedUser) return reply.code(400).send({ error: "owner not confirmed" });
    // Claude must be connected here — there is no panel UI to add it later, so a
    // skipped connection would ship a bot that fails every turn. The wizard has
    // no Skip button; this guards a direct/stale POST from finishing brain-less.
    if (session.claudeMethod === "none") return reply.code(400).send({ error: "connect Claude before finishing" });
    const rawModel = String((req.body as { model?: unknown })?.model ?? DEFAULT_MODEL).trim();
    const model = MODEL_CHOICES.has(rawModel) ? rawModel : DEFAULT_MODEL;

    const panelToken = randomBytes(24).toString("base64url");
    const values: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: session.botToken,
      ALLOWED_USER_IDS: String(session.confirmedUser.id),
      CLAUDE_MODEL: model,
      PANEL_ENABLED: "true",
      PANEL_PORT: String(port),
      PANEL_TOKEN: panelToken,
    };
    if (session.claudeMethod === "apikey" && session.apiKey) values.ANTHROPIC_API_KEY = session.apiKey;
    writeEnvValues(join(repoRoot, ".env"), values);
    session.finished = true;
    log.info("Setup: configuration written, handing off", { bot: `@${session.botInfo.username}`, model });

    const panelUrl = `http://127.0.0.1:${port}/?token=${panelToken}`;
    void sendMessage(
      session.botToken,
      session.confirmedUser.id,
      `🎉 Setup complete! I'm starting up now — say hi in a minute.\n\nYour control panel (works on the computer I run on):\n${panelUrl}`,
    ).catch(() => {});

    // Respond first, then tear down: the success page needs this reply, and the
    // panel needs this port. Under an installer (MYAGENS_SETUP_HANDOFF=exit) the
    // parent script installs the service next; otherwise respawn ourselves —
    // with .env now valid, the entry point boots the real app.
    setTimeout(() => {
      session.poller?.stop();
      loginFlow.cancel();
      void app.close().then(() => {
        if (process.env.MYAGENS_SETUP_HANDOFF !== "exit") {
          const entry = process.argv[1] ?? join(repoRoot, "dist", "index.js");
          spawn(process.execPath, [entry], { detached: true, stdio: "ignore", cwd: repoRoot }).unref();
        }
        process.exit(0);
      });
    }, 750).unref();

    return { ok: true, panelPath: `/?token=${panelToken}` };
  });

  // ------------------------------------------------------------ kill sw ----
  // A previous install's panel may have registered its PWA service worker on
  // this exact origin+port; that worker serves the cached dashboard for bare
  // "/" navigations and replays cached (empty) /setup/api responses from
  // CacheFirst — and it can never self-update while setup occupies the origin,
  // because its /sw.js update check would get wizard HTML back. Serve a
  // kill-switch worker instead: it purges Cache Storage, unregisters itself,
  // and reloads any open tabs.
  const KILL_SW = [
    "self.addEventListener('install',function(){self.skipWaiting()});",
    "self.addEventListener('activate',function(e){e.waitUntil((async function(){",
    "try{var ks=await caches.keys();await Promise.all(ks.map(function(k){return caches.delete(k)}))}catch(_){}",
    "try{await self.registration.unregister()}catch(_){}",
    "try{var cs=await self.clients.matchAll({type:'window'});for(var i=0;i<cs.length;i++){try{await cs[i].navigate(cs[i].url)}catch(_){}}}catch(_){}",
    "})())});",
  ].join("\n");
  app.get("/sw.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(KILL_SW));

  // ----------------------------------------------------------------- page ---
  app.setNotFoundHandler((req, reply) => {
    // Success-page readiness polling probes /api/me; make sure it gets a JSON
    // 404 here (not the wizard HTML) so it can't mistake setup mode for the
    // live panel.
    if (req.url.startsWith("/api") || req.url.startsWith("/ws") || req.url.startsWith("/setup/api")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.type("text/html; charset=utf-8").send(wizardHtml());
  });
  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(wizardHtml()));

  let port = BASE_PORT;
  let listening = false;
  for (let i = 0; i < PORT_ATTEMPTS && !listening; i++) {
    port = BASE_PORT + i;
    try {
      await app.listen({ host: "127.0.0.1", port });
      listening = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
    }
  }
  if (!listening) {
    console.error(`Setup: no free port found (tried ${BASE_PORT}-${BASE_PORT + PORT_ATTEMPTS - 1}).`);
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}/?k=${setupKey}`;
  log.info("Setup mode: waiting for browser configuration", { port });
  console.log("\n  MyAgens isn't configured yet — finish setup in your browser:\n");
  console.log(`    ${url}\n`);
  console.log("  This link only works on this computer. Keep this window open until setup finishes.\n");
  openBrowser(url);

  const stop = () => {
    session.poller?.stop();
    loginFlow.cancel();
    // Non-zero when interrupted mid-setup so an installer waiting on this
    // process (MYAGENS_SETUP_HANDOFF=exit) reports the interruption instead of
    // carrying on to the service-install step.
    void app.close().then(() => process.exit(session.finished ? 0 : 130));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
