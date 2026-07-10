import { config } from "../config.js";
import { log } from "../logger.js";
import { getTaskRunConfig } from "./tasks.js";
import type { RunOptions, RunResult } from "../claude/runner.js";

/**
 * Turn-level inactivity watchdog. Every wait in the system is time-bounded
 * (approvals, asks, delegated runs, Bash) EXCEPT consuming the backend's own
 * message stream: if the spawned CLI subprocess wedges mid-turn, the runner's
 * `for await` never returns, the caller's `finally` never runs, and the chat's
 * `busy` flag stays true forever (scheduled jobs then pile up behind it). This
 * guard wraps a turn's callbacks to timestamp every sign of life — stream
 * deltas, tool announcements/results, permission-gate activity — and aborts the
 * turn via its own AbortController once the backend has been silent longer than
 * TURN_STALL_TIMEOUT_MS (0 disables).
 *
 * While a tool call is outstanding (announced, no result yet) the allowance is
 * extended by the task-run timeout: a crew_delegate/delegated child run
 * legitimately keeps the parent stream silent for up to that long, and the
 * child turn carries its *own* stall guard, so a wedged child aborts itself and
 * unblocks the parent well inside the extended window.
 *
 * Applied centrally in core/backends.ts so every backend and every call site
 * (interactive chats, Leads, panel chat, delegated/scheduled runs, council
 * votes) is covered without per-site wiring.
 */

const CHECK_EVERY_MS = 60_000;

/** True when the error came from the stall watchdog aborting a silent turn. */
export function isTurnStall(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /stall watchdog/i.test(msg);
}

export async function runWithStallGuard(
  backendId: string,
  run: (opts: RunOptions) => Promise<RunResult>,
  opts: RunOptions,
): Promise<RunResult> {
  const baseMs = config.TURN_STALL_TIMEOUT_MS;
  if (baseMs <= 0) return run(opts);

  let lastActivity = Date.now();
  let inFlightTools = 0;
  let trippedAfterMs = 0;
  const bump = () => {
    lastActivity = Date.now();
  };

  const guarded: RunOptions = {
    ...opts,
    onText: (delta) => {
      bump();
      opts.onText(delta);
    },
    onSessionId: (id) => {
      bump();
      opts.onSessionId(id);
    },
    onToolUse: (name, input) => {
      bump();
      inFlightTools++;
      opts.onToolUse(name, input);
    },
    onToolResult: (isError) => {
      bump();
      if (inFlightTools > 0) inFlightTools--;
      opts.onToolResult?.(isError);
    },
    // A pending approval is the user's wait, not a backend stall — bump on
    // entry and again when it resolves so the silence clock restarts either way.
    canUseTool: async (name, input) => {
      bump();
      try {
        return await opts.canUseTool(name, input);
      } finally {
        bump();
      }
    },
  };

  const timer = setInterval(() => {
    const silentMs = Date.now() - lastActivity;
    const { timeoutMs: delegateMs } = getTaskRunConfig();
    const limit = inFlightTools > 0 ? baseMs + (delegateMs > 0 ? delegateMs : baseMs) : baseMs;
    if (silentMs >= limit) {
      trippedAfterMs = silentMs;
      clearInterval(timer);
      log.warn("Turn stall watchdog tripped — aborting silent turn", {
        backendId,
        silentMin: Math.round(silentMs / 60_000),
        inFlightTools,
      });
      opts.abortController.abort();
    }
  }, CHECK_EVERY_MS);
  // Never keep the process alive just to watch a turn.
  timer.unref?.();

  try {
    // If the run still resolves with a result after the trip (abort raced a
    // genuine completion), the completed result wins.
    return await run(guarded);
  } catch (err) {
    if (trippedAfterMs > 0) {
      const min = Math.round(trippedAfterMs / 60_000);
      throw new Error(
        `stall watchdog: no activity from the ${backendId} backend for ${min} minutes — turn aborted so the chat is not stuck busy. Resend the message to retry (TURN_STALL_TIMEOUT_MS tunes or disables this).`,
      );
    }
    throw err;
  } finally {
    clearInterval(timer);
  }
}
