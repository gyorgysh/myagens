import { runTurn as claudeAgentSdkRunTurn, type RunOptions, type RunResult } from "../claude/runner.js";
import { runTurn as grokRunTurn } from "../grok/runner.js";
import { runTurn as codexRunTurn } from "../codex/runner.js";
import { runTurn as ollamaRunTurn } from "../ollama/runner.js";
import { runWithStallGuard } from "./stallGuard.js";

/**
 * One agent runtime this bot can drive a turn through — the Claude Agent SDK
 * (spawns the `claude` CLI), the Grok CLI (spawns `grok`), or the Codex CLI
 * (spawns `codex`), each wrapping a provider's own agentic CLI product (tool
 * belt, sandboxing, permission modes included) rather than reimplementing one.
 * Every caller below already goes through this registry rather than importing
 * a runner's `runTurn` directly.
 */
export interface AgentBackend {
  id: string;
  displayName: string;
  runTurn(opts: RunOptions): Promise<RunResult>;
}

/** Wrap a backend's runTurn in the turn stall watchdog (core/stallGuard.ts),
 *  so every call site gets stuck-turn protection without per-site wiring. */
function guarded(backend: AgentBackend): AgentBackend {
  return { ...backend, runTurn: (opts) => runWithStallGuard(backend.id, backend.runTurn, opts) };
}

const CLAUDE_AGENT_SDK: AgentBackend = guarded({
  id: "claude-agent-sdk",
  displayName: "Claude (Agent SDK)",
  runTurn: claudeAgentSdkRunTurn,
});

const GROK_CLI: AgentBackend = guarded({
  id: "grok-cli",
  displayName: "Grok (CLI)",
  runTurn: grokRunTurn,
});

const CODEX_CLI: AgentBackend = guarded({
  id: "codex-cli",
  displayName: "Codex (CLI)",
  runTurn: codexRunTurn,
});

// Plain chat against a local Ollama server, NOT an agentic CLI like the three
// above. It exists so an agent can run fast and fully Anthropic-independent on a
// small local model that could never prefill the Claude CLI's ~30k-token system
// prompt; see src/ollama/runner.ts.
const OLLAMA: AgentBackend = guarded({
  id: "ollama",
  displayName: "Ollama (local chat)",
  runTurn: ollamaRunTurn,
});

const backends = new Map<string, AgentBackend>([
  [CLAUDE_AGENT_SDK.id, CLAUDE_AGENT_SDK],
  [GROK_CLI.id, GROK_CLI],
  [CODEX_CLI.id, CODEX_CLI],
  [OLLAMA.id, OLLAMA],
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
