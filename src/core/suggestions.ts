import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";
import { createTask } from "./tasks.js";
import { taskDelegator } from "./taskRunner.js";
import { workers, type Worker } from "./workers.js";

const FILE = "suggestions.json";

export type SuggestionStatus = "pending" | "accepted" | "dismissed";

/**
 * A proposal/idea/finding filed by an agent (Lead, Assistant, specialist) for
 * the president's review. Unlike crew_report, suggestions are NOT pushed to the
 * president directly: they queue in this inbox so Atlas can triage them and the
 * president decides (accept → Kanban card, or dismiss) in one place.
 */
export interface Suggestion {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  title: string;
  detail: string;
  category?: string;
  status: SuggestionStatus;
  createdAt: number;
  decidedAt?: number;
  /** Kanban card id created when the suggestion was accepted. */
  taskId?: string;
}

interface SuggestionFile {
  version: 1;
  suggestions: Suggestion[];
}

export interface SuggestionInput {
  fromAgentId: string;
  fromAgentName: string;
  title: string;
  detail: string;
  category?: string;
}

type ChangeCb = () => void;
type NotifyCb = (s: Suggestion) => void;

/**
 * The president's suggestion inbox. Singleton + JSON-store pattern, mirroring
 * WorkerManager / MemoryStore. Persists to suggestions.json in the data dir.
 */
class SuggestionStore {
  private items: Suggestion[] = loadJson<SuggestionFile>(FILE, {
    version: 1,
    suggestions: [],
  }).suggestions;
  private onChangeCb?: ChangeCb;
  private onAddCb?: NotifyCb;

  /** Notify a watcher (panel hub) on any mutation. */
  onChange(cb: ChangeCb): void {
    this.onChangeCb = cb;
  }

  /** Register a Telegram notifier, called once when a new suggestion is filed. */
  onAdd(cb: NotifyCb): void {
    this.onAddCb = cb;
  }

  private persist(): void {
    saveJson<SuggestionFile>(FILE, { version: 1, suggestions: this.items });
    this.onChangeCb?.();
  }

  /** File a new suggestion (always starts pending). */
  add(input: SuggestionInput): Suggestion {
    const s: Suggestion = {
      id: randomBytes(4).toString("hex"),
      fromAgentId: input.fromAgentId,
      fromAgentName: input.fromAgentName || input.fromAgentId,
      title: input.title.trim() || "Untitled",
      detail: input.detail.trim(),
      category: input.category?.trim() || undefined,
      status: "pending",
      createdAt: Date.now(),
    };
    this.items.push(s);
    this.persist();
    audit("suggestion.add", { id: s.id, from: s.fromAgentId });
    this.onAddCb?.(s);
    return s;
  }

  /** All suggestions, newest first, optionally filtered by status. */
  list(status?: SuggestionStatus): Suggestion[] {
    const all = [...this.items].sort((a, b) => b.createdAt - a.createdAt);
    return status ? all.filter((s) => s.status === status) : all;
  }

  /** Pending suggestions, oldest first (so the digest reads chronologically). */
  pending(): Suggestion[] {
    return this.items.filter((s) => s.status === "pending").sort((a, b) => a.createdAt - b.createdAt);
  }

  pendingCount(): number {
    return this.items.reduce((n, s) => n + (s.status === "pending" ? 1 : 0), 0);
  }

  get(id: string): Suggestion | undefined {
    return this.items.find((s) => s.id === id);
  }

  /** Create the backlog card for a pending suggestion and mark it accepted.
   *  Returns the new task id, or undefined if the suggestion can't be accepted. */
  private fileCard(s: Suggestion): string | undefined {
    if (s.status !== "pending") return undefined;
    const task = createTask({
      title: s.title,
      notes: [s.detail, `— suggested by ${s.fromAgentName}`].filter(Boolean).join("\n\n"),
      column: "backlog",
    });
    s.status = "accepted";
    s.decidedAt = Date.now();
    s.taskId = task.id;
    return task.id;
  }

  /**
   * Accept (park) a pending suggestion: file it as a Kanban backlog card and mark
   * it accepted. No-op if already decided. Returns the updated suggestion.
   */
  accept(id: string): Suggestion | undefined {
    const s = this.get(id);
    if (!s || s.status !== "pending") return s;
    const taskId = this.fileCard(s);
    this.persist();
    audit("suggestion.accept", { id, taskId });
    return s;
  }

  /**
   * Accept AND immediately delegate a pending suggestion: file the card, route it
   * to the most relevant Lead (or a generic run when none fits), and kick off an
   * autonomous run that does the work, moves the card to done, and reports back.
   * Returns the updated suggestion plus the routed Lead's display name (if any).
   *
   * Pass `leadId` to force the run to a specific enabled Lead (the "delegate as
   * Iris" path), overriding the automatic routing. An unknown/disabled id falls
   * back to auto-routing.
   */
  delegate(id: string, leadId?: string): { suggestion?: Suggestion; leadName?: string; started: boolean } {
    const s = this.get(id);
    if (!s) return { started: false };
    if (s.status !== "pending") return { suggestion: s, started: false };
    const taskId = this.fileCard(s);
    this.persist();
    if (!taskId) return { suggestion: s, started: false };
    let lead: Worker | undefined;
    if (leadId) {
      const chosen = workers.get(leadId);
      if (chosen && chosen.role === "lead" && chosen.enabled) lead = chosen;
    }
    if (!lead) lead = workers.routeFor({ fromAgentId: s.fromAgentId, category: s.category, title: s.title });
    const res = taskDelegator.delegate(taskId, lead?.id);
    audit("suggestion.delegate", { id, taskId, leadId: lead?.id, ok: res.ok });
    return { suggestion: s, leadName: lead?.name, started: res.ok };
  }

  /** Dismiss (archive) a pending suggestion. No-op if already decided. */
  dismiss(id: string): Suggestion | undefined {
    const s = this.get(id);
    if (!s || s.status !== "pending") return s;
    s.status = "dismissed";
    s.decidedAt = Date.now();
    this.persist();
    audit("suggestion.dismiss", { id });
    return s;
  }
}

export const suggestions = new SuggestionStore();
