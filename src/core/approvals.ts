import type { ApprovalChoice } from "../telegram/permissions.js";

export type { ApprovalChoice };

/** The set of actions the panel is allowed to post to /api/approvals/resolve. */
export const APPROVAL_ACTIONS: ReadonlySet<string> = new Set<ApprovalChoice>([
  "allow",
  "deny",
  "always",
  "alwayscmd",
]);

/** Serializable snapshot of one pending approval, safe to send over the wire. */
export interface ApprovalView {
  id: string;
  chatId: number;
  toolName: string;
  preview: string;
  lead?: string;
  ts: number;
}

type Broadcaster = (msg: unknown) => void;
type Resolver = (id: string, choice: ApprovalChoice) => boolean;

/**
 * Singleton queue that mirrors every pending PermissionManager approval into
 * the panel WebSocket stream, and lets the panel resolve those same promises.
 */
class ApprovalQueue {
  private pending = new Map<string, ApprovalView>();
  private broadcast: Broadcaster = () => {};
  private resolver: Resolver | null = null;

  /** Wire the panel hub broadcaster. Called from startPanel(). */
  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  /** Wire the PermissionManager's resolveById. Called from the constructor. */
  attach(resolver: Resolver): void {
    this.resolver = resolver;
  }

  /** Add an approval to the queue and broadcast the updated list. */
  add(view: ApprovalView): void {
    this.pending.set(view.id, view);
    this.emit();
  }

  /** Remove a settled approval and broadcast the updated list. */
  remove(id: string): void {
    this.pending.delete(id);
    this.emit();
  }

  /** All currently pending approvals, newest first. */
  list(): ApprovalView[] {
    return [...this.pending.values()].sort((a, b) => b.ts - a.ts);
  }

  /**
   * Resolve a pending approval from the panel. Delegates to the PermissionManager
   * so the same promise that the Telegram buttons settle is resolved here too.
   * Returns false when the id is unknown, already settled, or action is invalid.
   */
  resolve(id: string, choice: string): boolean {
    if (!APPROVAL_ACTIONS.has(choice)) return false;
    if (!this.resolver) return false;
    return this.resolver(id, choice as ApprovalChoice);
  }

  private emit(): void {
    this.broadcast({ type: "approvals", approvals: this.list() });
  }
}

export const approvalQueue = new ApprovalQueue();
