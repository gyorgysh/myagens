import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound-URL guard for server-side fetches (SSRF mitigation, SEC-5).
 *
 * The panel and embedding clients fetch user-supplied endpoints server-side
 * (model listing, embeddings). Those legitimately target *local* model servers
 * (LM Studio :1234, Ollama :11434), so we deliberately allow loopback and
 * private LAN ranges — blanket-blocking them would break the core local-model
 * feature. What we DO block is:
 *   - non-http(s) schemes (file:, gopher:, etc.),
 *   - the cloud metadata address 169.254.169.254 and the rest of the
 *     link-local 169.254.0.0/16 block (the classic SSRF target for stealing
 *     instance credentials on AWS/GCP/Azure),
 *   - IPv6 link-local (fe80::/10) and the IPv4-mapped/translated forms of the
 *     metadata address.
 * Hostnames are resolved first so a name pointing at a blocked IP is caught.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/** True if an IP literal (v4 or v6) is in a blocked range. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return false;
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  // 169.254.0.0/16 — link-local, includes the 169.254.169.254 metadata IP.
  if (a === 169 && b === 254) return true;
  return false;
}

function isBlockedV6(ip: string): boolean {
  let lower = ip.toLowerCase();
  // Strip a zone id (e.g. fe80::1%eth0) before range checks.
  const pct = lower.indexOf("%");
  if (pct >= 0) lower = lower.slice(0, pct);
  // fe80::/10 link-local. The /10 prefix means the first 10 bits are fixed:
  // 1111 1110 10xx xxxx, so the first hextet is 0xfe80..0xfebf. Match on the
  // numeric value of the first hextet rather than a string prefix, so short
  // forms like `fe80::1` (and any spacing/leading-zero variant) are caught.
  const firstHextet = lower.split(":")[0];
  if (firstHextet) {
    const n = parseInt(firstHextet, 16);
    if (!Number.isNaN(n) && n >= 0xfe80 && n <= 0xfebf) return true;
  }
  // IPv4-mapped/embedded form of the metadata address (::ffff:169.254.169.254).
  if (lower.includes("169.254.169.254")) return true;
  if (lower.includes("a9fe")) return true; // 0xa9fe == 169.254 (compressed hex form)
  return false;
}

/**
 * Validate a URL for a server-side fetch. Throws {@link BlockedUrlError} when
 * the scheme is not http(s) or the host resolves to a blocked address.
 * Returns the parsed URL on success.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BlockedUrlError(`unsupported URL scheme: ${url.protocol}`);

  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // If the host is an IP literal, check it directly.
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new BlockedUrlError(`blocked address: ${host}`);
    return url;
  }
  // Otherwise resolve the name and check every returned address, so a hostname
  // that points at a blocked IP (DNS rebinding to metadata) is rejected too.
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    // Let the actual fetch surface the DNS failure with its own error.
    return url;
  }
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new BlockedUrlError(`blocked address: ${host} -> ${address}`);
  }
  return url;
}

/**
 * SSRF-safe `fetch`. Every server-side outbound request built from a
 * user-supplied URL must go through this rather than calling `fetch` directly.
 *
 * `assertSafeUrl()` resolves DNS once at validation time, but an attacker who
 * controls the name's DNS can flip the answer between that check and the actual
 * socket connect (DNS rebinding / TOCTOU), reaching a blocked IP such as the
 * 169.254.169.254 metadata service. To shrink that window to nothing, this
 * **re-resolves the host and re-validates every returned address immediately
 * before issuing the fetch**, then pins the connection to a just-validated IP
 * by rewriting the URL to that IP literal while preserving the original
 * hostname in the `Host` header — so the kernel connects to an address we
 * actually checked, not a fresh (possibly rebound) one.
 *
 * Pinning is only applied to **http** targets (where a Host header is enough);
 * for **https** the IP swap would break SNI/cert validation, so there we re-
 * resolve+re-validate (closing all but a sub-millisecond window) and connect by
 * name. IP-literal targets (and loopback/private LAN local model servers) are
 * already exact, so they skip the pin.
 */
export async function safeFetch(raw: string, init?: RequestInit): Promise<Response> {
  const url = await assertSafeUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");

  // IP literal: nothing to rebind, assertSafeUrl already checked the address.
  if (isIP(host)) return fetch(url, init);

  // Re-resolve right before connecting and re-validate every address.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    // DNS failed now; let fetch surface the real error (no rebinding possible).
    return fetch(url, init);
  }
  let pinned: { address: string; family: number } | undefined;
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new BlockedUrlError(`blocked address: ${host} -> ${a.address}`);
    // Prefer IPv4 over IPv6 when both are available: local model servers
    // (Ollama, LM Studio) typically bind only to 127.0.0.1, and pinning to
    // ::1 would cause ECONNREFUSED even though the service is running.
    if (!pinned || (pinned.family === 6 && a.family === 4)) pinned = a;
  }
  if (!pinned) return fetch(url, init);

  // For plain http, pin by connecting to the validated IP literal and keeping
  // the real hostname in the Host header. For https we can't swap the host
  // without breaking SNI/cert checks, so connect by name (re-validated above).
  if (url.protocol === "http:") {
    const pinnedUrl = new URL(url);
    pinnedUrl.hostname = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
    const headers = new Headers(init?.headers);
    if (!headers.has("host")) headers.set("host", url.host);
    return fetch(pinnedUrl, { ...init, headers });
  }
  return fetch(url, init);
}
