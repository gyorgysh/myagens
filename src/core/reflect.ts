import { config } from "../config.js";
import { resolveMainRun } from "./mainSettings.js";
import { getBackend } from "./backends.js";
import { memoryMcp } from "../mcp/memory.js";
import { skillsMcp } from "../mcp/skills.js";
import { log } from "../logger.js";

const COST_THRESHOLD_USD = 0.05;
const DURATION_THRESHOLD_MS = 30_000;
/** Minimum gap between reflect runs per chat to avoid spamming memory writes. */
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

const lastReflectAt = new Map<number, number>();

const SYSTEM = `You are a reflection pass. A Claude Code turn just finished on a host machine. Your only job is to decide whether anything is worth keeping for future turns, and if so, save it — then stop. Be conservative: most turns yield nothing.

Save with the available tools, nothing else:
- memory_write — a durable, specific fact about this user/host/project (a path, a preference, a config value, how their setup works). Not a one-off, not a restatement of the request.
- skill_save — a reusable, repeatable procedure that would save time if this kind of task recurs.

If there is nothing genuinely worth keeping, reply with a single line "nothing" and call no tools. Do not greet, explain, or summarise the turn.`;

/**
 * After a substantive turn, run a short autonomous reflection turn that may save a
 * durable fact (memory) and/or a reusable skill. It goes through `runTurn` like
 * everything else, so it inherits the main agent's configured model/provider/auth
 * (codex proxy, local model, Anthropic — whatever the bot itself uses); there is no
 * separate API-key path. Fire-and-forget, gated by cost/time thresholds so cheap
 * turns never trigger it.
 */
export async function reflectOnTurn(
  userPrompt: string,
  toolCalls: Array<{ name: string; input: unknown }>,
  result: { text?: string; costUsd?: number; durationMs?: number },
  chatId?: number,
): Promise<void> {
  if (!config.AUTO_SKILL_GENERATION) return;
  const { costUsd = 0, durationMs = 0 } = result;
  if (costUsd < COST_THRESHOLD_USD && durationMs < DURATION_THRESHOLD_MS) return;
  const key = chatId ?? 0;
  const last = lastReflectAt.get(key) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    log.debug("Reflect: skipped (cooldown)", { chatId });
    return;
  }
  lastReflectAt.set(key, Date.now());

  const toolSummary = toolCalls
    .slice(0, 20)
    .map((t) => {
      const inp = (t.input ?? {}) as Record<string, unknown>;
      const arg = String(inp.command ?? inp.file_path ?? inp.pattern ?? inp.path ?? "").slice(0, 60);
      return `- ${t.name}${arg ? `(${arg})` : ""}`;
    })
    .join("\n");

  const prompt =
    `Reflect on the turn below and save anything durable.\n\n` +
    `User asked: "${userPrompt.slice(0, 300)}"\n\n` +
    `Tools used:\n${toolSummary || "(none)"}\n\n` +
    `Output tail:\n${(result.text ?? "").slice(-400)}`;

  const mainRun = resolveMainRun();
  try {
    await getBackend(mainRun.backendId).runTurn({
      prompt,
      cwd: config.WORKDIR,
      model: mainRun.model,
      env: mainRun.env,
      promptExclude: mainRun.promptExclude,
      systemPromptAppend: SYSTEM,
      // The reflection prompt embeds the user's prompt + the turn's output tail —
      // content a supervised session deliberately gated, and which may carry
      // injected instructions from web/connector content the turn fetched.
      // Running `bypassPermissions` here would hand that content the full tool
      // belt (Bash/Write/Edit) unattended. Use `default` mode and hard-restrict
      // the gate to the two save tools this pass is supposed to use, so a
      // hijacked reflection can't do anything but write a memory/skill.
      permissionMode: "default",
      abortController: new AbortController(),
      mcpServers: { memory: memoryMcp, skills: skillsMcp },
      canUseTool: async (name, input) =>
        name.startsWith("mcp__memory__") || name.startsWith("mcp__skills__")
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Reflection pass may only write memories/skills." },
      onText: () => {},
      onToolUse: (name) => log.info("Reflect: saved", { tool: name }),
      onSessionId: () => {},
    });
  } catch (err) {
    log.debug("Reflect: skipped", { error: err instanceof Error ? err.message : String(err) });
  }
}
