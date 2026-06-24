import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { getProvider, listProviders } from "./providers.js";
import { audit } from "./audit.js";

const FILE = "mainAgent.json";

/** Runtime overrides for the *main* bot agent (the one driving chats). Empty
 *  fields fall back to CLAUDE_MODEL / the process env (.env) respectively. */
interface MainSettings {
  /** Model id override; "" = use CLAUDE_MODEL. */
  model?: string;
  /** Provider for a local/proxy endpoint; "" = Anthropic via process env. */
  providerId?: string;
}

interface MainFile {
  version: 1;
  settings: MainSettings;
}

function load(): MainSettings {
  return loadJson<MainFile>(FILE, { version: 1, settings: {} }).settings;
}

/** Panel-facing view: raw selection plus the effective/resolved values. */
export function mainSettingsView() {
  const s = load();
  const provider = s.providerId ? getProvider(s.providerId) : undefined;
  return {
    model: s.model ?? "",
    providerId: s.providerId ?? "",
    effectiveModel: s.model || config.CLAUDE_MODEL,
    providerName: provider?.name,
    providerBaseUrl: provider?.baseUrl,
    providers: listProviders().map((p) => ({ id: p.id, name: p.name })),
  };
}

export function setMainSettings(patch: { model?: string; providerId?: string }): void {
  const s = load();
  if (patch.model !== undefined) s.model = patch.model.trim() || undefined;
  if (patch.providerId !== undefined) s.providerId = patch.providerId || undefined;
  saveJson<MainFile>(FILE, { version: 1, settings: s });
  audit("mainAgent.update", { model: s.model, providerId: s.providerId });
}

/** Per-turn overrides for a main (bot) turn: model + provider env, if set.
 *  Mirrors how workers resolve a provider, so main turns can run on a local
 *  model too. Returns empty object when nothing is overridden. */
export function resolveMainRun(): { model?: string; env?: Record<string, string | undefined> } {
  const s = load();
  const provider = s.providerId ? getProvider(s.providerId) : undefined;
  const env = provider
    ? {
        ANTHROPIC_BASE_URL: provider.baseUrl,
        ANTHROPIC_AUTH_TOKEN: provider.authToken,
        ANTHROPIC_API_KEY: undefined,
      }
    : undefined;
  return { model: s.model || undefined, env };
}
