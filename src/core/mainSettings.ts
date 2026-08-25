import { config } from "../config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { getProvider, listProviders } from "./providers.js";
import { isSecretRef, resolveSecret, secretRef, vault } from "./vault.js";
import { audit } from "./audit.js";
import { backendLimitReading, fallbackTargetExhausted } from "./limitHeadroom.js";
import { listBackends, getBackend } from "./backends.js";
import { tmuxAvailableSync } from "../claude/tmuxInstance.js";
import type { TmuxRunSpec } from "../claude/runner.js";
import type { FallbackSpec } from "./fallback.js";
import { log } from "../logger.js";
import type { Autonomy } from "../session/manager.js";
import { sessions } from "../session/manager.js";
import { sanitizePromptExclude } from "../prompt.js";

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
   *  Agent SDK backend. Set via /model <backendId> or the panel API. */
  backendId?: string;
  /**
   * Persistent-instance ("Tmux") mode: when true, Atlas's *interactive* turns
   * (Telegram, panel chat, scheduled turns in the chat) run inside one
   * long-lived `claude` TUI hosted in a named tmux session instead of a fresh
   * SDK `query()` per turn (src/claude/tmuxInstance.ts). The session survives
   * restarts and is attachable from any terminal / the panel. Requires full
   * autonomy (the TUI is bypassPermissions-only), no backendId override, and
   * the tmux binary; otherwise turns silently stay on the SDK path. Delegated
   * cards, council votes, and other unattended one-shots always stay SDK.
   */
  tmuxMode?: boolean;
  /**
   * Claude Code Remote Control — a SUB-toggle of `tmuxMode`: when both are on,
   * the persistent instance launches with `--remote-control <name>` so the live
   * session can be watched and steered from claude.ai/code or the Claude mobile
   * app. Without tmuxMode it has no effect (RC only works in the interactive
   * TUI; it is a silent no-op in headless `-p`/SDK mode).
   */
  remoteControl?: boolean;
  /**
   * Cursor backend only: run cursor-agent as a full MyAgens agent (our MCP
   * tools plus a real Approve/Deny gate). **`undefined` means enabled** — only
   * an explicit `false` turns it off, so an existing config with no such field
   * keeps the capable path. The opt-out exists because cursor-agent reads hooks
   * and MCP config from `<cwd>/.cursor/` only, i.e. from the user's own project
   * directory (see src/cursor/customization.ts); switching it off runs the
   * plain CLI and touches nothing.
   */
  cursorTools?: boolean;
  /**
   * OpenAI API key for the Codex CLI backend (`codex-cli`), stored as a
   * `vault:<id>` reference. When set, every codex turn (Atlas and workers)
   * uses usage-based OpenAI Platform billing instead of a ChatGPT subscription
   * login. Empty/unset = fall back to `CODEX_API_KEY` in the environment, then
   * to the host's `codex login` auth.
   */
  codexApiKey?: string;
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
  /**
   * Optional agent backend to fail over to (see core/backends.ts). When set, the
   * fallback switches the whole runtime (e.g. to Grok/Codex/Ollama) rather than
   * just repointing the Claude backend at another endpoint. Engages on the same
   * threshold as `fallbackProviderId`; either or both can be set.
   */
  fallbackBackendId?: string;
  /** Optional model id to use on the fallback provider ("" = the provider default). */
  fallbackModel?: string;
  /** Usage percent (any window) at/above which fallback engages (default 95). */
  fallbackThreshold?: number;
  /**
   * When the account can keep going past the threshold on billed overage (the
   * usage probe's `extraUsageEnabled`), stay on primary Claude instead of
   * switching. Off by default: crossing the threshold always engages the
   * fallback, even if overage billing would have covered it, to avoid
   * unexpected extra charges.
   */
  fallbackAllowOverage?: boolean;
  /**
   * Named directory shortcuts injected into the system prompt so the agent
   * knows where key folders are without the user repeating it. Each entry is
   * a { label, path } pair, e.g. { label: "Projects", path: "/Users/me/dev" }.
   */
  knownPaths?: Array<{ label: string; path: string }>;
  /**
   * Opt out of the proactive "new version detected" Telegram notification
   * (src/core/updateNotify.ts). Off by default — the president is notified and
   * can Accept (runs the same rescue path as /reload) or dismiss until the next
   * version.
   */
  updateNotifyOptOut?: boolean;
  /**
   * Per-agent prompt-slimming: sections of our system-prompt append to drop for
   * Atlas (any of "workMd" | "persona" | "knownPaths" | "memory"). Slims the
   * per-turn prompt for smaller/local models. Empty/unset = nothing excluded.
   */
  promptExclude?: string[];
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
    tmuxMode: s.tmuxMode === true,
    remoteControl: s.remoteControl === true,
    // Default-on: anything but an explicit false is enabled.
    cursorTools: s.cursorTools !== false,
    fallbackProviderId: s.fallbackProviderId ?? "",
    fallbackBackendId: s.fallbackBackendId ?? "",
    fallbackModel: s.fallbackModel ?? "",
    fallbackThreshold: s.fallbackThreshold ?? DEFAULT_FALLBACK_THRESHOLD,
    fallbackAllowOverage: s.fallbackAllowOverage === true,
    degraded: degradedState(),
    botUsername: botUsername ?? "",
    knownPaths: s.knownPaths ?? [],
    updateNotifyOptOut: s.updateNotifyOptOut === true,
    promptExclude: s.promptExclude ?? [],
    // Never send the key itself: only whether one is configured, where it came
    // from, and a short hint so the panel can show "saved ••••abcd".
    ...codexApiKeyStatus(),
  };
}

