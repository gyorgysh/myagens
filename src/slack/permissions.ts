import { randomBytes } from "node:crypto";
import { type WebClient } from "@slack/web-api";
import { approvalQueue, type ApprovalChoice } from "../core/approvals.js";
import { bashLeadCmd } from "../telegram/permissions.js";
import { summarizeInput } from "../telegram/formatting.js";
import { config } from "../config.js";

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
      return;
    }
    const match = actionId.match(/^approval_([^_]+)_(.+)$/);
    if (!match) return;
    const [, id, choiceStr] = match;
    this.resolveById(id, choiceStr as ApprovalChoice);
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
      throw err;
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

    return blocks;
  }
}
