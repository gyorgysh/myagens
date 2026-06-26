import { createHash } from "node:crypto";

/**
 * Per-turn agentic loop detector.
 *
 * The model sometimes gets stuck firing the *same* tool call over and over
 * (a failing command it keeps retrying, a Read of a missing file, …). Left
 * unattended that burns tokens for as long as the turn runs. This tracks a hash
 * of (tool name + input) for the lifetime of one turn and reports how many times
 * each distinct call has been seen, so the caller can pause and ask the user
 * once a call crosses a threshold.
 *
 * One instance per turn — counts must not leak across unrelated requests.
 */
export class LoopDetector {
  /** hash -> times this exact call has been recorded this turn. */
  private counts = new Map<string, number>();
  /** Hashes the user chose to "Continue" — never prompt for these again. */
  private silenced = new Set<string>();

  /**
   * @param threshold repeat count at which a call is considered a loop. 0 (or
   *   below) disables detection entirely.
   */
  constructor(private readonly threshold: number) {}

  /** Whether loop detection is active at all. */
  get enabled(): boolean {
    return this.threshold > 0;
  }

  /** Stable hash of a tool call, so identical (name + input) pairs collide. */
  static hash(toolName: string, input: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(input ?? null);
    } catch {
      // Circular / non-serializable input: fall back to a coarse string form.
      serialized = String(input);
    }
    return createHash("sha1").update(`${toolName}\u0000${serialized}`).digest("hex");
  }

  /**
   * Record a tool call and decide whether it now looks like a loop the user
   * should be asked about.
   *
   * @returns the running count for this exact call, and whether it just crossed
   *   the threshold (and hasn't been silenced via "Continue").
   */
  record(toolName: string, input: unknown): { hash: string; count: number; isLoop: boolean } {
    const hash = LoopDetector.hash(toolName, input);
    const count = (this.counts.get(hash) ?? 0) + 1;
    this.counts.set(hash, count);
    const isLoop = this.enabled && !this.silenced.has(hash) && count >= this.threshold;
    return { hash, count, isLoop };
  }

  /**
   * "Approve once": let this call through but keep watching. We pull the counter
   * back to threshold-1 so the *next* repeat trips the prompt again.
   */
  approveOnce(hash: string): void {
    this.counts.set(hash, Math.max(0, this.threshold - 1));
  }

  /** "Continue": stop prompting for this exact call for the rest of the turn. */
  silence(hash: string): void {
    this.silenced.add(hash);
  }
}
