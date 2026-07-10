import { log } from "../logger.js";
import { listProviders, createProvider } from "./providers.js";
import { embeddingConfig, setEmbeddingsEnabled } from "./embeddings.js";

/**
 * Local Ollama integration helper for the panel: detect a running daemon, and
 * one-click wire it up as a model provider + semantic-memory embedding backend.
 *
 * Everything is best-effort and probe-based — when Ollama isn't running the
 * status simply reports `running: false` and the panel hides the offer.
 */

const DEFAULT_BASE_URL = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const PROBE_TIMEOUT_MS = 3_000;

/** Same endpoint the ollama backend runner uses, so the panel's installed-model
 *  list always reflects the daemon the backend will actually talk to. */
function baseUrl(): string {
  return (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export interface OllamaStatus {
  /** Daemon reachable on :11434. */
  running: boolean;
  baseUrl: string;
  /** Installed model tags (from /api/tags). */
  models: string[];
  /** A `nomic-embed-text*` model is pulled and ready. */
  hasEmbedModel: boolean;
  /** A saved provider already points at the Ollama base URL. */
  providerExists: boolean;
  /** Semantic embeddings are on and pointed at Ollama. */
  embeddingsOn: boolean;
}

/** Does any saved provider point at the local Ollama endpoint? */
function providerExists(): boolean {
  const want = baseUrl();
  return listProviders().some((p) => p.baseUrl.replace(/\/+$/, "") === want);
}

/** Are embeddings enabled and configured to use Ollama? */
function embeddingsOn(): boolean {
  const c = embeddingConfig();
  return c.enabled && c.provider === "ollama";
}

/** Probe `/api/tags` for the list of installed models. Returns [] if down. */
async function listOllamaModels(): Promise<string[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: Array<{ name?: unknown }> };
    if (!Array.isArray(json.models)) return [];
    return json.models
      .map((m) => (typeof m.name === "string" ? m.name : ""))
      .filter(Boolean);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Snapshot of the local Ollama integration for the panel. */
export async function ollamaStatus(): Promise<OllamaStatus> {
  const models = await listOllamaModels();
  const running = models !== null;
  const list = models ?? [];
  return {
    running,
    baseUrl: baseUrl(),
    models: list,
    hasEmbedModel: list.some((m) => m.startsWith(EMBED_MODEL)),
    providerExists: providerExists(),
    embeddingsOn: embeddingsOn(),
  };
}

export interface OllamaConnectResult {
  status: OllamaStatus;
  /** Did we create a new provider as part of this connect? */
  providerCreated: boolean;
  /** Did we switch embeddings on as part of this connect? */
  embeddingsEnabled: boolean;
}

/**
 * One-click connect: register Ollama as a local model provider (if not already)
 * and, when the embedding model is present, turn on semantic memory pointed at
 * it. Throws if the daemon isn't reachable so the caller can return a 409.
 */
export async function connectOllama(): Promise<OllamaConnectResult> {
  const before = await ollamaStatus();
  if (!before.running) throw new Error(`Ollama is not reachable on ${baseUrl()}`);

  let providerCreated = false;
  if (!before.providerExists) {
    createProvider({ name: "Ollama (local)", baseUrl: baseUrl(), authToken: "ollama" });
    providerCreated = true;
    log.info("Ollama registered as a local provider", { baseUrl: baseUrl() });
  }

  let embeddingsEnabled = false;
  if (before.hasEmbedModel && !before.embeddingsOn) {
    setEmbeddingsEnabled(true, { provider: "ollama", baseUrl: baseUrl(), model: EMBED_MODEL });
    embeddingsEnabled = true;
  }

  return { status: await ollamaStatus(), providerCreated, embeddingsEnabled };
}