/** Panel-facing Codex API key status (no plaintext). */
function codexApiKeyStatus(): {
  codexApiKeySet: boolean;
  codexApiKeyHint: string;
  /** "vault" | "env" | "" — Clear only applies to a vault-stored key. */
  codexApiKeySource: "vault" | "env" | "";
} {
  const fromVault = resolveSecret(load().codexApiKey);
  if (fromVault) {
    return {
      codexApiKeySet: true,
      codexApiKeySource: "vault",
      codexApiKeyHint: fromVault.length <= 4 ? "••••" : `••••${fromVault.slice(-4)}`,
    };
  }
  const fromEnv = config.CODEX_API_KEY?.trim() || "";
  if (fromEnv) {
    return {
      codexApiKeySet: true,
      codexApiKeySource: "env",
      codexApiKeyHint: fromEnv.length <= 4 ? "••••" : `••••${fromEnv.slice(-4)}`,
    };
  }
  return { codexApiKeySet: false, codexApiKeySource: "", codexApiKeyHint: "" };
}

/**
 * Plaintext OpenAI API key for the codex-cli backend, or "" when none is
 * configured. Order: vault-backed panel setting, then `CODEX_API_KEY` env.
 * Deliberately does NOT fall back to `OPENAI_API_KEY` (voice / other tools use
 * that, and auto-sharing would silently bill Platform usage).
 */
export function resolveCodexApiKey(): string {
  const fromSettings = resolveSecret(load().codexApiKey);
  if (fromSettings) return fromSettings;
  return config.CODEX_API_KEY?.trim() || "";
}

/** Store, update, or clear the vault-backed Codex API key on main settings. */
function applyCodexApiKey(s: MainSettings, value: string | undefined): void {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    // Clear: drop the vault entry we own (by ref) so a leftover secret does not
    // linger after the user removes the key from Settings.
    if (s.codexApiKey && isSecretRef(s.codexApiKey)) {
      const id = s.codexApiKey.slice("vault:".length);
      vault.remove(id);
    }
    s.codexApiKey = undefined;
    return;
  }
  if (s.codexApiKey && isSecretRef(s.codexApiKey)) {
    const id = s.codexApiKey.slice("vault:".length);
    if (vault.update(id, { value: trimmed })) return;
    // Ref pointed at a deleted entry: fall through and create a fresh one.
  }
  const sec = vault.create({
    name: "Codex OpenAI API key",
    value: trimmed,
    description: "Usage-based OpenAI Platform billing for the codex-cli backend",
  });
  s.codexApiKey = secretRef(sec.id);
}

