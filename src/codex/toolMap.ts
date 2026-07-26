/**
 * Translate Codex's own tool calls into the tool vocabulary the rest of the bot
 * speaks (Bash / Write / Edit / …).
 *
 * Codex's belt is tiny compared to Antigravity's: the PreToolUse hook only ever
 * reports `Bash` (which is also how listing, reading and searching arrive —
 * there is no Read/Grep/Glob tool), `apply_patch` (the ONE write tool, covering
 * create, edit and delete), and `mcp__<server>__<tool>` for MCP calls. So the
 * shell needs no translation at all, and the only real work here is reading the
 * patch body to tell a create from an edit from a delete.
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

/** `*** Add File: path` and friends, the envelope codex patches are written in. */
const PATCH_OP = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;

interface PatchOp {
  kind: "Add" | "Update" | "Delete";
  path: string;
}

/** Every file operation a patch body performs, in the order they appear. */
function parsePatch(patch: string): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const m of patch.matchAll(PATCH_OP)) {
    ops.push({ kind: m[1] as PatchOp["kind"], path: m[2].trim() });
  }
  return ops;
}

/**
 * Map one Codex tool call. Returns null when the call should run silently —
 * which includes `mcp__*` steps, since MCP calls are announced and gated at the
 * MCP bridge itself, where the real tool name and arguments are visible.
 */
export function mapCodexTool(tool: string, args: Record<string, unknown>): MappedTool | null {
  if (tool.startsWith("mcp__")) return null;

  switch (tool) {
    // --- shell -------------------------------------------------------------
    // Same name and same `{command}` shape the Claude backend uses, so this is
    // a pass-through: the per-program "always allow <cmd>" presets match as-is.
    case "Bash":
    case "shell": {
      const command = pick(args, ["command", "Command"]) ?? "";
      return {
        name: "Bash",
        input: {
          command,
          ...(typeof args.workdir === "string" ? { cwd: args.workdir } : {}),
        },
        toCliArgs: (input) =>
          typeof input.command === "string" && input.command !== command
            ? { command: input.command }
            : undefined,
      };
    }

    // --- the single write tool ---------------------------------------------
    // `apply_patch` covers create, edit and delete, so the distinction has to
    // be read out of the patch body. The most destructive operation in the
    // patch decides how the call is gated, so a delete is never waved through
    // by an "always allow Edit" preset that rode along in the same patch.
    case "apply_patch": {
      const patch = pick(args, ["input", "patch", "command", "changes"]) ?? "";
      const ops = parsePatch(patch);
      const chosen =
        ops.find((o) => o.kind === "Delete") ?? ops.find((o) => o.kind === "Add") ?? ops[0];
      const name = chosen?.kind === "Delete" ? "DeleteFile" : chosen?.kind === "Add" ? "Write" : "Edit";
      return {
        name,
        input: {
          file_path: chosen?.path ?? "",
          // A patch can touch several files at once, which no Claude tool call
          // ever does — list them so the approval prompt shows the real scope.
          ...(ops.length > 1 ? { files: ops.map((o) => `${o.kind}: ${o.path}`) } : {}),
        },
      };
    }

    // --- occasional extras --------------------------------------------------
    case "web_search":
    case "web_search_call":
      return { name: "WebSearch", input: { query: pick(args, ["query", "q"]) ?? "" } };
    case "view_image":
      return { name: "Read", input: { file_path: pick(args, ["path", "file_path"]) ?? "" } };
    case "update_plan":
      return { name: "TodoWrite", input: args };

    default:
      return null;
  }
}
