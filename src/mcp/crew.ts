import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runTurn, AUTO_ALLOWED_TOOLS } from "../claude/runner.js";
import { memoryMcp } from "./memory.js";
import { createTasksMcp } from "./tasks.js";
import { skillsMcp } from "./skills.js";
import { workers } from "../core/workers.js";
import { suggestions } from "../core/suggestions.js";
import { getSkill } from "../core/skills.js";
import { getProvider } from "../core/providers.js";
import { resolveSecret } from "../core/vault.js";
import { getLeadProtocol } from "../prompt.js";
import { config } from "../config.js";
import { log, redactSecrets } from "../logger.js";
import { registerAsk } from "../core/crewAsk.js";
import type { Autonomy } from "../session/manager.js";

const DELEGATIONS_FILE = join(config.WORKDIR, "..", "delegations.jsonl");

/** Append one record to the delegation log. */
function logDelegation(record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(DELEGATIONS_FILE), { recursive: true });
    appendFileSync(DELEGATIONS_FILE, JSON.stringify({ ts: Date.now(), ...record }) + "\n");
  } catch (err) {
    log.warn("Failed to write delegation log", { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface CrewMcpOptions {
  /** Called to send a message to all allowed user chats (president). */
  notify: (text: string) => Promise<void>;
  /** Chat id of the primary operator (for crew_ask). */
  primaryChatId: number;
  /** Id of the agent running these tools (for delegation log). */
  fromAgentId?: string;
  /**
   * Autonomy level of the turn calling these tools. A delegated run's
   * permissionMode is capped at this, so a supervised/standard caller cannot
   * spawn a `bypassPermissions` child run (closes a privilege-escalation path
   * through the delegation chain). Defaults to `full` when unset (autonomous
   * worker runs that already run unattended).
   */
  callerAutonomy?: Autonomy;
  /**
   * True when the calling turn is in planning mode. A planning turn must not
   * fire real work: crew_delegate routes to the suggestion inbox instead of
   * running the Lead, so the president reviews and explicitly delegates.
   */
  callerPlanning?: boolean;
}

/**
 * Cap a delegated run's permissionMode at the caller's autonomy. Only a `full`
 * (or unattended-worker default) caller may grant `bypassPermissions`; anything
 * more supervised falls back to `default`, where the delegated run's canUseTool
 * gate still allows only the read-only AUTO_ALLOWED_TOOLS set.
 */
function delegatedPermissionMode(callerAutonomy: Autonomy | undefined): "bypassPermissions" | "default" {
  const level = callerAutonomy ?? "full";
  return level === "full" || level === "auto_until_error" ? "bypassPermissions" : "default";
}

/**
 * In-process MCP server giving agents crew coordination tools.
 * crew_delegate — hand off a task to a named Lead worker and get the output.
 * crew_report   — log a summary and optionally push it to the president over Telegram.
 * crew_ask_president — send the president a question and wait for a reply.
 */
export function createCrewMcp(opts: CrewMcpOptions) {
  return createSdkMcpServer({
    name: "crew",
    version: "1.0.0",
    tools: [
      tool(
        "crew_delegate",
        "Hand off a task to a Lead worker by id and receive its output. " +
          "Use this to leverage a specialist instead of doing the work yourself.",
        {
          leadId: z.string().describe("The id or name of the Lead worker to delegate to."),
          task: z.string().describe("Clear description of the task for the Lead to perform."),
          context: z.string().optional().describe("Optional extra context to pass to the Lead."),
        },
        async (args) => {
          const all = workers.list();
          const lead =
            workers.get(args.leadId) ??
            all.find((w) => w.name.toLowerCase() === args.leadId.toLowerCase());
          if (!lead) {
            const available = all.length
              ? `${all.length} worker(s) exist — use crew_delegate with an exact name or id.`
              : "no workers are configured.";
            return { content: [{ type: "text", text: `No worker found matching "${args.leadId}". ${available}` }] };
          }
          // Planning turns must not fire real work. Route the delegation to the
          // suggestion inbox so the president reviews and explicitly delegates,
          // rather than spawning an autonomous run mid-plan.
          if (opts.callerPlanning) {
            const fromId = opts.fromAgentId ?? "atlas";
            const fromName = workers.get(fromId)?.name ?? fromId;
            const detail = args.context
              ? `Delegate to ${lead.name}: ${args.task}\n\nContext:\n${args.context}`
              : `Delegate to ${lead.name}: ${args.task}`;
            const s = suggestions.add({
              fromAgentId: fromId,
              fromAgentName: fromName,
              title: `Delegate to ${lead.name}: ${args.task.slice(0, 80)}`,
              detail,
              category: "delegation",
            });
            logDelegation({ fromAgentId: fromId, type: "suggestion", toAgentId: lead.id, leadName: lead.name, summary: args.task });
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Planning mode: not run now. Filed as a suggestion (id ${s.id}) so the ` +
                    `president can review and delegate to ${lead.name} from the inbox.`,
                },
              ],
            };
          }
          const skill = lead.skillId ? getSkill(lead.skillId) : undefined;
          const protocol = lead.role === "lead" ? getLeadProtocol(lead.name, lead.portfolio) : undefined;
          const append = [protocol, skill?.prompt, lead.systemPrompt].filter(Boolean).join("\n\n") || undefined;
          const provider = lead.providerId ? getProvider(lead.providerId) : undefined;
          const env = provider
            ? {
                ANTHROPIC_BASE_URL: provider.baseUrl,
                ANTHROPIC_AUTH_TOKEN: resolveSecret(provider.authToken),
                ANTHROPIC_API_KEY: undefined,
              }
            : undefined;
          const prompt = args.context
            ? `${args.task}\n\nContext:\n${args.context}`
            : args.task;
          const abort = new AbortController();
          const startedAt = Date.now();
          let output = "";
          try {
            const res = await runTurn({
              prompt,
              cwd: lead.cwd,
              model: lead.model,
              env,
              systemPromptAppend: append,
              persona: lead.persona,
              permissionMode: delegatedPermissionMode(opts.callerAutonomy),
              abortController: abort,
              mcpServers: { memory: memoryMcp, tasks: createTasksMcp({ createdBy: lead.id }), skills: skillsMcp },
              canUseTool: async (name, input) => {
                if (AUTO_ALLOWED_TOOLS.has(name)) return { behavior: "allow", updatedInput: input };
                return { behavior: "deny", message: "Tool not permitted for delegated lead." };
              },
              onText: (delta) => { output += delta; },
              onToolUse: () => {},
              onSessionId: () => {},
            });
            const durationMs = Date.now() - startedAt;
            logDelegation({
              fromAgentId: opts.fromAgentId ?? "atlas",
              toAgentId: args.leadId,
              leadName: lead.name,
              task: args.task,
              outputTail: redactSecrets(output.slice(-500)),
              durationMs,
              costUsd: res.costUsd,
            });
            return { content: [{ type: "text", text: output || "(no output)" }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("crew_delegate failed", { leadId: args.leadId, error: msg });
            return { content: [{ type: "text", text: `Delegation failed: ${msg}` }] };
          }
        },
      ),

      tool(
        "crew_report",
        "Record a summary of COMPLETED WORK in the delegation log. For a " +
          "proposal, idea, or finding the president should review, use " +
          "crew_suggest instead (it queues in the inbox for triage). Set " +
          "toPresident only for time-critical results that can't wait.",
        {
          summary: z.string().describe("Concise summary of the work done or outcome."),
          toPresident: z
            .boolean()
            .optional()
            .describe(
              "If true, also DMs the summary to the president immediately. Use " +
                "sparingly, only for time-critical results; otherwise prefer " +
                "crew_suggest so Atlas can triage and batch.",
            ),
        },
        async (args) => {
          logDelegation({
            fromAgentId: opts.fromAgentId ?? "atlas",
            type: "report",
            summary: args.summary,
          });
          if (args.toPresident) {
            try {
              await opts.notify(args.summary);
            } catch (err) {
              log.warn("crew_report notify failed", { error: err instanceof Error ? err.message : String(err) });
            }
          }
          return { content: [{ type: "text", text: "Report logged." + (args.toPresident ? " Sent to president." : "") }] };
        },
      ),

      tool(
        "crew_suggest",
        "File a proposal, idea, or finding for the president's review. It queues " +
          "in the suggestion inbox (the president gets a light heads-up ping, not " +
          "the full proposal as a DM) so Atlas can triage and batch it into a " +
          "digest; the president then accepts (→ a task) or dismisses it. Use this " +
          "for non-urgent ideas instead of messaging the president directly.",
        {
          title: z.string().describe("Short, specific headline for the suggestion."),
          detail: z.string().describe("The full proposal: what, why, and any specifics."),
          category: z
            .string()
            .optional()
            .describe("Optional grouping label, e.g. 'ui', 'infra', 'process'."),
        },
        async (args) => {
          const fromId = opts.fromAgentId ?? "atlas";
          const fromName = workers.get(fromId)?.name ?? fromId;
          const s = suggestions.add({
            fromAgentId: fromId,
            fromAgentName: fromName,
            title: args.title,
            detail: args.detail,
            category: args.category,
          });
          logDelegation({ fromAgentId: fromId, type: "suggestion", summary: args.title });
          return {
            content: [
              {
                type: "text",
                text: `Suggestion filed for the president's review (id ${s.id}). Atlas will triage it.`,
              },
            ],
          };
        },
      ),

      tool(
        "crew_ask_president",
        "Send the president a question over Telegram and wait for their reply. " +
          "Blocks until the user responds or the approval timeout elapses.",
        {
          question: z.string().describe("The question to ask the president."),
        },
        async (args) => {
          const { id, promise } = registerAsk(opts.primaryChatId, config.APPROVAL_TIMEOUT_MS);
          log.info("crew_ask_president registered", { id, chatId: opts.primaryChatId });
          try {
            await opts.notify(
              `❓ I need your input:\n\n${args.question}\n\nJust reply with your answer (id ${id}).`,
            );
          } catch (err) {
            log.warn("crew_ask_president notify failed", { error: err instanceof Error ? err.message : String(err) });
          }
          try {
            const reply = await promise;
            return { content: [{ type: "text", text: reply }] };
          } catch (reason) {
            return { content: [{ type: "text", text: `No reply received: ${reason}` }] };
          }
        },
      ),
    ],
  });
}
