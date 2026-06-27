import { log } from "../logger.js";

/**
 * Shared validation for Telegram `callback_data` strings.
 *
 * Every inline-button handler manually `split(":")`s the callback payload. A
 * malformed callback (missing segments, junk, oversized data — Telegram caps
 * `callback_data` at 64 bytes but a crafted client could send more) would
 * otherwise lead to undefined-access or silent wrong routing. These helpers
 * validate the structure *before* dispatch and validate embedded ids against
 * their expected format before they reach any lookup.
 */

/** Telegram's hard limit on callback_data length, in bytes. */
export const CALLBACK_MAX_BYTES = 64;

/** 8-char lowercase hex, the shape of task/run ids (`randomBytes(4).toString("hex")`). */
const HEX8 = /^[0-9a-f]{8}$/;

/** True when an id matches the 8-char hex shape used for task/run ids. */
export function isHexId(id: string): boolean {
  return HEX8.test(id);
}

/**
 * Parse a namespaced callback into exactly `expectedParts` colon-separated
 * segments after the prefix. Returns the segments on success, or `null` when
 * the payload doesn't start with the prefix, is oversized, or has the wrong
 * segment count. The prefix itself is NOT included in the returned array.
 *
 * Example: `parseCallback("task:retry:a1b2c3d4", "task:", 2)`
 *   → `["retry", "a1b2c3d4"]`.
 */
export function parseCallback(data: string, prefix: string, expectedParts: number): string[] | null {
  if (typeof data !== "string") return null;
  if (Buffer.byteLength(data, "utf8") > CALLBACK_MAX_BYTES) {
    log.warn("Oversized callback_data rejected", { len: data.length, prefix });
    return null;
  }
  if (!data.startsWith(prefix)) return null;
  const rest = data.slice(prefix.length);
  const parts = rest.split(":");
  if (parts.length !== expectedParts) {
    log.debug("Malformed callback_data rejected", { prefix, got: parts.length, want: expectedParts });
    return null;
  }
  if (parts.some((p) => p.length === 0)) return null;
  return parts;
}

/**
 * Assert a built callback_data string fits Telegram's 64-byte limit. Logs and
 * returns false when it doesn't, so button builders can guard before sending a
 * payload Telegram would silently reject.
 */
export function callbackFits(data: string): boolean {
  const ok = Buffer.byteLength(data, "utf8") <= CALLBACK_MAX_BYTES;
  if (!ok) log.warn("callback_data exceeds 64-byte limit", { len: Buffer.byteLength(data, "utf8"), data });
  return ok;
}
