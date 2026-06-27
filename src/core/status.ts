import { listProviders, type Provider } from "./providers.js";
import { probeProviderModels } from "./providerModels.js";
import { resolveSecret } from "./vault.js";
import { BlockedUrlError } from "./safeUrl.js";

const TIMEOUT_MS = 6000;

/** Public Anthropic/Claude status page (Statuspage.io). Needs no credentials. */
const CLAUDE_STATUS_URL = "https://status.claude.com";

export interface ServiceStatus {
  indicator: "none" | "minor" | "major" | "critical" | "unknown";
  description: string;
  url: string;
  error?: string;
}

/** Health of one model backend the bot can talk to. */
export interface BackendStatus {
  id: string;
  name: string;
  kind: "anthropic" | "provider" | "local";
  baseUrl: string;
  /** Endpoint answered at all (vs. network/DNS failure). */
  reachable: boolean;
  /** Credentials accepted (where checkable). */
  authOk: boolean;
  models: string[];
  error?: string;
}

export interface StatusSnapshot {
  checkedAt: number;
  /** Public Claude service status (no credentials required). */
  service: ServiceStatus;
  backends: BackendStatus[];
}

/** Fetch the public Claude status page's overall indicator. */
async function checkClaudeService(): Promise<ServiceStatus> {
  const out: ServiceStatus = { indicator: "unknown", description: "", url: CLAUDE_STATUS_URL };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CLAUDE_STATUS_URL}/api/v2/status.json`, { signal: ctrl.signal });
    if (!res.ok) {
      out.error = `HTTP ${res.status}`;
      return out;
    }
    const json = (await res.json()) as { status?: { indicator?: string; description?: string } };
    const ind = json.status?.indicator;
    out.indicator =
      ind === "none" || ind === "minor" || ind === "major" || ind === "critical" ? ind : "unknown";
    out.description = json.status?.description ?? "";
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/** Well-known local backends to surface when running but not configured. */
const KNOWN_LOCAL: Array<{ name: string; baseUrl: string }> = [
  { name: "LM Studio", baseUrl: "http://localhost:1234" },
  { name: "Ollama", baseUrl: "http://localhost:11434" },
];

async function checkProvider(p: Provider): Promise<BackendStatus> {
  const out: BackendStatus = {
    id: p.id,
    name: p.name,
    kind: "provider",
    baseUrl: p.baseUrl,
    reachable: false,
    authOk: false,
    models: [],
  };
  try {
    const probe = await probeProviderModels(p.baseUrl, resolveSecret(p.authToken));
    out.models = probe.models;
    out.reachable = probe.reachable;
    out.authOk = probe.authOk;
    // Surface the diagnostic even when the endpoint is reachable (e.g. auth
    // failed, or it answered with no recognisable model list).
    if (probe.error) out.error = probe.error;
  } catch (err) {
    // probeProviderModels only throws on an SSRF-blocked URL or empty base URL.
    out.error = err instanceof BlockedUrlError ? `blocked URL: ${err.message}` : err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** Probe a default local endpoint; resolves null unless it actually answered. */
async function probeLocal(name: string, baseUrl: string): Promise<BackendStatus | null> {
  try {
    const probe = await probeProviderModels(baseUrl, undefined);
    // Only surface a local backend that actually answered; a default endpoint
    // that's simply not running should stay hidden rather than show as "down".
    if (!probe.reachable) return null;
    return {
      id: `local:${baseUrl}`,
      name,
      kind: "local",
      baseUrl,
      reachable: true,
      authOk: probe.authOk,
      models: probe.models,
      ...(probe.error ? { error: probe.error } : {}),
    };
  } catch {
    return null;
  }
}

/** Probe Anthropic, every configured provider, and any running local backends. */
export async function getStatus(): Promise<StatusSnapshot> {
  const providers = listProviders();
  const configured = new Set(providers.map((p) => p.baseUrl.replace(/\/+$/, "")));
  const localProbes = KNOWN_LOCAL.filter((l) => !configured.has(l.baseUrl)).map((l) =>
    probeLocal(l.name, l.baseUrl),
  );
  const [service, providerStatuses, localStatuses] = await Promise.all([
    checkClaudeService(),
    Promise.all(providers.map(checkProvider)),
    Promise.all(localProbes),
  ]);
  return {
    checkedAt: Date.now(),
    service,
    backends: [...providerStatuses, ...localStatuses.filter((s): s is BackendStatus => s !== null)],
  };
}
