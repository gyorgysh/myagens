/**
 * Tool approvals for a turn that has no chat surface to prompt in.
 *
 * `telegram/permissions.ts` owns the real approval promise and mirrors it into
 * the shared `approvalQueue` so the panel can answer it too. With no Telegram
 * bot there is nothing to own that promise, so this class does: same queue,
 * same `/api/approvals/resolve` endpoint, same four choices — the panel is
 * simply the only surface that can answer, instead of one of two.
 *
 * Like the Telegram manager it auto-denies on timeout, so a turn started from
 * the panel and then abandoned can never park forever holding the session busy.
 */

import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { approvalQueue } from "./approvals.js";
import { push } from "./push.js";
import { describeInput, bashLeadCmd, type ApprovalChoice } from "../telegram/permissions.js";
import { log } from "../logger.js";

interface Pending {
  resolve: (choice: ApprovalChoice) => void;
  timeout: NodeJS.Timeout;
}

export class PanelApprovalManager {
  private pending = new Map<string, Pending>();

  /**
   * @param agentId Slot in the shared `approvalQueue`. Defaults to the main
   *   Atlas slot, which is free precisely because no Telegram bot took it.
   */
  constructor(private agentId: string = "main") {
    approvalQueue.attach((id, choice) => this.resolveById(id, choice), this.agentId);
  }

  request(chatId: number, toolName: string, input: unknown): Promise<ApprovalChoice> {
    const id = randomBytes(4).toString("hex");
    const preview = describeInput(toolName, input);
    const lead = toolName === "Bash" ? bashLeadCmd(input) : undefined;

    const promise = new Promise<ApprovalChoice>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        approvalQueue.remove(id);
        log.warn("Approval timed out, auto-denied", { chatId, tool: toolName });
        resolve("deny");
      }, config.APPROVAL_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(id, { resolve, timeout });
    });

    approvalQueue.add({ id, chatId, toolName, preview, lead, ts: Date.now(), agentId: this.agentId });

    // The panel is the only place this can be answered, so the browser nudge
    // matters more here than it does when a Telegram message also arrives.
    void push.notify({
      title: "Approval needed",
      body: `${toolName}: ${preview}`,
      kind: "approval",
      tag: "approval",
      url: "/",
    });

    return promise;
  }

  private resolveById(id: string, choice: ApprovalChoice): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(id);
    approvalQueue.remove(id);
    entry.resolve(choice);
    return true;
  }
}
