import type { RunOptions, RunResult } from "./runner.js";
import { runTurnOnInstance } from "./tmuxInstance.js";

/**
 * "claude-tmux" backend: one turn on the agent's persistent tmux-hosted TUI
 * instance (see src/claude/tmuxInstance.ts for the full contract and
 * tradeoffs). Never selected via a stored backendId — the resolvers in
 * mainSettings.ts / workers.ts derive it per interactive turn from the
 * per-agent `tmuxMode` flag, and attach the `opts.tmux` spec this requires.
 */
export async function runTurn(opts: RunOptions): Promise<RunResult> {
  if (!opts.tmux) {
    return {
      isError: true,
      text: "claude-tmux backend invoked without a tmux run spec (internal routing bug)",
    };
  }
  return runTurnOnInstance(opts.tmux, opts);
}
