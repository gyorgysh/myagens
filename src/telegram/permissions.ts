import { randomBytes } from "node:crypto";
import { Markup, type Telegram } from "telegraf";
import { config } from "../config.js";
import { escapeHtml } from "./formatting.js";
import { log } from "../logger.js";
import { parseCallback, isHexId } from "./callback.js";

export type ApprovalChoice = "allow" | "deny" | "always" | "alwayscmd";

/** The set of legitimate approval actions, used to whitelist untrusted callback data. */
const VALID_CHOICES: ReadonlySet<string> = new Set<ApprovalChoice>([
  "allow",
  "deny",
  "always",
  "alwayscmd",
]);

/** The leading program of a Bash command, e.g. "git status -s" -> "git". */
export function bashLeadCmd(input: unknown): string | undefined {
  const cmd = (input as { command?: unknown })?.command;
  if (typeof cmd !== "string") return undefined;
  const tok = cmd.trim().split(/\s+/)[0];
  return tok && /^[\w./-]+$/.test(tok) ? tok : undefined;
}

interface Pending {
  id: string;
  resolve: (choice: ApprovalChoice) => void;
  timeout: NodeJS.Timeout;
  chatId: number;
  toolName: string;
  input: unknown;
  /** The Bash lead program, when this is a Bash call (for the "always cmd" preset). */
  lead?: string;
  /** Settled requests keep their final label so the grouped message can show it. */
  settled?: ApprovalChoice;
}

/** A batch of coalesced approvals sharing one Telegram message. */
interface Batch {
  chatId: number;
  /** Request ids in arrival order. */
  ids: string[];
  /** Telegram message id once the batch has been posted (undefined while buffering). */
  messageId?: number;
  /** Debounce timer; fires to post (or, if already posted, no-op). */
  flushTimer?: NodeJS.Timeout;
  /** When the first request in this batch arrived (caps the buffering window). */
  openedAt: number;
}

const CB_PREFIX = "appr";

/**
 * Tool calls that arrive within this window are coalesced into a single grouped
 * approval message (with per-tool Approve/Deny + a shared Allow all / Deny all
 * row), instead of one message per call. The model often emits several tool_use
 * blocks in one assistant turn, so this collapses the burst into one prompt.
 */
const COALESCE_WINDOW_MS = 300;

/**
 * Hard cap on how long a batch keeps buffering: even if new requests keep
 * trickling in just under the debounce window, the batch is flushed once it has
 * been open this long, so the user is never left waiting indefinitely.
 */
const COALESCE_MAX_MS = 1_200;

/**
 * Bridges the SDK's canUseTool callback to a Telegram Approve/Deny/Always flow.
 * Requests are coalesced per chat: those arriving within COALESCE_WINDOW_MS are
 * rendered in a single grouped message with per-tool buttons and a shared bulk
 * row, and each request's promise resolves when its button (or a bulk button)
 * is pressed, or when it times out.
 */
export class PermissionManager {
  private pending = new Map<string, Pending>();
  /** One open batch per chat while buffering / awaiting resolution. */
  private batches = new Map<number, Batch>();

  constructor(private tg: Telegram) {}

  async request(chatId: number, toolName: string, input: unknown): Promise<ApprovalChoice> {
    const id = randomBytes(4).toString("hex");
    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;

    const promise = new Promise<ApprovalChoice>((resolve) => {
      const timeout = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry || entry.settled) return;
        entry.settled = "deny";
        log.warn("Approval timed out — auto-denied", { chatId, tool: toolName });
        resolve("deny");
        void this.afterSettle(chatId);
      }, config.APPROVAL_TIMEOUT_MS);

