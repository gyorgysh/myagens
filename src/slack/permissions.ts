import { randomBytes } from "node:crypto";
import { type WebClient } from "@slack/web-api";
import { approvalQueue, type ApprovalChoice } from "../core/approvals.js";
import { bashLeadCmd } from "../telegram/permissions.js";
import { summarizeInput } from "../telegram/formatting.js";
import { config } from "../config.js";
import { log } from "../logger.js";

interface PendingApproval {
  id: string;
  resolve: (choice: ApprovalChoice) => void;
  timeout: NodeJS.Timeout;
  channel: string;
  toolName: string;
  input: Record<string, unknown>;
  lead?: string;
  settled?: ApprovalChoice;
}

interface Batch {
  channel: string;
  ids: string[];
  ts?: string;
  sending?: boolean;
  flushTimer?: NodeJS.Timeout;
  openedAt: number;
}

const COALESCE_WINDOW_MS = 300;
const COALESCE_MAX_MS = 1200;

export class SlackPermissionManager {
  private pending = new Map<string, PendingApproval>();
  private batches = new Map<string, Batch>();

  constructor(
    private web: WebClient,
    private allowedUserIds: Set<string>
  ) {
    approvalQueue.attach((id, choice) => this.resolveById(id, choice), "slack");
  }

  public get webClient(): WebClient {
    return this.web;
  }


  async request(channel: string, toolName: string, input: Record<string, unknown>): Promise<ApprovalChoice> {
    const id = randomBytes(8).toString("hex");
    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;

    const promise = new Promise<ApprovalChoice>((resolve) => {
      const timeout = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry || entry.settled) return;
        entry.settled = "deny";
        approvalQueue.remove(id);
        resolve("deny");
        void this.afterSettle(channel);
      }, config.APPROVAL_TIMEOUT_MS || 300000);