export function setMainSettings(patch: {
  model?: string;
  providerId?: string;
  backendId?: string;
  persona?: string;
  autonomy?: Autonomy;
  defaultLanguage?: string;
  dryRun?: boolean;
  tmuxMode?: boolean;
  remoteControl?: boolean;
  cursorTools?: boolean;
  /**
   * Codex OpenAI API key. Non-empty string stores/updates the vault secret;
   * empty string clears it. Omit the field to leave the stored key unchanged
   * (the panel only sends it when the user typed something).
   */
  codexApiKey?: string;
  fallbackProviderId?: string;
  fallbackBackendId?: string;
  fallbackModel?: string;
  fallbackThreshold?: number;
  fallbackAllowOverage?: boolean;
  knownPaths?: Array<{ label: string; path: string }>;
  updateNotifyOptOut?: boolean;
  promptExclude?: string[];
}): void {
  const s = load();
  const prevBackend = s.backendId;
  if (patch.model !== undefined) s.model = patch.model.trim() || undefined;
  if (patch.providerId !== undefined) s.providerId = patch.providerId || undefined;
  if (patch.backendId !== undefined) s.backendId = patch.backendId || undefined;
  if (patch.persona !== undefined) s.persona = patch.persona.trim() || undefined;
  if (patch.autonomy !== undefined) s.autonomy = patch.autonomy || undefined;
  if (patch.defaultLanguage !== undefined) s.defaultLanguage = patch.defaultLanguage || undefined;
  if (patch.dryRun !== undefined) s.dryRun = patch.dryRun || undefined;
  if (patch.tmuxMode !== undefined) s.tmuxMode = patch.tmuxMode || undefined;
  if (patch.remoteControl !== undefined) s.remoteControl = patch.remoteControl || undefined;
  // Inverted on purpose: this one defaults to ON, so only a false is worth
  // storing and a true means "back to the default", i.e. no field at all.
  if (patch.cursorTools !== undefined) s.cursorTools = patch.cursorTools === false ? false : undefined;
  if (patch.codexApiKey !== undefined) applyCodexApiKey(s, patch.codexApiKey);
  if (patch.fallbackProviderId !== undefined)
    s.fallbackProviderId = patch.fallbackProviderId || undefined;
  if (patch.fallbackBackendId !== undefined)
    s.fallbackBackendId = patch.fallbackBackendId || undefined;
  if (patch.fallbackModel !== undefined) s.fallbackModel = patch.fallbackModel.trim() || undefined;
  if (patch.fallbackThreshold !== undefined) {
    const n = Math.round(patch.fallbackThreshold);
    s.fallbackThreshold = Number.isFinite(n) ? Math.min(100, Math.max(50, n)) : undefined;
  }
  if (patch.fallbackAllowOverage !== undefined)
    s.fallbackAllowOverage = patch.fallbackAllowOverage || undefined;
  if (patch.knownPaths !== undefined) {
    // Sanitise: keep only entries with non-empty label and path.
    const clean = patch.knownPaths
      .map((e) => ({ label: e.label.trim(), path: e.path.trim() }))
      .filter((e) => e.label && e.path);
    s.knownPaths = clean.length ? clean : undefined;
  }
  if (patch.updateNotifyOptOut !== undefined) s.updateNotifyOptOut = patch.updateNotifyOptOut || undefined;
  if (patch.promptExclude !== undefined) s.promptExclude = sanitizePromptExclude(patch.promptExclude);
  saveJson<MainFile>(FILE, { version: 1, settings: s });
  audit("mainAgent.update", {
    model: s.model,
    providerId: s.providerId,
    backendId: s.backendId,
    dryRun: s.dryRun,
    fallbackProviderId: s.fallbackProviderId,
    fallbackBackendId: s.fallbackBackendId,
    codexApiKeySet: Boolean(s.codexApiKey),
  });
  // A backend switch invalidates every persisted sessionId: they're resume tokens
  // for the OLD backend's CLI, so codex/grok would fail to resume a Claude UUID on
  // every subsequent turn, and only Claude's stale-session text triggers the
  // auto-recovery path. Wipe them so the next turn starts a fresh session on the
  // new backend instead of erroring until the user runs /new.
  if (patch.backendId !== undefined && (s.backendId ?? undefined) !== (prevBackend ?? undefined)) {
    const { sessions: cleared } = sessions.resetAll();
    log.info("Backend changed — reset session ids", { from: prevBackend, to: s.backendId, sessions: cleared });
  }
}

/** One warning per process when tmux mode is configured but tmux is absent. */
let warnedTmuxMissing = false;

