/**
 * Translate Cursor's own tool calls into the tool vocabulary the rest of the bot
 * speaks (Bash / Read / Write / …).
 *
 * The names here are the HOOK's, not the stream's. `cursor-agent`'s
 * `--output-format stream-json` labels a call by its event key
 * (`shellToolCall`, `editToolCall`, …), which is a display vocabulary; the
 * `preToolUse` payload uses a consolidated set instead — `Shell`, `Read`,
 * `Write` (which covers editing too, there is no separate Edit at the hook
 * layer), `Grep`, and `MCP:<tool>`. Only the hook can gate a call, so only its
 * names matter here. `Glob` is not a cursor tool at all.
 *
 * Mapping onto the canonical names means one permission model across backends:
 * AUTO_ALLOWED_TOOLS still covers reads, `/allow` presets still apply, and an
 * "always allow `git`" grant made against the Claude backend also covers a
 * shell call here.
 *
 * A tool with no mapping returns null and runs unannounced.
 */

import type { MappedTool } from "../core/cliBridge.js";

/** First present string value among `keys`. */
function pick(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Map one Cursor tool call. Returns null when the call should run silently —
 * which includes `MCP:*` steps, since MCP calls are announced and gated at the
 * MCP bridge itself, where the real tool name and arguments are visible.
 */
export function mapCursorTool(tool: string, args: Record<string, unknown>): MappedTool | null {
  if (tool.startsWith("MCP:") || tool.startsWith("mcp__")) return null;

  switch (tool) {
    case "Shell":
    case "Bash": {
      const command = pick(args, ["command", "cmd", "script"]) ?? "";
      return {
        name: "Bash",
        input: {
          command,
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
        },
        // An approved-with-edits command is pushed back through the hook's
        // `updated_input`, which cursor honours (verified).
        toCliArgs: (input) =>
          typeof input.command === "string" && input.command !== command
            ? { command: input.command }
            : undefined,
      };
    }

    case "Read":
      return { name: "Read", input: { file_path: pick(args, ["path", "file_path", "target_file"]) ?? "" } };

    // One name for create, edit and delete: cursor consolidates them, so the
    // gate sees a write either way. Erring towards Write (rather than Edit)
    // keeps a narrower "always allow Edit" preset from covering a file creation.
    case "Write":
      return {
        name: "Write",
        input: { file_path: pick(args, ["path", "file_path", "target_file"]) ?? "" },
      };

    case "Grep":
      return {
        name: "Grep",
        input: {
          pattern: pick(args, ["pattern", "query", "regex"]) ?? "",
          ...(typeof args.path === "string" ? { path: args.path } : {}),
        },
      };

    default:
      return null;
  }
}
