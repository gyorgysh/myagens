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

loadEnv();

// Placeholder from .env.example — a copied-but-unedited file still needs setup.
const EXAMPLE_TOKEN = "123456:ABC-your-token-here";

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
