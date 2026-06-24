import { config, allowedUserIds } from "./config.js";
import { buildBot } from "./bot.js";
import { sessions } from "./session/manager.js";
import { schedules } from "./schedule/manager.js";
import { startPanel } from "./panel/server.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  if (config.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
  }

  const bot = buildBot();

  // Optional embedded management panel (off unless PANEL_ENABLED=true).
  const stopPanel = await startPanel();

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
    { command: "mode", description: "safe (approval) or auto" },
    { command: "help", description: "Show help" },
  ]);

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    log.info(`${signal} — shutting down`);

    // Abort any in-flight turns so the SDK child processes (and the stdio
    // pipes that keep the event loop alive) are released. Without this the
    // process hangs and systemd ends up SIGKILLing it after TimeoutStopSec.
    let aborted = 0;
    for (const s of sessions.all()) {
      if (s.busy && s.abort) {
        s.abort.abort();
        aborted++;
      }
    }
    if (aborted) log.info("Aborted in-flight turns on shutdown", { count: aborted });

    // Stop the scheduler and flush any debounced session/usage state before we go.
    schedules.stop();
    sessions.flush();
    void stopPanel?.();

    bot.stop(signal);

    // Backstop: if some handle still pins the loop, exit anyway rather than
    // wait for the service-manager kill. unref so this timer itself can't
    // hold the process open.
    setTimeout(() => {
      log.info("Forcing exit");
      process.exit(0);
    }, 3000).unref();
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
