import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { getProvider, listProviders } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { audit } from "./audit.js";
import { loadProbeResult } from "./usageProbe.js";
import { listBackends } from "./backends.js";
import { log } from "../logger.js";
import type { Autonomy } from "../session/manager.js";

const FILE = "mainAgent.json";

/** The main bot's resolved @username (from getMe), captured at startup. Transient
 *  runtime state, not persisted: it's an identity of the running process, not a
 *  user setting. Exposed in the panel view so Crew can show Atlas's t.me link. */
let botUsername: string | undefined;
export function setMainBotUsername(username: string): void {
  botUsername = username || undefined;
}

/** Runtime overrides for the *main* bot agent (the one driving chats). Empty
 *  fields fall back to CLAUDE_MODEL / the process env (.env) respectively. */
interface MainSettings {
  /** Model id override; "" = use CLAUDE_MODEL. */
  model?: string;
  /** Provider for a local/proxy endpoint; "" = Anthropic via process env. */
  providerId?: string;
  /** Agent backend id (see core/backends.ts); "" / unset = the default Claude
   *  Agent SDK backend. A hidden/advanced option — set via /model <backendId>
   *  or the panel API, not surfaced as a headline UI choice. */
  backendId?: string;
  /**
   * Character and tone override for Atlas. If set, injected into the system
   * prompt after the base personality block. Separate from systemPrompt (domain
   * knowledge). Example: "formal and precise, no jokes".
   */
  persona?: string;
  /**
   * Default autonomy level for Atlas.
   * supervised = all tools prompt the user.
   * standard   = safe tools auto-allowed, risky tools prompt (default).
   * full       = bypass all permissions.
   */
  autonomy?: Autonomy;
  /**
   * BCP 47 language tag for Atlas's default response language.
   * Per-session /lang overrides this. Falls back to DEFAULT_LANGUAGE env var.
   */
  defaultLanguage?: string;
  /**
   * Global dry-run: when true, mutating tools (Bash/Write/Edit/NotebookEdit) are
   * not executed — the gate returns a synthetic "would have…" result so the
   * model can narrate intended actions without touching the host. Affects every
   * interactive turn (forces the permission gate on even in full autonomy).
   */
  dryRun?: boolean;
  /**
   * Provider to fail over to when the Anthropic plan is rate-limited. When set,
   * autonomous/background turns (schedules, delegated tasks, heartbeat) switch to
   * this provider while usage is over `fallbackThreshold`, then switch back once
   * the limit resets. "" / undefined = no fallback. Typically a local model.
   */
  fallbackProviderId?: string;
  /** Optional model id to use on the fallback provider ("" = the provider default). */
  fallbackModel?: string;
  /** Usage percent (any window) at/above which fallback engages (default 95). */
  fallbackThreshold?: number;
  /**
   * Named directory shortcuts injected into the system prompt so the agent
   * knows where key folders are without the user repeating it. Each entry is
   * a { label, path } pair, e.g. { label: "Projects", path: "/Users/me/dev" }.
   */
  knownPaths?: Array<{ label: string; path: string }>;
}

/** Mutating tools intercepted by dry-run (echoed, not executed). */
export const DRY_RUN_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

/** Whether global dry-run mode is currently on. */
export function isDryRun(): boolean {
  return load().dryRun === true;
}

/** A short human description of what a mutating tool *would* have done. */
export function dryRunDescription(toolName: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  switch (toolName) {
    case "Bash":
      return `run command: ${s(input.command).slice(0, 400)}`;
    case "Write":
      return `write file ${s(input.file_path)} (${s(input.content).length} chars)`;
    case "Edit":
    case "MultiEdit":
      return `edit file ${s(input.file_path)}`;
    case "NotebookEdit":
      return `edit notebook ${s(input.notebook_path)}`;
    default:
      return `run ${toolName}`;
  }
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
    backendId: s.backendId ?? "",
    backends: listBackends().map((b) => ({ id: b.id, displayName: b.displayName })),
    persona: s.persona ?? "",
    autonomy: s.autonomy ?? "standard",
    defaultLanguage: s.defaultLanguage ?? config.DEFAULT_LANGUAGE,
    dryRun: s.dryRun === true,
    fallbackProviderId: s.fallbackProviderId ?? "",
    fallbackModel: s.fallbackModel ?? "",
    fallbackThreshold: s.fallbackThreshold ?? DEFAULT_FALLBACK_THRESHOLD,
    degraded: degradedState(),
    botUsername: botUsername ?? "",
    knownPaths: s.knownPaths ?? [],
  };
}