      this.pending.set(id, { id, resolve, timeout, channel, toolName, input, lead });
    });

    const previewText = this.describeInput(input);

    approvalQueue.add({
      id,
      chatId: 0,
      toolName,
      preview: previewText,
      lead,
      ts: Date.now(),
      agentId: "slack"
    });

    let batch = this.batches.get(channel);
    if (!batch) {
      batch = { channel, ids: [], openedAt: Date.now() };
      this.batches.set(channel, batch);
    }
    batch.ids.push(id);

    if (batch.ts === undefined) {
      if (batch.flushTimer) clearTimeout(batch.flushTimer);
      const elapsed = Date.now() - batch.openedAt;
      const delay = Math.min(COALESCE_WINDOW_MS, Math.max(0, COALESCE_MAX_MS - elapsed));
      batch.flushTimer = setTimeout(() => void this.flush(channel), delay);
    } else {
      await this.render(batch);
    }

    return promise;
  }

  private describeInput(input: Record<string, unknown>): string {
    let text = summarizeInput(input).replace(/<[^>]+>/g, "");
    if (!text) {
      text = JSON.stringify(input, null, 2) || "";
    }
    return text.length > 200 ? text.slice(0, 200) + "…(truncated)" : text;
  }

  resolveById(id: string, choice: ApprovalChoice): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return false;

    clearTimeout(entry.timeout);
    entry.settled = choice;
    approvalQueue.remove(id);
    entry.resolve(choice);

    void this.afterSettle(entry.channel);
    return true;
  }

  handleAction(actionId: string, userId: string): void {
    if (!this.allowedUserIds.has(userId)) {
      log.warn("Approval button ignored: user not allowed (Slack)", { userId, actionId });
      return;
    }
    const match = actionId.match(/^approval_([^_]+)_(.+)$/);
    if (!match) {
      log.warn("Approval button ignored: unrecognised action id (Slack)", { actionId });
      return;
    }
    const [, id, choiceStr] = match;
    if (!this.resolveById(id, choiceStr as ApprovalChoice)) {
      log.warn("Approval button ignored: request no longer pending (Slack)", { actionId, id });
    }
  }

  /** Whether any approval in this channel is still waiting on the user. */
  hasPending(channel: string): boolean {
    return this.livePending(channel).length > 0;
  }

  /** Tool name of the oldest approval awaiting the user in this channel. */
  pendingTool(channel: string): string | undefined {
    return this.livePending(channel)[0]?.toolName;
  }

  /**
   * Consume a typed reply as an approval decision. Buttons only reach us when
   * the Slack app has Interactivity enabled, so a typed `yes`/`no` is the
   * fallback that keeps an approval from wedging the turn. `allow all` /
   * `deny all` settle every open request at once; a bare decision settles the
   * oldest one. Returns the number settled, or undefined when the text is not
   * a decision at all (so the caller can treat it as a normal message).
   */
  answerTyped(channel: string, text: string): number | undefined {
    const raw = text.trim().toLowerCase().replace(/[.!]+$/, "");
    const all = /\s+all$/.test(raw);
    const word = raw.replace(/\s+all$/, "").trim();

    let choice: ApprovalChoice | undefined;
    if (["y", "yes", "ok", "okay", "allow", "approve", "approved"].includes(word)) choice = "allow";
    else if (["n", "no", "deny", "reject", "cancel"].includes(word)) choice = "deny";
    else if (["always", "always allow"].includes(word)) choice = "always";
    if (!choice) return undefined;

    const live = this.livePending(channel);
    if (live.length === 0) return undefined;

    const targets = all ? live : [live[0]];
    for (const e of targets) this.resolveById(e.id, choice);
    log.info("Approval answered by typed reply (Slack)", { channel, choice, count: targets.length });
    return targets.length;
  }

  /**
   * Deny every approval pending in a channel, unblocking the turn waiting on
   * them. Used by the stop command: aborting the SDK run does not settle a canUseTool
   * promise, so without this the session can stay busy forever. Returns how
   * many were cancelled.
   */
  cancelAll(channel: string): number {
    const live = this.livePending(channel);
    for (const e of live) this.resolveById(e.id, "deny");
    if (live.length > 0) log.info("Pending approvals cancelled (Slack)", { channel, count: live.length });
    return live.length;
  }

  /** Unsettled approvals for a channel, oldest first. */
  private livePending(channel: string): PendingApproval[] {
    return [...this.pending.values()].filter((e) => e.channel === channel && !e.settled);
  }

  destroy(): void {
    approvalQueue.detach("slack");
  }

  private async flush(channel: string): Promise<void> {
    const batch = this.batches.get(channel);
    if (!batch || batch.ts !== undefined || batch.sending) return;
    
    batch.flushTimer = undefined;
    const live = batch.ids.filter((id) => this.pending.get(id) && !this.pending.get(id)!.settled);
    if (live.length === 0) {
      this.batches.delete(channel);
      return;
    }
    
    batch.sending = true;
    try {
      const resp = await this.web.chat.postMessage({
        channel,
        text: "Approval needed",
        blocks: this.buildBlocks(batch)
      });
      batch.ts = resp.ts as string;
    } catch (err) {
      batch.sending = false;
      // Nobody can answer a request that was never posted, and this runs from a
      // timer, so throwing would only surface as an unhandled rejection while
      // the turn stayed parked on the promise. Deny instead: the model gets a
      // refusal it can report, and the session comes unstuck.
      log.error("Approval message send failed (Slack), denying the batch", {
        channel,
        count: live.length,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const id of live) this.resolveById(id, "deny");
      return;
    }
    batch.sending = false;
  }

  private async render(batch: Batch): Promise<void> {
    if (batch.ts === undefined) return;
    await this.web.chat.update({
      channel: batch.channel,
      ts: batch.ts,
      text: "Approval update",
      blocks: this.buildBlocks(batch)
    }).catch(() => {});
  }

  private async afterSettle(channel: string): Promise<void> {
    const batch = this.batches.get(channel);
    if (!batch) return;
    const entries = batch.ids.map((id) => this.pending.get(id)).filter(Boolean) as PendingApproval[];
    const allSettled = entries.every((e) => e.settled);

    if (!allSettled) {
      await this.render(batch);
      return;
    }

    if (batch.ts !== undefined) {
      await this.web.chat.update({
        channel,
        ts: batch.ts,
        text: "Approval resolved",
        blocks: this.buildBlocks(batch)
      }).catch(() => {});
    }

    for (const id of batch.ids) this.pending.delete(id);
    if (batch.flushTimer) clearTimeout(batch.flushTimer);
    this.batches.delete(channel);
  }

  private buildBlocks(batch: Batch): any[] {
    const blocks: any[] = [];
    const entries = batch.ids.map((id) => this.pending.get(id)).filter(Boolean) as PendingApproval[];

    for (const e of entries) {
      const previewText = this.describeInput(e.input);
      let text = `*${e.toolName}*\n\`\`\`${previewText}\`\`\``;

      if (e.settled) {
        const mark = (e.settled === "deny") ? " ❌" : " ✅";
        if (e.settled === "deny") {
          text = `~*${e.toolName}*~\n~\`\`\`${previewText}\`\`\`~${mark}`;
        } else {
          text = `*${e.toolName}*${mark}\n\`\`\`${previewText}\`\`\``;
        }
      }

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text
        }
      });

      if (!e.settled) {
        const elements: any[] = [
          {
            type: "button",
            text: { type: "plain_text", text: "Allow" },
            style: "primary",
            value: "allow",
            action_id: `approval_${e.id}_allow`
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            value: "deny",
            action_id: `approval_${e.id}_deny`
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Always" },
            value: "always",
            action_id: `approval_${e.id}_always`
          }
        ];

        if (e.toolName === "Bash") {
          elements.push({
            type: "button",
            text: { type: "plain_text", text: "Always this cmd" },
            value: "alwayscmd",
            action_id: `approval_${e.id}_alwayscmd`
          });
        }

        blocks.push({
          type: "actions",
          elements
        });
      }
    }

    // Typed fallback, spelled out on the message itself: the buttons only fire
    // when the Slack app has Interactivity enabled, and an approval nobody can
    // settle blocks the turn and leaves the session busy.
    if (entries.some((e) => !e.settled)) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Or reply `yes` / `no` / `always` (add ` all` for every request above) · `!stop` to abort.",
          },
        ],
      });
    }

    return blocks;
  }
}
