/**
 * Planning mode — a per-turn framing applied when the President wants the agent
 * to scope work conversationally rather than act. The preamble is prepended to
 * the user's message; the agent keeps its tools but is told not to mutate
 * anything, and to capture concrete work as inbox suggestions / backlog cards.
 *
 * The preamble lives here (rather than duplicated in chat.ts / agentChat.ts) so
 * the marker is shared: downstream code (the delegation guard, the panel mirror)
 * can detect a planning turn from the prompt text alone via `isPlanningPrompt`.
 */

/** Stable first line of the preamble, used to detect a planning turn. */
export const PLANNING_MARKER = "[Planning mode]";

export const PLANNING_PREAMBLE = [
  `${PLANNING_MARKER} Stay conversational and non-destructive for this turn.`,
  "Do NOT take real actions: no editing files, running shell commands, or",
  "mutating anything. Your job is to think through and scope the work with me.",
  "When you have something concrete to capture, propose it as an inbox",
  'suggestion (crew_suggest) or a backlog card (task_create with column "backlog")',
  "— title, notes, and priority — rather than doing the work now.",
  "If anything is ambiguous, ask a short clarifying question instead of guessing.",
  "",
  "My message:",
  "",
].join("\n");

/** Whether a built prompt carries the planning preamble. */
export function isPlanningPrompt(prompt: string): boolean {
  return prompt.startsWith(PLANNING_MARKER);
}

/**
 * Strip the planning preamble from a prompt, returning just the user's original
 * message. If the exact preamble prefix is present it is removed; otherwise the
 * text is returned unchanged. Used so the panel can show the bare message under
 * a compact "PLANNING" badge rather than the verbose preamble.
 */
export function stripPlanningPreamble(prompt: string): string {
  if (prompt.startsWith(PLANNING_PREAMBLE)) return prompt.slice(PLANNING_PREAMBLE.length);
  return prompt;
}
