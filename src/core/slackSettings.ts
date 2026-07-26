import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { vault, resolveSecret, secretRef, isSecretRef } from "./vault.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";
import { isSlackUserId } from "./slackSetup.js";

export { isSlackUserId };

const FILE = "slackSettings.json";

/**
 * Panel overrides for the Slack chat surface. Every field falls back to the
 * matching .env var (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
 * `SLACK_ALLOWED_USER_IDS`), so a deployment that configured Slack the old way
 * keeps working untouched and never has to migrate.
 *
 * Tokens set from the panel are stored as `vault:<id>` references, not in this
 * file. The two Slack tokens are host-access credentials, and the vault is
 * where those live. Tokens that came from .env stay in .env.
 */
interface SlackSettings {
  /** `vault:<id>` ref for the bot token (xoxb-…). */
  botTokenRef?: string;
  /** `vault:<id>` ref for the app-level token (xapp-…). */
  appTokenRef?: string;
  /** Slack member ids allowed to talk to the bot. Replaces the env list when set. */
  allowedUserIds?: string[];
  /** Set false to keep the credentials but not start the surface. */
  enabled?: boolean;
}

interface SlackFile {
  version: 1;
  settings: SlackSettings;
}

function load(): SlackSettings {
  return loadJson<SlackFile>(FILE, { version: 1, settings: {} }).settings;
}

function save(settings: SlackSettings): void {
  saveJson<SlackFile>(FILE, { version: 1, settings });
}

/** The values the Slack surface actually runs on: panel settings over .env. */
export interface ResolvedSlackConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: Set<string>;
  /** True when all three are present and the surface is not switched off. */
  configured: boolean;
}

export function resolveSlackConfig(): ResolvedSlackConfig {
  const s = load();
  const botToken = s.botTokenRef ? resolveSecret(s.botTokenRef) : (config.SLACK_BOT_TOKEN ?? "");
  const appToken = s.appTokenRef ? resolveSecret(s.appTokenRef) : (config.SLACK_APP_TOKEN ?? "");
  const ids = s.allowedUserIds?.length ? s.allowedUserIds : (config.SLACK_ALLOWED_USER_IDS ?? []);
  const allowedUserIds = new Set(ids.filter(Boolean));
  return {
    botToken,
    appToken,
    allowedUserIds,
    configured:
      s.enabled !== false && Boolean(botToken) && Boolean(appToken) && allowedUserIds.size > 0,
  };
}

/** Panel-facing view. Never returns a token, only whether one is set. */
export function slackSettingsView() {
  const s = load();
  const resolved = resolveSlackConfig();
  return {
    hasBotToken: Boolean(resolved.botToken),
    hasAppToken: Boolean(resolved.appToken),
    /** True when the token comes from .env, which the panel cannot overwrite in place. */
    botTokenFromEnv: !s.botTokenRef && Boolean(config.SLACK_BOT_TOKEN),
    appTokenFromEnv: !s.appTokenRef && Boolean(config.SLACK_APP_TOKEN),
    allowedUserIds: [...resolved.allowedUserIds],
    allowedFromEnv: !s.allowedUserIds?.length && (config.SLACK_ALLOWED_USER_IDS ?? []).length > 0,
    enabled: s.enabled !== false,
    configured: resolved.configured,
  };
}

export interface SlackSettingsPatch {
  /** Plaintext token; stored in the vault. "" leaves the current one alone. */
  botToken?: string;
  appToken?: string;
  allowedUserIds?: string[];
  enabled?: boolean;
}

export function setSlackSettings(patch: SlackSettingsPatch): ReturnType<typeof slackSettingsView> {
  const s = load();

  if (patch.botToken) s.botTokenRef = storeToken(s.botTokenRef, "Slack bot token", patch.botToken);
  if (patch.appToken) s.appTokenRef = storeToken(s.appTokenRef, "Slack app-level token", patch.appToken);

  if (patch.allowedUserIds !== undefined) {
    const ids = [...new Set(patch.allowedUserIds.map((v) => v.trim()).filter(isSlackUserId))];
    s.allowedUserIds = ids.length ? ids : undefined;
  }
  if (patch.enabled !== undefined) s.enabled = patch.enabled;

  save(s);
  audit("slack.settings", { allowed: s.allowedUserIds?.length ?? 0, enabled: s.enabled !== false });
  log.info("Slack settings updated", {
    allowed: s.allowedUserIds?.length ?? 0,
    enabled: s.enabled !== false,
  });
  return slackSettingsView();
}

/** Write a token into the vault, reusing the existing entry when there is one. */
function storeToken(existingRef: string | undefined, name: string, value: string): string {
  const token = value.trim();
  if (isSecretRef(existingRef)) {
    const id = existingRef!.slice("vault:".length);
    if (vault.update(id, { value: token })) return existingRef!;
  }
  return secretRef(vault.create({ name, value: token }).id);
}
