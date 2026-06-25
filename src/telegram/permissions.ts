import { randomBytes } from "node:crypto";
import { Markup, type Telegram } from "telegraf";
import { config } from "../config.js";
import { escapeHtml } from "./formatting.js";
import { log } from "../logger.js";

export type ApprovalChoice = "allow" | "deny" | "always" | "alwayscmd";

/** The leading program of a Bash command, e.g. "git status -s" -> "git". */
export function bashLeadCmd(input: unknown): string | undefined {
  const cmd = (input as { command?: unknown })?.command;
  if (typeof cmd !== "string") return undefined;
  const tok = cmd.trim().split(/\s+/)[0];
  return tok && /^[\w./-]+$/.test(tok) ? tok : undefined;
}

interface Pending {
  resolve: (choice: ApprovalChoice) => void;
  timeout: NodeJS.Timeout;
  chatId: number;
  messageId: number;
  toolName: string;
  /** Per-request rows (without the shared bulk row), so we can re-render. */
  baseRows: ReturnType<typeof Markup.button.callback>[][];
}

const CB_PREFIX = "appr";

/**
 * Once this many approvals are queued for one chat, prompts gain an
 * "Allow all / Deny all" row so the user can clear the backlog in one tap.
 */
const BULK_THRESHOLD = 3;

/**
 * Bridges the SDK's canUseTool callback to a Telegram Approve/Deny/Always flow.
 * Each request posts an inline keyboard and awaits a button press (or times out).
 */
export class PermissionManager {
  private pending = new Map<string, Pending>();

  constructor(private tg: Telegram) {}

  async request(chatId: number, toolName: string, input: unknown): Promise<ApprovalChoice> {
    const id = randomBytes(4).toString("hex");
    const text =
      `🔐 <b>Permission needed</b>\n` +
      `Claude wants to use <b>${escapeHtml(toolName)}</b>:\n\n` +
      `<pre><code>${escapeHtml(describeInput(toolName, input))}</code></pre>`;

    const baseRows = [
      [
        Markup.button.callback("✅ Approve", `${CB_PREFIX}:${id}:allow`),
        Markup.button.callback("❌ Deny", `${CB_PREFIX}:${id}:deny`),
      ],
      [Markup.button.callback(`♾️ Always allow ${toolName}`, `${CB_PREFIX}:${id}:always`)],
    ];
    // For Bash, also offer a narrower "always allow this program" preset.
    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;
    if (lead) {
      baseRows.push([
        Markup.button.callback(`♾️ Always allow \`${lead}\` commands`, `${CB_PREFIX}:${id}:alwayscmd`),
      ]);
    }

    // Count siblings *before* registering this one. If the new total reaches the
    // threshold, this prompt (and the earlier ones) get a bulk Allow/Deny row.
    const siblings = [...this.pending.values()].filter((p) => p.chatId === chatId).length;
    const bulkNow = siblings + 1 >= BULK_THRESHOLD;

    const msg = await this.tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(this.withBulkRow(baseRows, bulkNow)),
    });

    const promise = new Promise<ApprovalChoice>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        log.warn("Approval timed out — auto-denied", { chatId, tool: toolName });
        void this.tg
          .editMessageText(chatId, msg.message_id, undefined, `${text}\n\n⏳ <i>Timed out — denied.</i>`, {
            parse_mode: "HTML",
          })
          .catch(() => {});
        resolve("deny");
      }, config.APPROVAL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve,
        timeout,
        chatId,
        messageId: msg.message_id,
        toolName,
        baseRows,
      });
    });

    // Crossing the threshold: retro-fit the bulk row onto the earlier prompts
    // that didn't have it yet.
    if (bulkNow && siblings + 1 === BULK_THRESHOLD) {
      await this.refreshBulkRows(chatId, id);
    }

    return promise;
  }

  /** Append the shared bulk Allow/Deny row when enabled. */
  private withBulkRow(
    baseRows: ReturnType<typeof Markup.button.callback>[][],
    enabled: boolean,
  ): ReturnType<typeof Markup.button.callback>[][] {
    if (!enabled) return baseRows;
    return [
      ...baseRows,
      [
        Markup.button.callback("✅✅ Allow all", `${CB_PREFIX}:_all:allowall`),
        Markup.button.callback("❌❌ Deny all", `${CB_PREFIX}:_all:denyall`),
      ],
    ];
  }

  /** Re-render every pending prompt for a chat to (un)show the bulk row. */
  private async refreshBulkRows(chatId: number, exceptId?: string): Promise<void> {
    const enabled =
      [...this.pending.values()].filter((p) => p.chatId === chatId).length >= BULK_THRESHOLD;
    for (const [pid, entry] of this.pending) {
      if (entry.chatId !== chatId || pid === exceptId) continue;
      await this.tg
        .editMessageReplyMarkup(
          chatId,
          entry.messageId,
          undefined,
          Markup.inlineKeyboard(this.withBulkRow(entry.baseRows, enabled)).reply_markup,
        )
        .catch(() => {});
    }
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
    const [, id, action] = data.split(":");

    if (action === "allowall" || action === "denyall") {
      if (chatId === undefined) return "This request has expired.";
      return this.resolveAll(chatId, action === "allowall" ? "allow" : "deny");
    }

    const entry = this.pending.get(id);
    if (!entry) return "This request has expired.";

    clearTimeout(entry.timeout);
    this.pending.delete(id);

    const choice = (action as ApprovalChoice) ?? "deny";
    const label =
      choice === "allow"
        ? "✅ Approved"
        : choice === "always"
          ? `♾️ Always allowing ${entry.toolName}`
          : choice === "alwayscmd"
            ? "♾️ Always allowing that command"
            : "❌ Denied";

    await this.tg
      .editMessageReplyMarkup(entry.chatId, entry.messageId, undefined, undefined)
      .catch(() => {});
    await this.tg
      .sendMessage(entry.chatId, label, { reply_parameters: { message_id: entry.messageId } })
      .catch(() => {});

    entry.resolve(choice);

    // Dropping below the threshold: strip the now-stale bulk row from the rest.
    await this.refreshBulkRows(entry.chatId);
    return label;
  }

  /** Resolve every pending approval for a chat at once (bulk Allow/Deny). */
  private async resolveAll(chatId: number, choice: "allow" | "deny"): Promise<string> {
    const entries = [...this.pending.entries()].filter(([, e]) => e.chatId === chatId);
    if (entries.length === 0) return "No pending requests.";

    for (const [pid, entry] of entries) {
      clearTimeout(entry.timeout);
      this.pending.delete(pid);
      await this.tg
        .editMessageReplyMarkup(entry.chatId, entry.messageId, undefined, undefined)
        .catch(() => {});
      entry.resolve(choice);
    }

    const label =
      choice === "allow"
        ? `✅✅ Approved all ${entries.length}`
        : `❌❌ Denied all ${entries.length}`;
    await this.tg.sendMessage(chatId, label).catch(() => {});
    return label;
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
