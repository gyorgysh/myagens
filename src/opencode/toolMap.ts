/**
 * Translate OpenCode's own tool calls into the tool vocabulary the rest of the
 * bot speaks (Bash / Read / Write / …).
 *
 * OpenCode's built-in names are lowercase (`bash`, `read`, `write`, `edit`,
 * `grep`, `glob`, `webfetch`, `websearch`, `apply_patch`, `todowrite`, …). MCP
 * tools arrive as `myagens_<advertisedName>` (OpenCode prefixes the server
 * name), and those are gated at the MCP bridge itself, so they return null
 * here.
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

/** `*** Add File: path` and friends, the envelope apply_patch bodies use. */
const PATCH_OP = /^\*\*\* (Add|Update|Delete|Move to) File: (.+)$/gm;

interface PatchOp {
  kind: string;
  path: string;
}

function parsePatch(patch: string): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const m of patch.matchAll(PATCH_OP)) {
    ops.push({ kind: m[1], path: m[2].trim() });
  }
  return ops;
}

/**
 * Map one OpenCode tool call. Returns null when the call should run silently —
 * which includes `myagens_*` MCP steps, since MCP calls are announced and gated
 * at the MCP bridge itself, where the real tool name and arguments are visible.
 */
export function mapOpencodeTool(tool: string, args: Record<string, unknown>): MappedTool | null {
  // OpenCode prefixes MCP tools with `<server>_`. Our server is `myagens`, and
  // we advertise Claude-style `mcp__area__tool` names, so the full key looks
  // like `myagens_mcp__memory__memory_search`.
  if (tool.startsWith("myagens_") || tool.startsWith("mcp__")) return null;

  switch (tool) {
    case "bash":
    case "Bash":
    case "Shell": {
      const command = pick(args, ["command", "cmd", "script"]) ?? "";
      return {
        name: "Bash",
        input: {
          command,
          ...(typeof args.workdir === "string"
            ? { cwd: args.workdir }
            : typeof args.cwd === "string"
              ? { cwd: args.cwd }
              : {}),
        },
        toCliArgs: (input) =>
          typeof input.command === "string" && input.command !== command
            ? { command: input.command }
            : undefined,
      };
    }

    case "read":
    case "Read":
      return {
        name: "Read",
        input: { file_path: pick(args, ["filePath", "path", "file_path", "target_file"]) ?? "" },
      };

    case "write":
    case "Write":
      return {
        name: "Write",
        input: { file_path: pick(args, ["filePath", "path", "file_path", "target_file"]) ?? "" },
      };

    case "edit":
    case "Edit":
      return {
        name: "Edit",
        input: { file_path: pick(args, ["filePath", "path", "file_path", "target_file"]) ?? "" },
      };

    case "grep":
    case "Grep":
      return {
        name: "Grep",
        input: {
          pattern: pick(args, ["pattern", "query", "regex"]) ?? "",
          ...(typeof args.path === "string" ? { path: args.path } : {}),
        },
      };

    case "glob":
    case "Glob":
      return {
        name: "Glob",
        input: {
          pattern: pick(args, ["pattern", "glob", "glob_pattern"]) ?? "",
          ...(typeof args.path === "string" ? { path: args.path } : {}),
        },
      };

    case "webfetch":
    case "WebFetch":
      return { name: "WebFetch", input: { url: pick(args, ["url", "href"]) ?? "" } };

    case "websearch":
    case "WebSearch":
      return { name: "WebSearch", input: { query: pick(args, ["query", "q"]) ?? "" } };

    case "apply_patch": {
      const patch = pick(args, ["patchText", "patch", "input", "command"]) ?? "";
      const ops = parsePatch(patch);
      const chosen =
        ops.find((o) => /Delete/i.test(o.kind)) ??
        ops.find((o) => /Add/i.test(o.kind)) ??
        ops[0];
      const name = chosen && /Delete/i.test(chosen.kind)
        ? "DeleteFile"
        : chosen && /Add/i.test(chosen.kind)
          ? "Write"
          : "Edit";
      return {
        name,
        input: {
          file_path: chosen?.path ?? "",
          ...(ops.length > 1 ? { files: ops.map((o) => `${o.kind}: ${o.path}`) } : {}),
        },
      };
    }

    case "todowrite":
    case "TodoWrite":
      return { name: "TodoWrite", input: args };

    case "task":
      // Subagent spawn: surface as a Task so it is not silent, but leave gating
      // loose (mapped as a named step without a shell body to rewrite).
      return { name: "Task", input: args };

    case "skill":
      return { name: "Skill", input: { skill: pick(args, ["name", "skill", "id"]) ?? "" } };

    case "lsp":
      return { name: "Lsp", input: args };

    default:
      return null;
  }
}
