/**
 * Entry point. Chooses between the real app and first-run setup mode.
 *
 * A fresh install has no TELEGRAM_BOT_TOKEN / ALLOWED_USER_IDS yet; instead of
 * exiting with a printed config error (which only helps terminal users), boot a
 * loopback-only browser wizard that collects and validates the required values,
 * writes .env, and hands off to the real app. Both branches are dynamic imports
 * on purpose: app.ts pulls in config.ts, whose module-load parse process.exit(1)s
 * on invalid config, so the decision must happen before that module is evaluated.
 *
 * MYAGENS_SETUP=off restores the old fail-fast behaviour (CI, headless installs
 * that prefer the printed issue list).
 */
import { config as loadEnv } from "dotenv";

const loadedEnv = loadEnv();
sanitizeAnthropicEnv(loadedEnv.parsed ?? {});

// Placeholder from .env.example — a copied-but-unedited file still needs setup.
const EXAMPLE_TOKEN = "123456:ABC-your-token-here";

/**
 * Guard against an ambient local-model config hijacking the agent's auth.
 *
 * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN set in the OS or shell environment
 * (a common leftover from pointing other Claude Code-compatible tools at a local
 * LM Studio / Ollama endpoint — e.g. ANTHROPIC_AUTH_TOKEN=lmstudio) are inherited
 * by the Claude CLI we spawn and silently override the real Anthropic login. The
 * CLI then exits 1 with no output on every turn — the classic Windows "process
 * exited with code 1" failure. MyAgens never reads these two globally: it points
 * a turn at a local/proxy endpoint only via a provider preset, which sets them
 * per-turn (src/core/providers.ts → RunOptions.env). So a top-level value is only
 * legitimate when the user put it in .env deliberately; anything inherited from
 * the surrounding environment is stripped here before any turn can see it.
 */
function sanitizeAnthropicEnv(dotenvKeys: Record<string, string>): void {
  for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
    // Present in the process env but NOT declared in .env → it came from the
    // ambient OS/shell environment, not a deliberate MyAgens config.
    if (process.env[key] && !(key in dotenvKeys)) {
      const shown = key === "ANTHROPIC_AUTH_TOKEN" ? "<redacted>" : process.env[key];
      console.warn(
        `[myagens] Ignoring ambient ${key}=${shown} inherited from the environment — ` +
          `it would override your Anthropic auth and break every turn. To proxy MyAgens ` +
          `deliberately, set it in .env or use a provider preset; otherwise remove it from ` +
          `your OS/shell environment. Diagnose with: npm run doctor`,
      );
      delete process.env[key];
    }
  }
}

function needsSetup(): boolean {
  if (process.env.MYAGENS_SETUP === "off") return false;
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token || token === EXAMPLE_TOKEN) return true;
  const ids = (process.env.ALLOWED_USER_IDS ?? "").trim();
  const hasValidId = ids
    .split(",")
    .map((x) => Number(x.trim()))
    .some((n) => Number.isInteger(n) && n > 0);
  return !hasValidId;
}

if (needsSetup()) {
  const { startSetupServer } = await import("./setup/server.js");
  await startSetupServer();
} else {
  await import("./app.js");
}
