import { config } from "../config.js";
import { resolveSecret } from "./vault.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { log } from "../logger.js";

const TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;

const FILE = "embeddings.json";
/** Which local backend the user prefers when both are running. */
export type PreferredBackend = "ollama" | "lmstudio";
interface EmbeddingsFile { version: 1; enabled: boolean; provider: "ollama" | "openai"; baseUrl: string; model: string; preferredBackend?: PreferredBackend | null; }

/** Runtime override: null = follow EMBEDDING_ENABLED from .env */
let _runtimeEnabled: boolean | null = null;
let _runtimeProvider: "ollama" | "openai" | null = null;
let _runtimeBaseUrl: string | null = null;
let _runtimeModel: string | null = null;
/** Preferred local backend for auto-probe ordering; null = no preference. */
let _preferredBackend: PreferredBackend | null = null;

function loadOverride(): void {
  const f = loadJson<EmbeddingsFile>(FILE, null as unknown as EmbeddingsFile);
  if (f && typeof f.enabled === "boolean") {
    _runtimeEnabled = f.enabled;
    _runtimeProvider = f.provider ?? null;
    _runtimeBaseUrl = f.baseUrl ?? null;
    _runtimeModel = f.model ?? null;
    _preferredBackend = f.preferredBackend ?? null;
  }
}
loadOverride();

/** Persist the runtime override so it survives restarts. */
function saveOverride(): void {
  const c = embeddingConfig();
  saveJson<EmbeddingsFile>(FILE, {
    version: 1,
    enabled: _runtimeEnabled ?? c.enabled,
    provider: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    preferredBackend: _preferredBackend,
  });
}

/** The user's preferred local backend when both are running (null = none). */
export function preferredBackend(): PreferredBackend | null {
  return _preferredBackend;
}

/** Set (or clear) the preferred local backend; persisted across restarts. */
export function setPreferredBackend(pref: PreferredBackend | null): void {
  _preferredBackend = pref;
  saveOverride();
  log.info("Preferred embedding backend set", { preferredBackend: pref });
}

/** Which backend the active embedding config points at ("ollama"|"lmstudio"|null). */
export function activeBackend(): PreferredBackend | null {
  if (!embeddingsEnabled()) return null;
  const c = embeddingConfig();
  if (c.provider === "ollama") return "ollama";
  // OpenAI-shape on the LM Studio port is LM Studio; anything else is a custom endpoint.
  if (/:1234(\/|$)/.test(c.baseUrl)) return "lmstudio";
  return null;
}

/** Toggle semantic embeddings at runtime (panel toggle / auto-probe). */
export function setEmbeddingsEnabled(enabled: boolean, opts?: { provider?: "ollama" | "openai"; baseUrl?: string; model?: string }): void {
  _runtimeEnabled = enabled;
  if (opts?.provider) _runtimeProvider = opts.provider;
  if (opts?.baseUrl) _runtimeBaseUrl = opts.baseUrl;
  if (opts?.model) _runtimeModel = opts.model;
  saveOverride();
  log.info("Embeddings toggled", { enabled, provider: _runtimeProvider, model: _runtimeModel });
}

/**
 * Local-first text embedding client for semantic memory search (Phase 2).
 *
 * Talks to a local (or proxy) embedding endpoint — Ollama, LM Studio, or any
 * OpenAI-compatible `/v1/embeddings` server — selected via `EMBEDDING_*` config.
 * Everything is best-effort: on any failure (endpoint down, model missing,
 * bad response) the caller falls back to keyword search, so the bot keeps
 * working with no embedding backend at all.
 *
 * Two wire shapes are supported:
 *   - OpenAI-compatible: POST /v1/embeddings {model, input} -> {data:[{embedding}]}
 *     (LM Studio, OpenAI, most proxies)
 *   - Ollama native:     POST /api/embeddings {model, prompt} -> {embedding}
 */

export interface EmbeddingConfig {
  enabled: boolean;
  provider: "ollama" | "openai";
  baseUrl: string;
  model: string;
  authToken?: string;
}

/** Resolve the effective embedding config from `config` (with vault lookup). */
export function embeddingConfig(): EmbeddingConfig {
  return {
    enabled: _runtimeEnabled ?? config.EMBEDDING_ENABLED,
    provider: _runtimeProvider ?? config.EMBEDDING_PROVIDER,
    baseUrl: (_runtimeBaseUrl ?? config.EMBEDDING_BASE_URL).replace(/\/+$/, ""),
    model: _runtimeModel ?? config.EMBEDDING_MODEL,
    authToken: config.EMBEDDING_AUTH_TOKEN ? resolveSecret(config.EMBEDDING_AUTH_TOKEN) : undefined,
  };
}

/** Is semantic search switched on and configured? */
export function embeddingsEnabled(): boolean {
  return _runtimeEnabled ?? config.EMBEDDING_ENABLED;
}

/** The model id embeddings are tagged with, so stale vectors can be detected. */
export function embeddingModelTag(): string {
  const c = embeddingConfig();
  return `${c.provider}:${c.model}`;
}

/**
 * Embed a single string. Returns the vector, or `null` if embeddings are
 * disabled or the endpoint failed (caller falls back to keyword search).
 */
export async function embedText(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const out = await embedBatch([trimmed]);
  return out?.[0] ?? null;
}

/**
 * Embed several strings in one shot where the backend allows it. Returns one
 * vector per input (same order), or `null` if embeddings are off / the call
 * failed entirely. Ollama has no batch endpoint, so we fan out concurrently.
 */
