/**
 * Per-key token-bucket rate limiter (SEC: per-user turn rate limit).
 *
 * Even an allow-listed user can otherwise spawn unbounded concurrent turns by
 * messaging faster than one finishes (the session `busy` flag only blocks a
 * second turn *while one is in progress* — a rapid dismiss+re-message or a burst
 * of voice notes slips past it). This caps how many new turns a single chat can
 * start in a rolling window: each chat gets `capacity` tokens that refill at a
 * steady rate, and a turn only starts if a token is available.
 */
export class TokenBucketLimiter {
  private readonly capacity: number;
  /** Tokens replenished per millisecond. */
  private readonly refillPerMs: number;
  private readonly buckets = new Map<number, { tokens: number; last: number }>();

  /**
   * @param capacity   max burst (and steady-state count) of turns per window.
   * @param windowMs   window over which `capacity` tokens fully refill.
   */
  constructor(capacity: number, windowMs: number) {
    this.capacity = Math.max(1, capacity);
    this.refillPerMs = this.capacity / Math.max(1, windowMs);
  }

  /**
   * Attempt to consume one token for `key`. Returns true if allowed (token
   * spent), false if the bucket is empty (rate exceeded).
   */
  tryConsume(key: number): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    } else {
      const elapsed = now - b.last;
      if (elapsed > 0) {
        b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerMs);
        b.last = now;
      }
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until at least one token is available again for `key`. */
  retryAfterMs(key: number): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / this.refillPerMs);
  }
}