      this.pending.set(id, { id, resolve, timeout, chatId, toolName, input, lead });
    });

    // Attach to (or open) this chat's batch and (re)arm the debounce flush.
    let batch = this.batches.get(chatId);
    if (!batch) {
      batch = { chatId, ids: [], openedAt: Date.now() };
      this.batches.set(chatId, batch);
    }
    batch.ids.push(id);

    if (batch.messageId === undefined) {
      // Still buffering: debounce, but never past the hard cap.
      if (batch.flushTimer) clearTimeout(batch.flushTimer);
      const elapsed = Date.now() - batch.openedAt;
      const delay = Math.min(COALESCE_WINDOW_MS, Math.max(0, COALESCE_MAX_MS - elapsed));
      batch.flushTimer = setTimeout(() => void this.flush(chatId), delay);
    } else {
      // Batch already posted (a late arrival): re-render to include the new row.
      await this.render(batch);
    }

    return promise;
  }

  /** Post the buffered batch as one grouped message. */
  private async flush(chatId: number): Promise<void> {
    const batch = this.batches.get(chatId);
    if (!batch || batch.messageId !== undefined) return;
    batch.flushTimer = undefined;
    const live = batch.ids.filter((id) => this.pending.get(id) && !this.pending.get(id)!.settled);
    if (live.length === 0) {
      this.batches.delete(chatId);
      return;
    }
    const msg = await this.tg.sendMessage(chatId, this.text(batch), {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(this.keyboard(batch)),
    });
    batch.messageId = msg.message_id;
  }

  /** Re-render an already-posted batch's text + keyboard in place. */
  private async render(batch: Batch): Promise<void> {
    if (batch.messageId === undefined) return;
    await this.tg
      .editMessageText(batch.chatId, batch.messageId, undefined, this.text(batch), {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(this.keyboard(batch)),
      })
      .catch(() => {});
  }

  /** Build the grouped message body listing each pending tool call. */
  private text(batch: Batch): string {
    const entries = batch.ids.map((id) => this.pending.get(id)).filter(Boolean) as Pending[];
    const live = entries.filter((e) => !e.settled);
    const header =
      live.length > 1
        ? `🔐 <b>${live.length} permissions needed</b>`
        : `🔐 <b>Permission needed</b>`;
    const lines = entries.map((e, i) => {
      const n = entries.length > 1 ? `${i + 1}. ` : "";
      const mark = e.settled === undefined ? "" : e.settled === "deny" ? " — ❌" : " — ✅";
      return (
        `${n}<b>${escapeHtml(e.toolName)}</b>${mark}\n` +
        `<pre><code>${escapeHtml(describeInput(e.toolName, e.input))}</code></pre>`
      );
    });
    return `${header}\n\n${lines.join("\n")}`;
  }

  /** Build the inline keyboard: per-tool rows + a shared bulk row when >1. */
  private keyboard(batch: Batch): ReturnType<typeof Markup.button.callback>[][] {
    const entries = batch.ids.map((id) => this.pending.get(id)).filter(Boolean) as Pending[];
    const live = entries.filter((e) => !e.settled);
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];

    if (live.length === 1) {
      // Solo prompt keeps the full preset set (Approve/Deny + Always [+ cmd]).
      const e = live[0];
      rows.push([
        Markup.button.callback("✅ Approve", `${CB_PREFIX}:${e.id}:allow`),
        Markup.button.callback("❌ Deny", `${CB_PREFIX}:${e.id}:deny`),
      ]);
      rows.push([
        Markup.button.callback(`♾️ Always allow ${e.toolName}`, `${CB_PREFIX}:${e.id}:always`),
      ]);
      if (e.lead) {
        rows.push([
          Markup.button.callback(
            `♾️ Always allow \`${e.lead}\` commands`,
            `${CB_PREFIX}:${e.id}:alwayscmd`,
          ),
        ]);
      }
      return rows;
    }

    // Grouped: one compact Approve/Deny row per still-pending tool.
    for (const [i, e] of entries.entries()) {
      if (e.settled) continue;
      const n = `${i + 1}. `;
      rows.push([
        Markup.button.callback(`✅ ${n}${e.toolName}`, `${CB_PREFIX}:${e.id}:allow`),
        Markup.button.callback(`❌`, `${CB_PREFIX}:${e.id}:deny`),
      ]);
    }
    rows.push([
      Markup.button.callback("✅✅ Allow all", `${CB_PREFIX}:_all:allowall`),
      Markup.button.callback("❌❌ Deny all", `${CB_PREFIX}:_all:denyall`),
    ]);
    return rows;
  }

  /** Returns true if the callback was an approval button this manager owns. */
  isApprovalCallback(data: string): boolean {
    return data.startsWith(`${CB_PREFIX}:`);
  }

  /**
   * Resolve a pending approval from a callback_query. Returns a short toast
   * string. `chatId` is required to scope bulk Allow-all / Deny-all presses.
   */
  async resolve(data: string, chatId?: number): Promise<string> {
    // Validate structure before dispatch: appr:<id>:<action>, exactly 3 parts.
    const parts = parseCallback(data, `${CB_PREFIX}:`, 2);
    if (!parts) return "This request has expired.";
    const [id, action] = parts;
    // id is 8-char hex (randomBytes(4)) or the literal "_all" for bulk presses.
    if (id !== "_all" && !isHexId(id)) return "This request has expired.";

    if (action === "allowall" || action === "denyall") {
      if (chatId === undefined) return "This request has expired.";
      return this.resolveAll(chatId, action === "allowall" ? "allow" : "deny");
    }

    const entry = this.pending.get(id);
    if (!entry || entry.settled) return "This request has expired.";

    clearTimeout(entry.timeout);
    // Whitelist the action before casting: a crafted callback could carry an
    // arbitrary string, and an unhandled value must never silently approve.
    const choice: ApprovalChoice = VALID_CHOICES.has(action)
      ? (action as ApprovalChoice)
      : "deny";
    entry.settled = choice;

    const label =
      choice === "allow"
        ? "✅ Approved"
        : choice === "always"
          ? `♾️ Always allowing ${entry.toolName}`
          : choice === "alwayscmd"
            ? "♾️ Always allowing that command"
            : "❌ Denied";

    entry.resolve(choice);
    await this.afterSettle(entry.chatId);
    return label;
  }

  /** Resolve every pending approval for a chat at once (bulk Allow/Deny). */
  private async resolveAll(chatId: number, choice: "allow" | "deny"): Promise<string> {
    const batch = this.batches.get(chatId);
    const entries = (batch?.ids ?? [])
      .map((id) => this.pending.get(id))
      .filter((e): e is Pending => !!e && !e.settled);
    if (entries.length === 0) return "No pending requests.";

    for (const entry of entries) {
      clearTimeout(entry.timeout);
      entry.settled = choice;
      entry.resolve(choice);
    }

    await this.afterSettle(chatId);
    return choice === "allow"
      ? `✅✅ Approved all ${entries.length}`
      : `❌❌ Denied all ${entries.length}`;
  }

  /**
   * After one or more requests in a chat settle: re-render the grouped message
   * (showing the new ✅/❌ marks), and once every request in the batch is
   * settled, strip the keyboard, clean up, and forget the batch.
   */
  private async afterSettle(chatId: number): Promise<void> {
    const batch = this.batches.get(chatId);
    if (!batch) return;
    const entries = batch.ids.map((id) => this.pending.get(id)).filter(Boolean) as Pending[];
    const allSettled = entries.every((e) => e.settled);

    if (!allSettled) {
      await this.render(batch);
      return;
    }

    // Everything resolved: finalize the message and tear the batch down.
    if (batch.messageId !== undefined) {
      await this.tg
        .editMessageText(chatId, batch.messageId, undefined, this.text(batch), { parse_mode: "HTML" })
        .catch(() => {});
    }
    for (const id of batch.ids) this.pending.delete(id);
    if (batch.flushTimer) clearTimeout(batch.flushTimer);
    this.batches.delete(chatId);
  }
}

/** Max characters shown for a tool's input in the approval prompt. */
const MAX_DESC = 350;

/** Produce a concise human-readable summary of a tool's input. */
function describeInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (toolName === "Bash" && typeof obj.command === "string") return clamp(obj.command);
  if ((toolName === "Write" || toolName === "Edit") && typeof obj.file_path === "string") {
    return clamp(String(obj.file_path));
  }
  return clamp(JSON.stringify(obj, null, 2));
}

/** Truncate long input so the code block doesn't overflow the message. */
function clamp(s: string): string {
  return s.length > MAX_DESC ? s.slice(0, MAX_DESC) + "\n…(truncated)" : s;
}