export async function embedBatch(texts: string[]): Promise<number[][] | null> {
  const c = embeddingConfig();
  if (!c.enabled) return null;
  if (texts.length === 0) return [];
  try {
    if (c.provider === "ollama") return await embedOllama(c, texts);
    return await embedOpenai(c, texts);
  } catch (err) {
    log.debug("Embedding request failed", {
      provider: c.provider,
      model: c.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function embedOpenai(c: EmbeddingConfig, texts: string[]): Promise<number[][] | null> {
  const url = /\/v1$/.test(c.baseUrl) ? `${c.baseUrl}/embeddings` : `${c.baseUrl}/v1/embeddings`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (c.authToken) headers.authorization = `Bearer ${c.authToken}`;
  const json = (await postJson(url, headers, { model: c.model, input: texts })) as {
    data?: Array<{ embedding?: unknown; index?: number }>;
  } | null;
  if (!json?.data || !Array.isArray(json.data)) return null;
  // Re-order by `index` when present so output aligns with input order.
  const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = sorted.map((d) => toNumberArray(d.embedding));
  if (vectors.some((v) => v.length === 0)) return null;
  return vectors;
}

async function embedOllama(c: EmbeddingConfig, texts: string[]): Promise<number[][] | null> {
  const base = c.baseUrl.replace(/\/v1$/, "");
  const url = `${base}/api/embeddings`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (c.authToken) headers.authorization = `Bearer ${c.authToken}`;
  // Ollama embeds one prompt per request; run them concurrently.
  const out = await Promise.all(
    texts.map(async (prompt) => {
      const json = (await postJson(url, headers, { model: c.model, prompt })) as {
        embedding?: unknown;
      } | null;
      return toNumberArray(json?.embedding);
    }),
  );
  if (out.some((v) => v.length === 0)) return null;
  return out;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function toNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const n of v) {
    if (typeof n !== "number" || Number.isNaN(n)) return [];
    out.push(n);
  }
  return out;
}

/**
 * Probe local endpoints (Ollama :11434, LM Studio :1234) and auto-enable
 * embeddings when a compatible model is found — but only if the user hasn't
 * already explicitly configured EMBEDDING_ENABLED in .env or via the panel.
 * No-op when embeddings are already on or if the user explicitly set it off.
 */
export async function autoProbeEmbeddings(): Promise<void> {
  // Skip if the user made an explicit choice (env or panel save).
  if (_runtimeEnabled !== null || config.EMBEDDING_ENABLED) return;

  const ollamaCandidate = { provider: "ollama" as const, baseUrl: "http://localhost:11434", model: "nomic-embed-text", backend: "ollama" as const };
  // LM Studio: discover the real embedding model id at runtime (it ships as
  // e.g. "text-embedding-nomic-embed-text-v1.5"), falling back to that name.
  const lmStudioCandidate = {
    provider: "openai" as const,
    baseUrl: "http://localhost:1234",
    model: (await discoverEmbedModel("openai", "http://localhost:1234")) ?? "text-embedding-nomic-embed-text-v1.5",
    backend: "lmstudio" as const,
  };

  // Try the user's preferred backend first when set; otherwise Ollama-first.
  const candidates =
    _preferredBackend === "lmstudio"
      ? [lmStudioCandidate, ollamaCandidate]
      : [ollamaCandidate, lmStudioCandidate];

  for (const c of candidates) {
    try {
      const found = await probeEndpoint(c.provider, c.baseUrl, c.model);
      if (found) {
        setEmbeddingsEnabled(true, c);
        log.info("Embeddings auto-enabled (local model detected)", { provider: c.provider, baseUrl: c.baseUrl, model: c.model });
        return;
      }
    } catch {
      // Unreachable — probeEndpoint swallows errors.
    }
  }
}

/**
 * Best-effort: ask an endpoint for its model list and return the first id that
 * looks like an embedding model (contains "embed"). Used so LM Studio detection
 * picks the actual installed id rather than guessing a fixed version string.
 * Returns null if unreachable or no embedding model is present.
 */
export async function discoverEmbedModel(
  provider: "ollama" | "openai",
  baseUrl: string,
): Promise<string | null> {
  try {
    const ids = await listEndpointModels(provider, baseUrl);
    const embed = ids.find((id) => /embed/i.test(id));
    return embed ?? null;
  } catch {
    return null;
  }
}

/** List model ids from an endpoint (OpenAI /v1/models or Ollama /api/tags). */
async function listEndpointModels(provider: "ollama" | "openai", baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    if (provider === "ollama") {
      const res = await fetch(`${base.replace(/\/v1$/, "")}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) return [];
      const json = (await res.json()) as { models?: Array<{ name?: unknown }> };
      return (json.models ?? []).map((m) => (typeof m.name === "string" ? m.name : "")).filter(Boolean);
    }
    const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (json.data ?? []).map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

/** Try to get one embedding vector from an endpoint. Returns true on success. */
async function probeEndpoint(provider: "ollama" | "openai", baseUrl: string, model: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    if (provider === "ollama") {
      const url = `${baseUrl.replace(/\/+$/, "")}/api/embeddings`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "test" }),
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      const json = await res.json() as { embedding?: unknown };
      return Array.isArray(json.embedding) && json.embedding.length > 0;
    } else {
      const url = `${baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: ["test"] }),
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      const json = await res.json() as { data?: Array<{ embedding?: unknown }> };
      return Array.isArray(json.data?.[0]?.embedding) && (json.data[0].embedding as unknown[]).length > 0;
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Cosine similarity of two equal-length vectors. Returns 0 on mismatch. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
