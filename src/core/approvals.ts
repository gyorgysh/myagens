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
  /** Which PermissionManager owns this request — "main" (Atlas) or a Lead's
   *  worker id — so `resolve()` can route a panel action back to the right
   *  instance. Omitted defaults to "main" for backward compatibility. */
  agentId?: string;
  /** Display name for the owning agent, e.g. "Iris", for the panel to label
   *  approvals when several bots have requests pending at once. */
  agentName?: string;
}

type Broadcaster = (msg: unknown) => void;
type Resolver = (id: string, choice: ApprovalChoice) => boolean;

const MAIN_AGENT = "main";

/**
 * Singleton queue that mirrors every pending PermissionManager approval into
 * the panel WebSocket stream, and lets the panel resolve those same promises.
 *
 * Multiple PermissionManager instances can be live at once (the main bot, plus
 * one per Lead bot with a real approval flow) — each `attach()`es its own
 * resolver under a distinct `agentId` rather than sharing one slot, so a Lead
 * bot's PermissionManager can't clobber the main bot's wiring (and vice
 * versa). `resolve()` looks up which agent owns the pending id and routes to
 * that resolver.
 */
class ApprovalQueue {
  private pending = new Map<string, ApprovalView>();
  private broadcast: Broadcaster = () => {};
  private resolvers = new Map<string, Resolver>();

  /** Wire the panel hub broadcaster. Called from startPanel(). */
  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  /** Wire a PermissionManager's resolveById, scoped to its own agent id.
   *  Called from the constructor. Defaults to the main bot's slot. */
  attach(resolver: Resolver, agentId: string = MAIN_AGENT): void {
    this.resolvers.set(agentId, resolver);
  }

  /** Unwire an agent's resolver (e.g. when its bot instance is torn down). */
  detach(agentId: string): void {
    this.resolvers.delete(agentId);
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
   * Resolve a pending approval from the panel. Delegates to the owning
   * PermissionManager (found via the pending view's agentId) so the same
   * promise that the Telegram buttons settle is resolved here too. Returns
   * false when the id is unknown, already settled, or action is invalid.
   */
  resolve(id: string, choice: string): boolean {
    if (!APPROVAL_ACTIONS.has(choice)) return false;
    const view = this.pending.get(id);
    if (!view) return false;
    const resolver = this.resolvers.get(view.agentId ?? MAIN_AGENT);
    if (!resolver) return false;
    return resolver(id, choice as ApprovalChoice);
  }

  private emit(): void {
    this.broadcast({ type: "approvals", approvals: this.list() });
  }
}

export const approvalQueue = new ApprovalQueue();
