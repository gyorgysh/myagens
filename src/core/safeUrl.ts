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
  const lower = ip.toLowerCase();
  // fe80::/10 link-local.
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
    return true;
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
