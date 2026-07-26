import type { RunOptions } from "../claude/runner.js";
import { createCliPromptBuilder } from "../core/cliPrompt.js";

/**
 * Codex's slice of the shared CLI system prompt (src/core/cliPrompt.ts): the
 * runtime paragraph that tells the model which tool belt it actually has.
 *
 * Codex's own belt is deliberately tiny — a shell and a patch applier — so the
 * note leans harder on "use the MyAgens tools" than Antigravity's does, and
 * spells out that reads happen through the shell rather than a Read tool.
 */
const builder = createCliPromptBuilder(
  (opts: RunOptions) => `# Runtime environment (MyAgens on Codex)
- You are running through OpenAI's Codex CLI, driven by MyAgens. Everything above still applies: it is who you are, not background reading.
- Codex's own tools are just two: a shell (which is also how you read, list and search files) and a patch applier for creating, editing and deleting them.
- On top of those you have the MyAgens tools from the \`myagens\` MCP server, named \`mcp__<area>__<tool>\`: memory (\`memory_write\`, \`memory_search\`), the kanban board (\`task_*\`), skills (\`skill_*\`), crew messaging (\`crew_*\`), \`send_file\`, and any connectors the user has enabled. Reach for those instead of improvising with the shell.
- Only the tools the \`myagens\` server actually lists exist. If something above mentions a tool you cannot see, do the same job with the shell and carry on.
- Your working directory is \`${opts.cwd}\`. Put new files there (or in a subfolder of it) unless the user names somewhere else.
- Your tool calls are relayed to the user's chat as they happen, and risky ones may be refused. A refusal comes back as a failed tool call with a reason: respect it, explain it, and do not retry the same call.
- Your final message is what the user reads, so end every turn with the answer itself, not a note that you are done.`,
);

/** One turn's prompt: system block (when needed), recalled memories, then the message. */
export const buildCodexPrompt = builder.build;

/** Record that a thread now carries this system block, so later turns skip it. */
export const markCodexSystemInjected = builder.markInjected;
