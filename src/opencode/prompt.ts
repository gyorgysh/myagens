import type { RunOptions } from "../claude/runner.js";
import { createCliPromptBuilder } from "../core/cliPrompt.js";

/**
 * OpenCode's slice of the shared CLI system prompt (src/core/cliPrompt.ts): the
 * runtime paragraph that tells the model which tool belt it actually has.
 *
 * OpenCode's own belt is a full one (bash, read/write/edit, grep, glob, web).
 * MCP tools from our bridge show up under the `myagens_` prefix OpenCode adds
 * to the server name, with the Claude-style `mcp__<area>__<tool>` name after
 * it (e.g. `myagens_mcp__memory__memory_search`).
 */
const builder = createCliPromptBuilder(
  (opts: RunOptions) => `# Runtime environment (MyAgens on OpenCode)
- You are running through OpenCode's \`opencode\` CLI, driven by MyAgens. Everything above still applies: it is who you are, not background reading.
- OpenCode's own tools (bash, read, write, edit, grep, glob, webfetch, websearch, …) work as usual.
- On top of those you have the MyAgens tools from the \`myagens\` MCP server. OpenCode names them \`myagens_mcp__<area>__<tool>\`: memory (\`memory_write\`, \`memory_search\`), the kanban board (\`task_*\`), skills (\`skill_*\`), crew messaging (\`crew_*\`), \`send_file\`, and any connectors the user has enabled. Reach for those instead of improvising with the shell.
- Only the tools the \`myagens\` server actually lists exist. If something above mentions a tool you cannot see, do the same job with the tools you have and carry on.
- Your working directory is \`${opts.cwd}\`. Put new files there (or in a subfolder of it) unless the user names somewhere else.
- Your tool calls are relayed to the user's chat as they happen, and risky ones may be refused. A refusal comes back as a failed tool call with a reason: respect it, explain it, and do not retry the same call.
- Your final message is what the user reads, so end every turn with the answer itself, not a note that you are done.`,
);

/** One turn's prompt: system block (when needed), recalled memories, then the message. */
export const buildOpencodePrompt = builder.build;

/** Record that a session now carries this system block, so later turns skip it. */
export const markOpencodeSystemInjected = builder.markInjected;