/** Per-turn overrides for a main (bot) turn: model + provider env + persona, if set.
 *  Mirrors how workers resolve a provider, so main turns can run on a local
 *  model too. Returns empty object when nothing is overridden. Pass
 *  `interactive: true` only for turns that belong to the user's conversation
 *  (bot.ts) — that is what routes a Tmux-mode agent onto its persistent
 *  instance; unattended callers (reflect, delegated cards) omit it and always
 *  get the SDK path. */
export function resolveMainRun(opts?: { interactive?: boolean }): {
  model?: string;
  env?: Record<string, string | undefined>;
  backendId?: string;
  /** Present when this turn runs on the persistent tmux instance (claude-tmux). */
  tmux?: TmuxRunSpec;
  persona?: string;
  autonomy: Autonomy;
  defaultLanguage?: string;
  knownPaths?: Array<{ label: string; path: string }>;
  /** Per-agent prompt-slimming keys (see MainSettings.promptExclude). */
  promptExclude?: string[];
  /** Only ever false: the cursor backend's MyAgens tools were opted out of.
   *  Undefined (the usual case) leaves the default, which is on. */
  cursorTools?: boolean;
  /** True when the resolved run switched to a *different* backend than the
   *  primary via the threshold fallback below — the caller must then drop the
   *  session resume token (a resume handle is meaningless on the other backend). */
  fallbackBackendActive?: boolean;
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
  // Tmux mode: route Atlas's interactive turns through the `claude-tmux`
  // backend (persistent TUI in a named tmux session) instead of the headless
  // SDK. It runs bypassPermissions-only, so require full autonomy — never
  // silently escalate a standard-autonomy turn. Also requires no pinned
  // backendId and the tmux binary; a missing binary degrades to the SDK path
  // with one logged warning.
  const tmuxConfigured =
    opts?.interactive === true &&
    s.tmuxMode === true &&
    !s.backendId &&
    (s.autonomy ?? "standard") === "full";
  const wantsTmux = tmuxConfigured && tmuxAvailableSync();
  if (tmuxConfigured && !wantsTmux && !warnedTmuxMissing) {
    warnedTmuxMissing = true;
    log.warn(
      "tmux mode configured but tmux is not installed — falling back to SDK turns (brew install tmux / apt install tmux)",
    );
  }
  return {
    model: s.model || undefined,
    env,
    backendId: wantsTmux ? "claude-tmux" : s.backendId || undefined,
    tmux: wantsTmux
      ? { agentId: "atlas", agentName: config.ATLAS_NAME, remoteControl: s.remoteControl === true }
      : undefined,
    persona: s.persona || undefined,
    autonomy: s.autonomy ?? "standard",
    defaultLanguage: s.defaultLanguage || undefined,
    knownPaths: s.knownPaths?.length ? s.knownPaths : undefined,
    promptExclude: s.promptExclude?.length ? s.promptExclude : undefined,
    cursorTools: s.cursorTools === false ? false : undefined,
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

/**
 * Resolve a main run, honouring rate-limit auto-fallback. When a fallback target
 * is configured and the *primary backend's own* utilisation is at/over the
 * threshold, swap to the fallback provider/backend/model so the turn keeps
 * running — for autonomous/background turns and interactive chat turns (Telegram,
 * Slack) alike, no need to wait for an actual failure. Reads whichever source
 * fits that backend (core/limitHeadroom.ts): the OAuth probe for Claude, session
 * transcripts for Codex, nothing for the backends that publish nothing, which
 * therefore keep reactive failover only. A target that is itself spent is left
 * alone rather than switched into. Updates the degraded-mode flag as a side
 * effect. `runTurnWithFallback` (core/fallback.ts) remains as a reactive backstop
 * for a genuine mid-turn error this check didn't catch.
 */
export function resolveMainRunFor(opts: {
  autonomous: boolean;
  /** Belongs to the user's conversation (routes Tmux-mode agents; see resolveMainRun). */
  interactive?: boolean;
}): ReturnType<typeof resolveMainRun> {
  const base = resolveMainRun({ interactive: opts.interactive });
  const s = load();
  if (!s.fallbackProviderId && !s.fallbackBackendId) return base;
  const threshold = s.fallbackThreshold ?? DEFAULT_FALLBACK_THRESHOLD;
  // Read the *primary's* own utilisation, whichever backend that is. Claude and
  // Codex both publish it; the rest report `known: false`, which leaves this
  // path exactly where it was before — reactive failover only.
  const { over, label, percent, extraUsageEnabled } = backendLimitReading(base.backendId, threshold);
  if (!over) {
    if (degraded.active) {
      log.info("Rate-limit fallback cleared — back on primary model");
      degraded = { active: false };
    }
    return base;
  }
  // Opt-in: let the account keep going on billed overage instead of switching.
  if (s.fallbackAllowOverage && extraUsageEnabled) {
    if (degraded.active) {
      log.info("Rate-limit fallback cleared — staying on primary (overage billing allowed)");
      degraded = { active: false };
    }
    return base;
  }
  // Providers only apply to the Claude Agent SDK backend, so the fallback
  // provider env is used only when the fallback backend is Claude (unset, or the
  // switch target is itself claude-agent-sdk).
  const fallbackIsClaude = !s.fallbackBackendId || s.fallbackBackendId === "claude-agent-sdk";
  const provider = s.fallbackProviderId && fallbackIsClaude ? getProvider(s.fallbackProviderId) : undefined;
  // Nothing usable to switch to: a configured provider that's since been deleted
  // and no backend switch either. Stay on primary rather than run with no change.
  if (!provider && !s.fallbackBackendId) {
    log.warn("Fallback provider configured but not found", { id: s.fallbackProviderId });
    return base;
  }
  const engagedBackendId = s.fallbackBackendId || base.backendId;
  const backendChanged = (engagedBackendId ?? undefined) !== (base.backendId ?? undefined);
  // Switching into a backend that is itself spent just trades one limit for
  // another, and would put up a "degraded, running on X" banner for a target that
  // cannot answer either. Staying on the primary at least fails with the real
  // reason. Only a fresh reading counts, so an unused or unreadable target is
  // still attempted (see core/limitHeadroom.ts).
  if (backendChanged) {
    const target = fallbackTargetExhausted(engagedBackendId, threshold);
    if (target.exhausted) {
      log.warn("Fallback target is at its own limit — staying on primary", {
        backendId: engagedBackendId,
        limit: target.label,
        percent: target.percent,
      });
      return base;
    }
  }
  const backendName = s.fallbackBackendId ? getBackend(s.fallbackBackendId).displayName : undefined;
  // Banner label: the switched-backend display name (plus model) when a backend
  // fallback is engaged, else the provider name.
  const providerLabel = backendName
    ? backendName + (s.fallbackModel ? ` (${s.fallbackModel})` : "")
    : provider?.name;
  if (!degraded.active) {
    log.warn("Rate-limit fallback engaged — switching to fallback target", {
      backend: backendName,
      provider: provider?.name,
      limit: label,
      percent,
    });
  }
  degraded = {
    active: true,
    since: degraded.since ?? new Date().toISOString(),
    reason: label ? `${label} at ${percent}%` : "rate limit",
    provider: providerLabel,
  };
  const env = provider
    ? {
        ANTHROPIC_BASE_URL: provider.baseUrl,
        ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
        ANTHROPIC_API_KEY: undefined,
      }
    : undefined;
  return {
    // Deliberately no `tmux` here: an engaged threshold fallback always wins
    // over the tmux derivation — a degraded turn never routes to the
    // persistent instance.
    // On a backend switch, never inherit the primary (Claude) model id onto the
    // other backend — use the explicit fallbackModel or leave it unset. When the
    // backend is unchanged, fall back to the primary model as before.
    model: s.fallbackBackendId ? s.fallbackModel || undefined : s.fallbackModel || base.model,
    env,
    backendId: engagedBackendId,
    persona: base.persona,
    autonomy: base.autonomy,
    defaultLanguage: base.defaultLanguage,
    knownPaths: base.knownPaths,
    promptExclude: base.promptExclude,
    fallbackBackendActive: backendChanged,
  };
}

/**
 * The main agent's configured error-driven failover target, or undefined when
 * neither a fallback backend nor provider is set. Consumed by the interactive
 * main turn (bot.ts) to wrap its run in runTurnWithFallback (core/fallback.ts).
 */
export function mainFallbackSpec(): FallbackSpec | undefined {
  const s = load();
  if (!s.fallbackBackendId && !s.fallbackProviderId) return undefined;
  return {
    backendId: s.fallbackBackendId || undefined,
    providerId: s.fallbackProviderId || undefined,
    model: s.fallbackModel || undefined,
  };
}
