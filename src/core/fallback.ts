/**
 * Error-driven model failover.
 *
 * The threshold fallback in core/mainSettings.ts (resolveMainRunFor) is
 * proactive: it swaps to a fallback target *before* a turn when the cached usage
 * probe shows the plan is near its limit, and only for autonomous turns. This
 * module is the reactive counterpart: it wraps a single turn and, if that turn
 * fails with a usage/rate-limit error (which an interactive turn can hit
 * mid-flight without any probe warning), retries once on a configured fallback
 * target (a different provider endpoint and/or a different agent backend).
 *
 * One retry only. A second failure propagates so the caller's normal error
 * handling reports it.
 */
import { getBackend } from "./backends.js";
import { getProvider } from "./providers.js";
import { resolveSecret } from "./vault.js";
import { log } from "../logger.js";
import type { RunOptions, RunResult } from "../claude/runner.js";

/**
 * True when `err` looks like a usage/rate-limit / capacity error that a
 * different model or endpoint could get past. Deliberately does NOT match auth
 * failures (a fallback wouldn't fix a bad key), the stall watchdog, or an abort
 * (the turn hung or was cancelled, not rate-limited), so those propagate as-is.
 * Regexes mirror friendlyError() in telegram/errors.ts.
 */
export function isUsageLimitError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();
  // A stall-watchdog abort or a user/abort stop is never a usage limit — never
  // fail those over.
  if (/stall watchdog|abort/.test(low)) return false;
  return (
    /\b429\b|rate.?limit/.test(low) ||
    /\b529\b|overloaded/.test(low) ||
    /credit balance|insufficient|out of credit|quota|usage limit|limit reached|too low|daily.*limit|weekly.*limit|limit.*exceeded|reached.*limit/.test(
      low,
    )
  );
}

/** A target to fail a turn over to: a different backend and/or provider/model. */
export interface FallbackSpec {
  /** Agent backend id (core/backends.ts). Unset = keep the primary backend. */
  backendId?: string;
  /** Provider endpoint (Claude backend only). Unset = ambient Anthropic env. */
  providerId?: string;
  /** Model id on the fallback target. Unset = the target's default. */
  model?: string;
}

/**
 * Run one turn on `primaryBackendId`, and if it fails with a usage-limit error
 * and a usable `spec` is configured, retry once on the fallback target.
 *
 * On failover:
 *  - backend = spec.backendId || the primary backend;
 *  - when the backend changes, the resume token is dropped (a resume handle is
 *    meaningless on a different backend's CLI), so the retry starts fresh;
 *  - model = spec.model, or the original model only when the backend is unchanged;
 *  - provider env is applied only when the fallback backend is the Claude one
 *    (providers repoint the Claude Agent SDK; other backends manage their own
 *    auth), and only when spec.providerId is set;
 *  - `onFallback(label)` is called with a human label (backend name, or provider
 *    name plus model) *before* the retry, so the caller can notify the user.
 */
export async function runTurnWithFallback(
  primaryBackendId: string | undefined,
  opts: RunOptions,
  spec: FallbackSpec | undefined,
  onFallback?: (label: string) => void,
): Promise<RunResult> {
  try {
    return await getBackend(primaryBackendId).runTurn(opts);
  } catch (err) {
    // No fallback target, or it's not a usage-limit error → let it propagate.
    if (!spec || (!spec.backendId && !spec.providerId) || !isUsageLimitError(err)) throw err;

    const fallbackBackendId = spec.backendId || primaryBackendId;
    const backendChanged = (fallbackBackendId ?? undefined) !== (primaryBackendId ?? undefined);
    // Providers only apply to the Claude Agent SDK backend.
    const fallbackIsClaude = !spec.backendId || spec.backendId === "claude-agent-sdk";
    const provider = spec.providerId && fallbackIsClaude ? getProvider(spec.providerId) : undefined;
    const env = provider
      ? {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
          ANTHROPIC_API_KEY: undefined,
        }
      : undefined;

    const fallbackOpts: RunOptions = {
      ...opts,
      // A resume token is a conversation handle for the primary backend's CLI —
      // it means nothing to a different backend, so start a fresh conversation.
      resume: backendChanged ? undefined : opts.resume,
      // Don't inherit the primary's (Claude) model id onto a switched backend.
      model: spec.model || (backendChanged ? undefined : opts.model),
      env,
    };

    // Human label for the notice: prefer the switched-backend display name, else
    // the provider name, adding the model when set.
    let label: string;
    if (spec.backendId && backendChanged) {
      label = getBackend(fallbackBackendId).displayName;
      if (spec.model) label += ` (${spec.model})`;
    } else if (provider) {
      label = provider.name + (spec.model ? ` (${spec.model})` : "");
    } else {
      label = spec.model || getBackend(fallbackBackendId).displayName;
    }

    log.warn("Usage limit on primary model — failing over once", {
      primaryBackendId,
      fallbackBackendId,
      provider: provider?.name,
      model: spec.model,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    onFallback?.(label);
    // One retry only — a second failure propagates to the caller.
    return await getBackend(fallbackBackendId).runTurn(fallbackOpts);
  }
}
