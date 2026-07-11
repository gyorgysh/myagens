import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  listInstances,
  peekInstance,
  restartInstance,
  sendToInstance,
  stopInstance,
  tmuxAvailableSync,
} from "../claude/tmuxInstance.js";
import { audit } from "../core/audit.js";
import { log } from "../logger.js";

/**
 * MCP server around the persistent tmux-hosted claude instances (Tmux mode,
 * src/claude/tmuxInstance.ts), so SDK-backend agents can observe and manage
 * their tmux-hosted peers. The observe tools (`tmux_list_instances`,
 * `tmux_peek`) are read-only and in AUTO_ALLOWED_TOOLS; the steer/lifecycle
 * tools go through the normal approval gate. Note the tmux-hosted TUI itself
 * cannot consume in-process MCP servers — these tools are always executed by
 * an SDK-backend agent *about* a tmux instance, never *inside* one.
 */

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

function requireTmux(): string | null {
  return tmuxAvailableSync() ? null : "tmux is not installed on this host (brew/apt install tmux).";
}

export const tmuxMcp = createSdkMcpServer({
  name: "tmux",
  version: "1.0.0",
  tools: [
    tool(
      "tmux_list_instances",
      "List the persistent tmux-hosted Claude instances (Tmux-mode agents): state " +
        "(idle/busy/stopped), tmux session name, working directory, turn count, and the " +
        "claude.ai Remote Control URL when mirrored. Read-only.",
      {},
      async () => {
        const missing = requireTmux();
        if (missing) return ok(missing);
        const list = listInstances();
        if (!list.length) return ok("No persistent instances exist (no agent has Tmux mode enabled yet).");
        const lines = list.map((i) => {
          const bits = [
            `${i.agentName} (agentId: ${i.agentId})`,
            `state: ${i.state}`,
            `session: ${i.sessionName}`,
            i.cwd ? `cwd: ${i.cwd}` : null,
            `turns: ${i.turnCount}`,
            i.remoteControl ? `RC: on${i.rcUrl ? ` (${i.rcUrl})` : ""}` : "RC: off",
            i.foreign ? "foreign (not managed by this bot; read-only)" : null,
          ].filter(Boolean);
          return "- " + bits.join(" · ");
        });
        return ok(lines.join("\n"));
      },
    ),
    tool(
      "tmux_peek",
      "Show the recent rendered terminal output of a persistent instance's pane (what a " +
        "human would see in `tmux attach`). Read-only; use it to check what a Tmux-mode " +
        "agent is doing right now.",
      {
        agentId: z.string().describe("The instance's agentId from tmux_list_instances."),
        lines: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many lines of scrollback to include (default 40, max 200)."),
      },
      async (args) => {
        try {
          const text = await peekInstance(args.agentId, args.lines ?? 40);
          return ok(text || "(the pane is empty)");
        } catch (e) {
          return err(e);
        }
      },
    ),
    tool(
      "tmux_send",
      "Type text into a persistent instance's TUI input box (steer another agent's live " +
        "session). Refused while the instance is busy with a turn unless force is true. " +
        "Use sparingly — this injects directly into that agent's conversation.",
      {
        agentId: z.string().describe("The instance's agentId from tmux_list_instances."),
        text: z.string().min(1).describe("The text/prompt to type."),
        submit: z.boolean().optional().describe("Press Enter after typing (default true)."),
        force: z.boolean().optional().describe("Send even while the instance is mid-turn."),
      },
      async (args) => {
        const inst = listInstances().find((i) => i.agentId === args.agentId);
        if (inst?.foreign) return err(new Error("foreign session — this bot does not drive it"));
        if (inst?.state === "busy" && !args.force) {
          return err(new Error("instance is mid-turn; pass force: true to send anyway"));
        }
        try {
          await sendToInstance(args.agentId, args.text, args.submit !== false);
          audit("tmuxInstance.send", { agentId: args.agentId, chars: args.text.length });
          log.info("[tmux] mcp send", { agentId: args.agentId, chars: args.text.length });
          return ok(`Sent to ${args.agentId}${args.submit !== false ? " and submitted" : ""}.`);
        } catch (e) {
          return err(e);
        }
      },
    ),
    tool(
      "tmux_start",
      "Start (or respawn) a Tmux-mode agent's persistent instance, resuming its previous " +
        "conversation when possible.",
      {
        agentId: z.string().describe("The instance's agentId from tmux_list_instances."),
        remoteControl: z
          .boolean()
          .optional()
          .describe("Override the Remote Control flag for this launch."),
      },
      async (args) => {
        try {
          const info = await restartInstance(args.agentId, { remoteControl: args.remoteControl });
          audit("tmuxInstance.start", { agentId: args.agentId, via: "mcp" });
          return ok(
            `Instance ${info.sessionName} is ${info.state}.` + (info.rcUrl ? ` Mirrored at ${info.rcUrl}` : ""),
          );
        } catch (e) {
          return err(e);
        }
      },
    ),
    tool(
      "tmux_stop",
      "Stop a persistent instance (tmux kill-session). Its conversation may be resumable " +
        "on the next start; the agent falls back to normal SDK turns while stopped.",
      { agentId: z.string().describe("The instance's agentId from tmux_list_instances.") },
      async (args) => {
        try {
          await stopInstance(args.agentId);
          audit("tmuxInstance.stop", { agentId: args.agentId, via: "mcp" });
          return ok(`Instance for ${args.agentId} stopped.`);
        } catch (e) {
          return err(e);
        }
      },
    ),
    tool(
      "tmux_restart",
      "Kill and respawn a persistent instance (applies pending Remote Control / directory " +
        "changes). May reset the in-TUI conversation if it cannot be resumed.",
      {
        agentId: z.string().describe("The instance's agentId from tmux_list_instances."),
        remoteControl: z
          .boolean()
          .optional()
          .describe("Override the Remote Control flag for the relaunch."),
      },
      async (args) => {
        try {
          const info = await restartInstance(args.agentId, { remoteControl: args.remoteControl });
          audit("tmuxInstance.restart", { agentId: args.agentId, via: "mcp" });
          return ok(
            `Instance ${info.sessionName} restarted (${info.state}).` +
              (info.rcUrl ? ` Mirrored at ${info.rcUrl}` : ""),
          );
        } catch (e) {
          return err(e);
        }
      },
    ),
  ],
});
