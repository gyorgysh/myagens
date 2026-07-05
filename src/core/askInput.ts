/**
 * Shared parsing for the built-in AskUserQuestion tool's input shape. Used by
 * both the Telegram AskQuestionManager (telegram/askQuestion.ts) and the panel
 * AgentAskManager (core/agentAskQuestion.ts) so every surface interprets the
 * SDK's `{ questions: [...] }` payload identically.
 */

/** One option of an AskUserQuestion question. */
export interface AskOption {
  label: string;
  description?: string;
}

/** One normalized question from the AskUserQuestion tool input. */
export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/**
 * Defensively normalize the AskUserQuestion tool input into our shape. The SDK
 * input is `{ questions: [{ question, header, multiSelect, options: [{label, description}] }] }`.
 */
export function parseAskInput(input: unknown): AskQuestion[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    const obj = (q ?? {}) as Record<string, unknown>;
    const question = typeof obj.question === "string" ? obj.question : "";
    if (!question) continue;
    const header = typeof obj.header === "string" && obj.header.trim() ? obj.header : "Question";
    const optsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options: AskOption[] = [];
    for (const o of optsRaw) {
      const oo = (o ?? {}) as Record<string, unknown>;
      if (typeof oo.label === "string" && oo.label.trim()) {
        options.push({
          label: oo.label,
          description: typeof oo.description === "string" ? oo.description : undefined,
        });
      }
    }
    out.push({ question, header, multiSelect: obj.multiSelect === true, options });
  }
  return out;
}
