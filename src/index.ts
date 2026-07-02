import { mkdirSync } from "node:fs";
import { config, allowedUserIds, regeneratedPanelToken } from "./config.js";
import { buildBot } from "./bot.js";
import { sessions } from "./session/manager.js";
import { schedules } from "./schedule/manager.js";
import { heartbeat } from "./core/heartbeat.js";
import { maintenance } from "./core/maintenance.js";
import { startProbeScheduler, stopProbeScheduler } from "./core/usageProbe.js";
import { getPlanSettings } from "./core/planSettings.js";
import { setMainBotUsername } from "./core/mainSettings.js";
import { startPanel } from "./panel/server.js";
import { tunnelManager } from "./core/tunnelManager.js";
import { workers } from "./core/workers.js";
import { memory } from "./core/memory.js";
import { embeddingsEnabled, autoProbeEmbeddings } from "./core/embeddings.js";
import { autoDetectLocalProviders } from "./core/providers.js";
import { leadBots } from "./telegram/leadBotManager.js";
import { log } from "./logger.js";
import { registerIdleGate, whenSettled } from "./core/activity.js";
import { acquireInstanceLock } from "./core/singleton.js";
import { withRetry, isTelegramAuthError } from "./core/retry.js";

async function main(): Promise<void> {
  // Last-resort safety net. This long-lived process fans work out to many
  // fire-and-forget promises (streamer flush timers, watchdogs, per-chat turns).
  // A single stray rejection would otherwise terminate the whole process under
  // Node's default unhandledRejection behaviour, taking down every chat,
  // schedule, and Lead bot. Log and keep running instead; genuine fatal startup
  // errors still reject main()'s awaited chain and exit below.
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection (kept alive)", { error: errText(reason) });
  });
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception (kept alive)", { error: errText(err) });
  });

  // Ensure the working directory exists. ~/MyAgens-Workspace is the unified
  // default across Windows, macOS, and Linux — always created on boot so
  // agents always have a valid cwd. If WORKDIR is overridden in .env the
  // user's chosen path is created instead. mkdirSync with recursive:true is
  // a no-op when the folder already exists.
  try {
    mkdirSync(config.WORKDIR, { recursive: true });
  } catch {
    // Non-fatal: permission denied or unsupported fs.
  }

  if (config.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
  }

  // Single-instance guard. On a restart (launchctl kickstart / systemd) the new
  // process can launch while the old one is still draining; without this lock
  // both run at once, so schedulers/heartbeat/lead bots/tunnel all start twice
  // (the "everything runs 3-4x" storm). This waits for the previous instance to
  // exit, then takes over — or refuses to start if it won't yield.
  const releaseLock = await acquireInstanceLock();

  const bot = buildBot();

  // Let the tunnel manager DM a freshly auto-generated Basic Auth password to the
  // owner (it fires when the relay is enabled while the user isn't on the form).
  // Wired before startPanel(), since that's where tunnelManager.start() runs.
  tunnelManager.setNotifier((text) => {
    for (const id of allowedUserIds) {
      void bot.telegram
        .sendMessage(id, text, { parse_mode: "Markdown" })
        .catch((err) => log.warn("Failed to DM remote-access password", { id, error: errText(err) }));
    }
  });

  // A chat turn stays session.busy through its post-stream tail (quote/summary
  // edits + reflect/memory pass), which outlives the activity counter. Register
  // it as an idle gate so self-update restarts and shutdown drain wait for the
  // whole turn, not just the SDK stream.
  registerIdleGate(() => sessions.all().some((s) => s.busy));

  // Start lead bots for any enabled Lead worker with a telegramToken, and keep
  // them in sync live: a Lead created/enabled/edited later comes online (or a
  // disabled/deleted one goes offline) without a restart.
  await leadBots.sync();
  workers.onChange(() => {
    void leadBots.sync();
  });
  // A Lead's long-poll can die on its own (e.g. a Telegram 409 Conflict from
  // a second getUpdates poller on the same token) without the worker registry
  // changing, so onChange() alone won't catch it — the watchdog re-syncs
  // periodically to notice and restart it.
  leadBots.startWatchdog();

  // Optional embedded management panel (off unless PANEL_ENABLED=true).
  const stopPanel = await startPanel();

  maintenance.start();
  startProbeScheduler(getPlanSettings().probeIntervalMs);

  // Auto-detect a local embedding model (Ollama / LM Studio) if the user hasn't
  // explicitly configured EMBEDDING_ENABLED. Fire-and-forget; sets the runtime
  // flag so the subsequent ensureEmbeddings() call sees the right state.
  await autoProbeEmbeddings().catch(() => {});

  // Auto-add a provider preset for any local model server (Ollama :11434, LM
  // Studio :1234) that's running and not already configured. Background, best-
  // effort — never blocks boot.
  void autoDetectLocalProviders().catch(() => {});

  // Backfill semantic embeddings for existing memories in the background (no-op
  // when embeddings are disabled). Best-effort: failures fall back to keyword search.
  if (embeddingsEnabled()) {
    void memory.ensureEmbeddings().catch((err) => {
      log.debug("Memory embedding backfill failed", { error: errText(err) });
    });
  }

  // Telegram's API occasionally blips (ECONNRESET etc.) right at boot; retry
  // transient failures a few times before treating startup as fatal. A bad
  // token (401/404) fails fast instead of wasting ~30s retrying.
  const retryTelegram = <T>(fn: () => Promise<T>, label: string) =>
    withRetry(fn, {
      attempts: 4,
      baseMs: 1000,
      maxMs: 10_000,
      shouldRetry: (err) => !isTelegramAuthError(err),
      onRetry: (err, attempt, delayMs) =>
        log.warn(`${label} failed, retrying`, {
          attempt,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        }),
    });

  const me = await retryTelegram(() => bot.telegram.getMe(), "getMe");
  // Record the main bot's @username so the panel Crew view can show Atlas's
  // t.me link (mirrors how Lead bots capture theirs via setBotUsername).
  if (me.username) setMainBotUsername(me.username);
  log.info("Configuration loaded", {
    bot: `@${me.username}`,
    allowedUsers: allowedUserIds.size,
    workdir: config.WORKDIR,
    model: config.CLAUDE_MODEL,
    streamMode: config.STREAM_MODE,
    auth: config.ANTHROPIC_API_KEY ? "api-key" : "cli-login",
  });

  await retryTelegram(() => bot.telegram.setMyCommands([
    { command: "new", description: "Start a fresh conversation" },
    { command: "cd", description: "Change working directory" },
    { command: "pwd", description: "Show current directory" },
    { command: "status", description: "Show session info" },
    { command: "ping", description: "Am I online? (and busy or idle)" },
    { command: "team", description: "Lead bots: who's online and busy" },
    { command: "projects", description: "Saved working dirs, switch between them" },
    { command: "diff", description: "Review changes, commit or discard" },
    { command: "commit", description: "Stage all changes and commit" },
    { command: "usage", description: "Show cost & activity" },
    { command: "digest", description: "Daily summary of the last 24h" },
    { command: "allowed", description: "Show always-allow rules" },
    { command: "schedule", description: "Run a prompt on a timer" },
    { command: "stop", description: "Abort the running request" },
    { command: "mode", description: "supervised | standard | full" },
    { command: "model", description: "Switch the AI model (Claude, local, providers)" },
    { command: "lang", description: "Set response language" },
    { command: "voice", description: "Toggle spoken voice replies" },
    { command: "inbox", description: "Review suggestions agents filed for you" },
    { command: "council", description: "Put an idea to a Lead council vote" },
    { command: "restore", description: "Restore code to latest GitHub commit (keeps data)" },
    { command: "help", description: "Show help" },
  ]), "setMyCommands");

  // Cleared by shutdown() so a pending polling-retry backoff can't fire
  // startPolling() again after we've already begun (or finished) exiting.
  let pollRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;

  const shutdown = (signal: "SIGINT" | "SIGTERM", opts: { exitCode?: number } = {}) => {
    // Idempotent: SIGINT/SIGTERM only fire once each (process.once below), but
    // an unrecoverable polling failure now also calls this directly, so guard
    // against a real signal arriving mid-way through that failure-triggered exit.
    if (shuttingDown) return;
    shuttingDown = true;
    if (pollRetryTimer) clearTimeout(pollRetryTimer);
    log.info(`${signal} — shutting down`);

    // Stop accepting new turns and new scheduled work.
    schedules.stop();
    heartbeat.stop();
    maintenance.stop();
    stopProbeScheduler();
    leadBots.stopWatchdog();

    // Stop the panel and Telegram polling immediately so the port is released
    // before launchd/systemd restarts the process. In-flight turns may still
    // be running — we drain those below before actually exiting.
    sessions.flush();
    void stopPanel?.();
    bot.stop(signal);
    leadBots.stopAll(signal);
    // Kill the tunnel relay child (cloudflared/ngrok). Without this it outlives
    // the process; on the next restart a fresh relay spawns with a new public URL
    // while the orphan keeps running — a major contributor to the restart storm.
    tunnelManager.kill();

    // Give in-flight turns up to 30 s to finish naturally before we abort them.
    // whenSettled() waits for the *whole* turn, not just the SDK stream: the
    // session.busy gate (registered above) keeps it busy through the post-stream
    // tail — the streamed-reply quote/summary edits and the reflect/memory pass —
    // so SIGTERM during that tail waits for it instead of killing it.
    let done = false;
    const GRACEFUL_MS = 30_000;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      releaseLock();
      log.info("All turns finished — exiting");
      // Give the panel server a moment to finish closing, then exit. This timer
      // is deliberately NOT unref'd: a lingering open handle (an orphaned relay,
      // a half-closed socket) must not be able to keep the old process alive past
      // a clean shutdown, or it overlaps with the restart-spawned new instance.
      // A nonzero code (used when this shutdown was triggered by an unrecoverable
      // polling failure, not SIGINT/SIGTERM) matters for systemd's
      // `Restart=on-failure` — exit 0 would look like an intentional stop and
      // the service would NOT come back. launchd's KeepAlive restarts either way.
      setTimeout(() => { process.exit(opts.exitCode ?? 0); }, 500);
    };

    const deadline = setTimeout(() => {
      log.info("Graceful deadline reached — aborting in-flight turns");
      let aborted = 0;
      for (const s of sessions.all()) {
        if (s.busy && s.abort) {
          s.abort.abort();
          aborted++;
        }
      }
      if (aborted) log.info("Aborted in-flight turns", { count: aborted });
      finish();
    }, GRACEFUL_MS);
    // Don't let the timer itself keep the process alive past a clean exit.
    deadline.unref();

    void whenSettled().then(finish);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  // Final safety net: release the single-instance lock on any exit path (a fatal
  // error, an unexpected process.exit), so a crashed instance never leaves a live
  // lock that blocks the next launch. No-op if the normal shutdown already ran.
  process.once("exit", () => releaseLock());

  // If the panel token was auto-healed at startup (missing or shorter than the
  // 16-char minimum), DM the new secret to every allowed user so they can log
  // back into the panel — the old one no longer works.
  if (regeneratedPanelToken) {
    const text =
      "🔐 *Panel security update*\n\n" +
      "Your `PANEL_TOKEN` was missing or too short (the panel now requires at " +
      "least 16 characters), so I generated a new strong one and saved it to " +
      "`.env`.\n\nUse this to sign in to the panel from now on:\n\n" +
      `\`${regeneratedPanelToken}\`\n\n` +
      "The previous token no longer works. Keep this secret.";
    for (const id of allowedUserIds) {
      try {
        await bot.telegram.sendMessage(id, text, { parse_mode: "Markdown" });
      } catch (err) {
        log.warn("Failed to DM regenerated panel token", { id, error: errText(err) });
      }
    }
    log.warn("Regenerated PANEL_TOKEN and notified allowed users");
  }

  // Loud warning when the panel terminal inherits the bot's full environment.
  // In that mode the shell can `env` out every secret loaded from .env
  // (TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, PANEL_TOKEN, …), so anyone with
  // panel access reads them all. Only a real risk when the terminal is actually
  // enabled. Warn to the log and DM allowed users so it can't pass unnoticed.
  if (config.PANEL_TERMINAL_ENABLED && config.PANEL_TERMINAL_INHERIT_ENV) {
    log.warn(
      "SECURITY: PANEL_TERMINAL_INHERIT_ENV=true — the panel shell inherits the full process env, " +
        "so any panel user can read every secret (TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, PANEL_TOKEN, …) " +
        "via `env`. Set PANEL_TERMINAL_INHERIT_ENV=false unless you fully trust everyone with panel access.",
    );
    const text =
      "⚠️ *Security warning*\n\n" +
      "`PANEL_TERMINAL_INHERIT_ENV=true` is set while the panel terminal is enabled.\n\n" +
      "The terminal shell inherits the bot's *full* environment, so anyone with panel " +
      "access can run `env` and read every secret loaded from `.env` " +
      "(`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `PANEL_TOKEN`, API keys, …).\n\n" +
      "Set `PANEL_TERMINAL_INHERIT_ENV=false` and restart unless you fully trust " +
      "everyone who can reach the panel.";
    for (const id of allowedUserIds) {
      try {
        await bot.telegram.sendMessage(id, text, { parse_mode: "Markdown" });
      } catch (err) {
        log.warn("Failed to DM terminal-env security warning", { id, error: errText(err) });
      }
    }
  }

  // launch() resolves cleanly when polling is stopped intentionally (our own
  // bot.stop() in shutdown() aborts the in-flight getUpdates fetch, which the
  // polling loop treats as a normal exit, not an error). It only *rejects* on
  // an unrecoverable failure — a bad token (401) or a 409 Conflict from a
  // second getUpdates poller on the same token (Telegraf already retries
  // ordinary network blips internally, forever, so those never reach here).
  // A 409 in particular is often self-resolving within seconds (the other
  // poller releasing the token), so try a few in-place relaunches with
  // backoff before paying for a full process restart.
  const POLL_RETRY_MS = [2000, 5000, 10000, 20000, 30000];
  const POLL_HEALTHY_AFTER_MS = 30_000;
  let pollAttempt = 0;

  const startPolling = () => {
    log.info(pollAttempt === 0 ? "Bot starting (long polling)…" : "Bot retrying polling…", {
      attempt: pollAttempt,
    });
    const startedAt = Date.now();
    void bot
      .launch(() => log.info("Bot is listening for updates"))
      .catch((err) => {
        if (isTelegramAuthError(err)) {
          log.error("Polling stopped — bad token, restarting process", { error: errText(err) });
          shutdown("SIGTERM", { exitCode: 1 });
          return;
        }
        // Ran long enough to count as a healthy stretch — forget past failures.
        if (Date.now() - startedAt > POLL_HEALTHY_AFTER_MS) pollAttempt = 0;
        if (pollAttempt >= POLL_RETRY_MS.length) {
          log.error("Polling kept failing — restarting whole process", {
            error: errText(err),
            attempts: pollAttempt + 1,
          });
          shutdown("SIGTERM", { exitCode: 1 });
          return;
        }
        const delayMs = POLL_RETRY_MS[pollAttempt];
        pollAttempt++;
        log.error("Polling stopped, retrying", { error: errText(err), attempt: pollAttempt, delayMs });
        pollRetryTimer = setTimeout(startPolling, delayMs);
      });
  };

  startPolling();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  log.error("Fatal during startup", { error: errText(err) });
  process.exit(1);
});
