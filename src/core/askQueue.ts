/**
 * AskQueue — mirrors pending AskUserQuestion prompts into the panel WebSocket
 * stream and lets the panel answer them, settling the *same* promise the
 * Telegram inline buttons settle. This is the AskUserQuestion analogue of
 * `approvalQueue` (see approvals.ts): the `AskQuestionManager` (Telegram) owns
 * the real pending state and the blocking promise; this queue is a thin,
 * serializable mirror so the President can answer from the browser too.
 *
 * Whichever surface answers first wins; the manager clears the question from
 * both. Every question is tagged with `agentId` (undefined for Atlas's own
 * shared chat, a worker/Lead id otherwise) so each chat pane can show only
 * the questions that belong to it.
 */

/** One option of a mirrored question, safe to send over the wire. */
export interface AskOptionView {
  label: string;
  description?: string;
}

/** Serializable snapshot of one pending question. */
export interface AskQuestionView {
  id: string;
  chatId: number;
  /** Owning worker/Lead id; undefined means Atlas's shared main chat. */
  agentId?: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOptionView[];
  ts: number;
}

type Broadcaster = (msg: unknown) => void;

/**
 * Resolve a pending question from the panel. `optionIndices` answers by tapping
 * option buttons (one for single-select, any number for multiSelect); `text`
 * answers the "Other" free-text path. Returns false when the id is unknown or
 * the answer is empty/invalid.
 */
type Resolver = (id: string, answer: { optionIndices?: number[]; text?: string }) => boolean;

class AskQueue {
  private pending = new Map<string, AskQuestionView>();
  private broadcast: Broadcaster = () => {};
  /** One resolver per AskQuestionManager (main bot + each Lead bot). */
  private resolvers = new Set<Resolver>();

  /** Wire the panel hub broadcaster. Called from startPanel(). */
  start(broadcast: Broadcaster): void {
    this.broadcast = broadcast;
  }

  /**
   * Register an AskQuestionManager's panel resolver. Multiple managers exist
   * (main bot + each Lead bot); resolve() tries each until one owns the id.
   */
  attach(resolver: Resolver): void {
    this.resolvers.add(resolver);
  }

  /** Add a question to the queue and broadcast the updated list. */
  add(view: AskQuestionView): void {
    this.pending.set(view.id, view);
    this.emit();
  }

  /** Remove a settled question and broadcast the updated list. */
  remove(id: string): void {
    if (this.pending.delete(id)) this.emit();
  }

  /** All currently pending questions, oldest first (asked in order). */
  list(): AskQuestionView[] {
    return [...this.pending.values()].sort((a, b) => a.ts - b.ts);
  }

  /**
   * Resolve a pending question from the panel. Delegates to the
   * AskQuestionManager so the same promise the Telegram buttons settle is
   * resolved here too. Returns false when unresolvable.
   */
  resolve(id: string, answer: { optionIndices?: number[]; text?: string }): boolean {
    if (!this.pending.has(id)) return false;
    for (const r of this.resolvers) {
      if (r(id, answer)) return true;
    }
    return false;
  }

  private emit(): void {
    this.broadcast({ type: "asks", asks: this.list() });
  }
}

export const askQueue = new AskQueue();