export function setMainSettings(patch: {
  model?: string;
  providerId?: string;
  backendId?: string;
  persona?: string;
  autonomy?: Autonomy;
  defaultLanguage?: string;
  dryRun?: boolean;
  fallbackProviderId?: string;
  fallbackModel?: string;
  fallbackThreshold?: number;
  knownPaths?: Array<{ label: string; path: string }>;
}): void {
  const s = load();
  if (patch.model !== undefined) s.model = patch.model.trim() || undefined;
  if (patch.providerId !== undefined) s.providerId = patch.providerId || undefined;
  if (patch.backendId !== undefined) s.backendId = patch.backendId || undefined;
  if (patch.persona !== undefined) s.persona = patch.persona.trim() || undefined;
  if (patch.autonomy !== undefined) s.autonomy = patch.autonomy || undefined;
  if (patch.defaultLanguage !== undefined) s.defaultLanguage = patch.defaultLanguage || undefined;
  if (patch.dryRun !== undefined) s.dryRun = patch.dryRun || undefined;
  if (patch.fallbackProviderId !== undefined)
    s.fallbackProviderId = patch.fallbackProviderId || undefined;
  if (patch.fallbackModel !== undefined) s.fallbackModel = patch.fallbackModel.trim() || undefined;
  if (patch.fallbackThreshold !== undefined) {
    const n = Math.round(patch.fallbackThreshold);
    s.fallbackThreshold = Number.isFinite(n) ? Math.min(100, Math.max(50, n)) : undefined;
  }
  if (patch.knownPaths !== undefined) {
    // Sanitise: keep only entries with non-empty label and path.
    const clean = patch.knownPaths
      .map((e) => ({ label: e.label.trim(), path: e.path.trim() }))
      .filter((e) => e.label && e.path);
    s.knownPaths = clean.length ? clean : undefined;
  }
  saveJson<MainFile>(FILE, { version: 1, settings: s });
  audit("mainAgent.update", {
    model: s.model,
    providerId: s.providerId,
    backendId: s.backendId,
    dryRun: s.dryRun,
    fallbackProviderId: s.fallbackProviderId,
  });
}

/** Per-turn overrides for a main (bot) turn: model + provider env + persona, if set.
 *  Mirrors how workers resolve a provider, so main turns can run on a local
 *  model too. Returns empty object when nothing is overridden. */
export function resolveMainRun(): {
  model?: string;
  env?: Record<string, string | undefined>;
  backendId?: string;
  persona?: string;
  autonomy: Autonomy;
  defaultLanguage?: string;
  knownPaths?: Array<{ label: string; path: string }>;
} {
  const s = load();
  const provider = s.providerId ? getProvider(s.providerId) : undefined;
  const env = provider
    ? {
        ANTHROPIC_BASE_URL: provider.baseUrl,
        ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
        ANTHROPIC_API_KEY: undefined,
      }
    : undefined;
  return {
    model: s.model || undefined,
    env,
    backendId: s.backendId || undefined,
    persona: s.persona || undefined,
    autonomy: s.autonomy ?? "standard",
    defaultLanguage: s.defaultLanguage || undefined,
    knownPaths: s.knownPaths?.length ? s.knownPaths : undefined,
  };
}

// ---------------------------------------------------------------------------
// Rate-limit auto-fallback
// ---------------------------------------------------------------------------

/** Default usage-percent threshold at which fallback engages. */
const DEFAULT_FALLBACK_THRESHOLD = 95;

/** Transient flag: whether the last autonomous resolve actually fell back. Drives
 *  the panel "degraded mode" banner. Not persisted (it's a live runtime state). */
let degraded: { active: boolean; since?: string; reason?: string; provider?: string } = {
  active: false,
};

/** Current degraded-mode state (for the panel banner / status command). */
export function degradedState(): { active: boolean; since?: string; reason?: string; provider?: string } {
  return degraded;
}

/** True if the cached usage probe shows any window at/above `threshold` percent. */
function overUsageLimit(threshold: number): { over: boolean; label?: string; percent?: number } {
  const probe = loadProbeResult();
  if (!probe || !probe.limits.length) return { over: false };
  let worst: { label: string; percent: number } | undefined;
  for (const lim of probe.limits) {
    if (lim.percent >= threshold && (!worst || lim.percent > worst.percent)) {
      worst = { label: lim.label, percent: lim.percent };
    }
  }
  return worst ? { over: true, label: worst.label, percent: worst.percent } : { over: false };
}

/**
 * Resolve a main run, honouring rate-limit auto-fallback for autonomous turns.
 * When `autonomous` and a fallback provider is configured and the cached usage
 * probe shows we're at/over the threshold, swap to the fallback provider/model
 * (typically a local model) so background work keeps running; otherwise this is
 * exactly `resolveMainRun()`. Updates the degraded-mode flag as a side effect.
 */
export function resolveMainRunFor(opts: { autonomous: boolean }): ReturnType<typeof resolveMainRun> {
  const base = resolveMainRun();
  const s = load();
  // Only autonomous turns fail over, and only when a fallback provider is set.
  // Interactive turns never change degraded state (it tracks background work).
  if (!opts.autonomous || !s.fallbackProviderId) return base;
  const threshold = s.fallbackThreshold ?? DEFAULT_FALLBACK_THRESHOLD;
  const { over, label, percent } = overUsageLimit(threshold);
  if (!over) {
    if (degraded.active) {
      log.info("Rate-limit fallback cleared — back on primary model");
      degraded = { active: false };
    }
    return base;
  }
  const provider = getProvider(s.fallbackProviderId);
  if (!provider) {
    log.warn("Fallback provider configured but not found", { id: s.fallbackProviderId });
    return base;
  }
  if (!degraded.active) {
    log.warn("Rate-limit fallback engaged — switching to fallback provider", {
      provider: provider.name,
      limit: label,
      percent,
    });
  }
  degraded = {
    active: true,
    since: degraded.since ?? new Date().toISOString(),
    reason: label ? `${label} at ${percent}%` : "rate limit",
    provider: provider.name,
  };
  return {
    model: s.fallbackModel || base.model,
    env: {
      ANTHROPIC_BASE_URL: provider.baseUrl,
      ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
      ANTHROPIC_API_KEY: undefined,
    },
    // Rate-limit fallback only ever repoints the Claude Agent SDK at a
    // different Anthropic-shaped endpoint — it doesn't switch backend.
    backendId: base.backendId,
    persona: base.persona,
    autonomy: base.autonomy,
    defaultLanguage: base.defaultLanguage,
  };
}
