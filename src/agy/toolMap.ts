/**
 * Translate Antigravity's own tool calls into the tool vocabulary the rest of
 * the bot speaks (Bash / Read / Write / Edit / …).
 *
 * Antigravity names its tools `run_command`, `view_file`, `write_file`, … and
 * passes PascalCase arguments (`CommandLine`, `AbsolutePath`, `TargetFile`).
 * The PreToolUse hook hands those to us raw; mapping them onto the canonical
 * names means one permission model across backends: AUTO_ALLOWED_TOOLS still
 * covers reads, `/allow` presets still apply, and an "always allow `git`" grant
 * made against the Claude backend also covers `run_command` here.
 *
 * A tool with no mapping returns null and runs unannounced — Antigravity's step
 * list includes plenty of internal bookkeeping (checkpoints, planner responses,
 * memory updates) that is not a tool call in any sense the user cares about,
 * and prompting for those would make safe mode unusable.
 */

/** A mapped call: what to show/gate it as, plus how to push an edited input back. */
export interface MappedTool {
  /** Canonical tool name (`Bash`, `Read`, …) used for status and permissions. */
  name: string;
  /** Canonical input, shaped like the Claude tool's input. */
  input: Record<string, unknown>;
  /** Convert an approved-with-edits canonical input back to Antigravity's args. */
  toAgyArgs?: (input: Record<string, unknown>) => Record<string, unknown> | undefined;
}

/** First present string value among `keys`. */
function pick(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

const PATH_KEYS = ["TargetFile", "AbsolutePath", "FilePath", "Path", "NotebookPath"];
const QUERY_KEYS = ["Query", "SearchTerm", "Pattern", "Regex"];
const URL_KEYS = ["Url", "URL", "url"];

/**
 * Map one Antigravity tool call. Returns null when the call should run silently
 * (internal steps, and `call_mcp_tool` — MCP calls are announced and gated at
 * the MCP bridge itself, where the real tool name and arguments are visible).
 */
export function mapAgyTool(tool: string, args: Record<string, unknown>): MappedTool | null {
  const file = () => ({ file_path: pick(args, PATH_KEYS) ?? "" });

  switch (tool) {
    // --- shell -------------------------------------------------------------
    case "run_command":
    case "shell_exec":
    case "send_command_input": {
      const command = pick(args, ["CommandLine", "Command", "Input", "command"]) ?? "";
      return {
        name: "Bash",
        input: { command, ...(typeof args.Cwd === "string" ? { cwd: args.Cwd } : {}) },
        toAgyArgs: (input) =>
          typeof input.command === "string" && input.command !== command
            ? { CommandLine: input.command }
            : undefined,
      };
    }

    // --- reads (auto-allowed, but still worth showing as live status) ------
    case "view_file":
    case "view_file_outline":
    case "view_code_item":
    case "view_content_chunk":
    case "read_notebook":
      return { name: "Read", input: file() };
    case "read_terminal":
      return { name: "Read", input: { file_path: "(terminal)" } };
    case "list_dir":
    case "list_directory":
    case "find_by_name":
    case "find":
      return {
        name: "Glob",
        input: {
          pattern: pick(args, ["Pattern", "Glob", "Query"]) ?? "*",
          path: pick(args, ["SearchDirectory", "DirectoryPath", "AbsolutePath", "Path"]) ?? "",
        },
      };
    case "grep_search":
    case "code_search":
    case "codebase_search":
    case "search_in_file":
    case "find_all_references":
      return {
        name: "Grep",
        input: {
          pattern: pick(args, QUERY_KEYS) ?? "",
          path: pick(args, ["SearchDirectory", "AbsolutePath", "Path"]) ?? "",
        },
      };
    case "search_web":
      return { name: "WebSearch", input: { query: pick(args, QUERY_KEYS) ?? "" } };
    case "read_url_content":
    case "open_browser_url":
      return { name: "WebFetch", input: { url: pick(args, URL_KEYS) ?? "" } };

    // --- writes (gated) ----------------------------------------------------
    case "write_to_file":
    case "write_file":
    case "create_file":
      return { name: "Write", input: file() };
    case "replace_file_content":
    case "edit_file":
    case "propose_code":
    case "code_action":
      return { name: "Edit", input: file() };
    case "edit_notebook":
      return { name: "NotebookEdit", input: file() };

    // --- destructive / outward-facing: gated under their own names, so they
    // are never covered by a Read/Write preset the user granted for something
    // milder. Unknown to AUTO_ALLOWED_TOOLS, so they always prompt in safe mode.
    case "delete_file":
    case "delete_directory":
      return { name: "DeleteFile", input: file() };
    case "move_file":
    case "move":
      return { name: "MoveFile", input: { ...file(), to: pick(args, ["DestinationPath", "TargetPath"]) ?? "" } };
    case "git_commit":
      return { name: "GitCommit", input: { message: pick(args, ["Message", "CommitMessage"]) ?? "" } };
    case "execute_browser_javascript":
    case "run_extension_code":
    case "execute_notebook":
    case "install_applet_package":
    case "install_applet_dependencies":
    case "deploy_firebase":
    case "cloud_sql_execute_sql":
    case "cloud_sql_update_schema":
      return { name: agyToolLabel(tool), input: args };

    default:
      return null;
  }
}

/** `deploy_firebase` -> `DeployFirebase`, for tools we surface under their own name. */
function agyToolLabel(tool: string): string {
  return tool
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}
