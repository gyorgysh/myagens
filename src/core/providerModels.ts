import { log } from "../logger.js";
import { assertSafeUrl, BlockedUrlError } from "./safeUrl.js";

const TIMEOUT_MS = 6000;

/**
 * List the model ids a provider endpoint exposes. Tries the OpenAI-compatible
 * `/v1/models` (LM Studio, Ollama, most proxies) first, then Ollama's native
 * `/api/tags`. Server-side so it works for localhost endpoints and dodges CORS.
 */
export async function fetchProviderModels(baseUrl: string, authToken?: string): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("base URL is empty");
  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  // /v1/models — avoid doubling /v1 if the base already includes it.
  const openaiUrl = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const openai = await getJson(openaiUrl, headers);
  const fromOpenai = parseOpenai(openai);
  if (fromOpenai.length) return fromOpenai;

  // Ollama native fallback.
  const ollama = await getJson(`${base.replace(/\/v1$/, "")}/api/tags`, headers);
  const fromOllama = parseOllama(ollama);
  if (fromOllama.length) return fromOllama;

  throw new Error("could not list models — endpoint unreachable, or it returned no recognised model list");
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // SSRF guard: reject cloud-metadata / link-local targets before fetching.
    await assertSafeUrl(url);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return undefined;
    return await res.json();
  } catch (err) {
    // A blocked URL is a hard error the caller should see; a transient fetch
    // failure just means "no models from this attempt".
    if (err instanceof BlockedUrlError) throw err;
    log.debug("Model fetch failed", { url, error: err instanceof Error ? err.message : String(err) });
    return undefined;
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
