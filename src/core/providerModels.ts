import { log } from "../logger.js";
import { safeFetch, BlockedUrlError } from "./safeUrl.js";

const TIMEOUT_MS = 6000;

/** Outcome of one HTTP attempt against a candidate models endpoint. */
type Attempt =
  | { kind: "ok"; json: unknown }
  | { kind: "http"; status: number } // endpoint answered with a non-2xx
  | { kind: "network"; message: string }; // never reached the endpoint

/** Structured result of probing a provider for its model list. */
export interface ProviderProbe {
  models: string[];
  /** The endpoint answered at all (any HTTP response), vs. a network/DNS miss. */
  reachable: boolean;
  /** Credentials were not rejected (no 401/403 seen). */
  authOk: boolean;
  /** Human-readable detail when no models came back. */
  error?: string;
}

/**
 * Probe a provider endpoint for its model list and report *why* it failed.
 * Tries the OpenAI-compatible `/v1/models` (LM Studio, Ollama, most proxies)
 * first, then Ollama's native `/api/tags`. Server-side so it works for
 * localhost endpoints and dodges CORS.
 *
 * Unlike a plain "did we get models" check, this keeps the distinction between
 * an endpoint that never answered (network/DNS failure → not reachable), one
 * that rejected the credentials (401/403 → reachable, auth failed), and one
 * that answered but returned an unrecognised body (reachable, parse miss), so
 * the status panel can show down / auth / up accurately instead of one generic
 * "could not list models" for every case.
 *
 * Throws only {@link BlockedUrlError} (an SSRF-guard rejection the caller must
 * see) or an empty-base-URL error; every other failure is reported in the
 * returned {@link ProviderProbe}.
 */
export async function probeProviderModels(baseUrl: string, authToken?: string): Promise<ProviderProbe> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("base URL is empty");
  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  // /v1/models — avoid doubling /v1 if the base already includes it.
  const openaiUrl = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const attempts: Attempt[] = [];

  const openai = await getJson(openaiUrl, headers);
  attempts.push(openai);
  if (openai.kind === "ok") {
    const models = parseOpenai(openai.json);
    if (models.length) return { models, reachable: true, authOk: true };
  }

  // Ollama native fallback.
  const ollama = await getJson(`${base.replace(/\/v1$/, "")}/api/tags`, headers);
  attempts.push(ollama);
  if (ollama.kind === "ok") {
    const models = parseOllama(ollama.json);
    if (models.length) return { models, reachable: true, authOk: true };
  }

  return summarize(attempts);
}

/**
 * List the model ids a provider endpoint exposes, throwing when none can be
 * found. Thin wrapper over {@link probeProviderModels} kept for the call sites
 * (`/model`, the provider-form model lists) that only care about the list and
 * surface the thrown message directly.
 */
export async function fetchProviderModels(baseUrl: string, authToken?: string): Promise<string[]> {
  const probe = await probeProviderModels(baseUrl, authToken);
  if (probe.models.length) return probe.models;
  throw new Error(probe.error ?? "could not list models");
}

/** Collapse the per-attempt outcomes into a single diagnostic probe result. */
function summarize(attempts: Attempt[]): ProviderProbe {
  // Auth rejection on any attempt is the most actionable signal: the endpoint
  // answered, it just refused the credentials.
  const auth = attempts.find((a) => a.kind === "http" && (a.status === 401 || a.status === 403));
  if (auth && auth.kind === "http") {
    return {
      models: [],
      reachable: true,
      authOk: false,
      error: `authentication failed (HTTP ${auth.status}) — check the provider's auth token`,
    };
  }
  // Any HTTP response at all means the endpoint is reachable; it just didn't
  // give us a model list we recognise (404 wrong path, 5xx, odd JSON shape).
  const http = attempts.find((a) => a.kind === "http");
  if (http && http.kind === "http") {
    return {
      models: [],
      reachable: true,
      authOk: true,
      error: `endpoint reachable but returned no recognised model list (HTTP ${http.status})`,
    };
  }
  const ok = attempts.find((a) => a.kind === "ok");
  if (ok) {
    return {
      models: [],
      reachable: true,
      authOk: true,
      error: "endpoint reachable but returned no recognised model list",
    };
  }
  // Nothing answered: report the underlying network/DNS error.
  const net = attempts.find((a) => a.kind === "network");
  return {
    models: [],
    reachable: false,
    authOk: false,
    error: net && net.kind === "network" ? `endpoint unreachable: ${net.message}` : "endpoint unreachable",
  };
}

async function getJson(url: string, headers: Record<string, string>): Promise<Attempt> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // SSRF guard: re-resolves + re-validates and pins the IP at fetch time to
    // defeat DNS rebinding (cloud-metadata / link-local targets).
    const res = await safeFetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return { kind: "http", status: res.status };
    try {
      return { kind: "ok", json: await res.json() };
    } catch (err) {
      // Answered, but the body wasn't JSON — reachable, just unusable.
      log.debug("Model list JSON parse failed", { url, error: err instanceof Error ? err.message : String(err) });
      return { kind: "http", status: res.status };
    }
  } catch (err) {
    // A blocked URL is a hard error the caller should see; a transient fetch
    // failure means the endpoint wasn't reachable on this attempt.
    if (err instanceof BlockedUrlError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.debug("Model fetch failed", { url, error: message });
    return { kind: "network", message };
  } finally {
    clearTimeout(timer);
  }
}

function parseOpenai(json: unknown): string[] {
  const data = (json as { data?: Array<{ id?: unknown }> })?.data;
  if (!Array.isArray(data)) return [];
  return dedupeSort(data.map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean));
}

function parseOllama(json: unknown): string[] {
  const models = (json as { models?: Array<{ name?: unknown }> })?.models;
  if (!Array.isArray(models)) return [];
  return dedupeSort(models.map((m) => (typeof m.name === "string" ? m.name : "")).filter(Boolean));
}

function dedupeSort(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
