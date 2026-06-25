import { config, allowedUserIds } from "./config.js";
import { buildBot } from "./bot.js";
import { sessions } from "./session/manager.js";
import { schedules } from "./schedule/manager.js";
import { heartbeat } from "./core/heartbeat.js";
import { maintenance } from "./core/maintenance.js";
import { startProbeScheduler, stopProbeScheduler } from "./core/usageProbe.js";
import { getPlanSettings } from "./core/planSettings.js";
import { startPanel } from "./panel/server.js";
import { workers } from "./core/workers.js";
import { LeadBot } from "./telegram/leadBot.js";
import { log } from "./logger.js";
import { registerIdleGate, whenSettled } from "./core/activity.js";

async function main(): Promise<void> {
  if (config.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
  }

  const bot = buildBot();

  // A chat turn stays session.busy through its post-stream tail (quote/summary
  // edits + reflect/memory pass), which outlives the activity counter. Register
  // it as an idle gate so self-update restarts and shutdown drain wait for the
  // whole turn, not just the SDK stream.
  registerIdleGate(() => sessions.all().some((s) => s.busy));

  // Start lead bots for any Lead worker with a telegramToken.
  const leadBots: LeadBot[] = workers.leads().map((w) => new LeadBot(w));
  await Promise.all(leadBots.map((lb) => lb.start()));

  // Optional embedded management panel (off unless PANEL_ENABLED=true).
  const stopPanel = await startPanel();

  maintenance.start();
  startProbeScheduler(getPlanSettings().probeIntervalMs);

  const me = await bot.telegram.getMe();
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
      log.info("All turns finished — waiting 10 s before exit");
      setTimeout(() => {
        log.info("Flushing and exiting");
        sessions.flush();
        void stopPanel?.();
        bot.stop(signal);
        for (const lb of leadBots) lb.stop(signal);
        // Short backstop in case bot.stop() stalls.
        setTimeout(() => { log.info("Forcing exit"); process.exit(0); }, 3000).unref();
      }, 10_000).unref();
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
