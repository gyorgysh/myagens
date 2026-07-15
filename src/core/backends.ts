import { runTurn as claudeAgentSdkRunTurn, type RunOptions, type RunResult } from "../claude/runner.js";
import { runTurn as tmuxRunTurn } from "../claude/tmuxRunner.js";
import { runTurn as grokRunTurn } from "../grok/runner.js";
import { runTurn as codexRunTurn } from "../codex/runner.js";
import { runTurn as ollamaRunTurn } from "../ollama/runner.js";
import { runTurn as agyRunTurn } from "../agy/runner.js";
import { runWithStallGuard } from "./stallGuard.js";

/**
 * One agent runtime this bot can drive a turn through — the Claude Agent SDK
 * (spawns the `claude` CLI), the Grok CLI (spawns `grok`), the Codex CLI
 * (spawns `codex`), or Google's Antigravity CLI (spawns `agy`), each wrapping
 * a provider's own agentic CLI product (tool belt, sandboxing, permission
 * modes included) rather than reimplementing one.
 * Every caller below already goes through this registry rather than importing
 * a runner's `runTurn` directly.
 */
export interface AgentBackend {
  id: string;
  displayName: string;
  /** Derived-only backends (never user-selected): hidden from listBackends(),
   *  so they can't appear in the panel/`/model` backend pickers or be stored
   *  as a backendId — a resolver routes to them per turn instead. */
  hidden?: boolean;
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

const AGY_CLI: AgentBackend = guarded({
  id: "agy-cli",
  displayName: "Antigravity (agy)",
  runTurn: agyRunTurn,
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

// Persistent tmux-hosted `claude` TUI ("Tmux mode"): the agent's interactive
// conversation lives in a named tmux session that survives restarts and is
// attachable from any terminal / the panel / (with RC on) the Claude app.
// Runs bypassPermissions-only with no MCP tools or usage data (see
// src/claude/tmuxInstance.ts). Hidden: derived per turn from the per-agent
// `tmuxMode` flag by the resolvers, never stored as a backendId.
const CLAUDE_TMUX: AgentBackend = guarded({
  id: "claude-tmux",
  displayName: "Claude (persistent tmux)",
  hidden: true,
  runTurn: tmuxRunTurn,
});

const backends = new Map<string, AgentBackend>([
  [CLAUDE_AGENT_SDK.id, CLAUDE_AGENT_SDK],
  [CLAUDE_TMUX.id, CLAUDE_TMUX],
  [GROK_CLI.id, GROK_CLI],
  [CODEX_CLI.id, CODEX_CLI],
  [AGY_CLI.id, AGY_CLI],
  [OLLAMA.id, OLLAMA],
]);

/** Look up a backend by id, falling back to the default (Claude Agent SDK)
 *  when the id is unset or doesn't match a registered backend. */
export function getBackend(id?: string): AgentBackend {
  return (id && backends.get(id)) || CLAUDE_AGENT_SDK;
}

/** Every user-selectable backend (feeds the panel/`/model` backend pickers). */
export function listBackends(): AgentBackend[] {
  return [...backends.values()].filter((b) => !b.hidden);
}
