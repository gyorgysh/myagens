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

async function main(): Promise<void> {
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

  const me = await bot.telegram.getMe();
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

  await bot.telegram.setMyCommands([
    { command: "new", description: "Start a fresh conversation" },
    { command: "cd", description: "Change working directory" },
    { command: "pwd", description: "Show current directory" },
    { command: "status", description: "Show session info" },
    { command: "projects", description: "Saved working dirs, switch between them" },
    { command: "diff", description: "Review changes, commit or discard" },
    { command: "commit", description: "Stage all changes and commit" },
    { command: "usage", description: "Show cost & activity" },
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
  ]);

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    log.info(`${signal} — shutting down`);

    // Stop accepting new turns and new scheduled work.
    schedules.stop();
    heartbeat.stop();
    maintenance.stop();
    stopProbeScheduler();

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
      setTimeout(() => { process.exit(0); }, 500);
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

  log.info("Bot starting (long polling)…");
  // launch() resolves only once polling stops; log just before it begins.
  void bot
    .launch(() => log.info("Bot is listening for updates"))
    .catch((err) => {
      log.error("Polling stopped", { error: errText(err) });
      process.exit(1);
    });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  log.error("Fatal during startup", { error: errText(err) });
  process.exit(1);
});
