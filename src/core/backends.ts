import { runTurn as claudeAgentSdkRunTurn, type RunOptions, type RunResult } from "../claude/runner.js";
import { runTurn as grokRunTurn } from "../grok/runner.js";

/**
 * One agent runtime this bot can drive a turn through — the Claude Agent SDK
 * (spawns the `claude` CLI) or the Grok CLI (spawns `grok`), each wrapping a
 * provider's own agentic CLI product (tool belt, sandboxing, permission modes
 * included) rather than reimplementing one. Every caller below already goes
 * through this registry rather than importing a runner's `runTurn` directly.
 */
export interface AgentBackend {
  id: string;
  displayName: string;
  runTurn(opts: RunOptions): Promise<RunResult>;
}

const CLAUDE_AGENT_SDK: AgentBackend = {
  id: "claude-agent-sdk",
  displayName: "Claude (Agent SDK)",
  runTurn: claudeAgentSdkRunTurn,
};

const GROK_CLI: AgentBackend = {
  id: "grok-cli",
  displayName: "Grok (CLI)",
  runTurn: grokRunTurn,
};

const backends = new Map<string, AgentBackend>([
  [CLAUDE_AGENT_SDK.id, CLAUDE_AGENT_SDK],
  [GROK_CLI.id, GROK_CLI],
]);

/** Look up a backend by id, falling back to the default (Claude Agent SDK)
 *  when the id is unset or doesn't match a registered backend. */
export function getBackend(id?: string): AgentBackend {
  return (id && backends.get(id)) || CLAUDE_AGENT_SDK;
}

/** Every registered backend (for a future model/backend picker). */
export function listBackends(): AgentBackend[] {
  return [...backends.values()];
}
