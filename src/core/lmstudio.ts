import { log } from "../logger.js";
import { listProviders, createProvider } from "./providers.js";
import { embeddingConfig, setEmbeddingsEnabled, discoverEmbedModel } from "./embeddings.js";

/**
 * Local LM Studio integration helper for the panel: detect a running server on
 * :1234 and one-click wire it up as a model provider + semantic-memory embedding
 * backend (OpenAI-compatible `/v1` API).
 *
 * Unlike Ollama, LM Studio is a GUI app (not installer-scriptable), so detection
 * is panel-only. The embedding model id is discovered from `/v1/models` rather
 * than guessed, since LM Studio ships it as e.g.
 * `text-embedding-nomic-embed-text-v1.5`.
 */

const BASE_URL = "http://localhost:1234";
const FALLBACK_EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";
const PROBE_TIMEOUT_MS = 3_000;

export interface LmStudioStatus {
  /** Server reachable on :1234. */
  running: boolean;
  baseUrl: string;
  /** Loaded model ids (from /v1/models). */
  models: string[];
  /** A model id that looks like an embedding model, or null. */
  embedModel: string | null;
  /** A saved provider already points at the LM Studio base URL. */
  providerExists: boolean;
  /** Semantic embeddings are on and pointed at this endpoint. */
  embeddingsOn: boolean;
}

/** Does any saved provider point at the local LM Studio endpoint? */
function providerExists(): boolean {
  const want = BASE_URL.replace(/\/+$/, "");
  return listProviders().some((p) => p.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") === want);
}

/** Are embeddings enabled and configured to use this endpoint? */
function embeddingsOn(): boolean {
  const c = embeddingConfig();
  return c.enabled && c.provider === "openai" && c.baseUrl.replace(/\/v1$/, "") === BASE_URL;
}

/** Probe `/v1/models` for the list of loaded models. Returns null if down. */
async function listLmStudioModels(): Promise<string[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(json.data)) return [];
    return json.data.map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Snapshot of the local LM Studio integration for the panel. */
export async function lmStudioStatus(): Promise<LmStudioStatus> {
  const models = await listLmStudioModels();
  const running = models !== null;
  const list = models ?? [];
  return {
    running,
    baseUrl: BASE_URL,
    models: list,
    embedModel: list.find((m) => /embed/i.test(m)) ?? null,
    providerExists: providerExists(),
    embeddingsOn: embeddingsOn(),
  };
}

export interface LmStudioConnectResult {
  status: LmStudioStatus;
  providerCreated: boolean;
  embeddingsEnabled: boolean;
}

/**
 * One-click connect: register LM Studio as a local model provider (if not
 * already) and, when an embedding model is loaded, turn on semantic memory
 * pointed at it. Throws if the server isn't reachable so the caller can 409.
 */
export async function connectLmStudio(): Promise<LmStudioConnectResult> {
  const before = await lmStudioStatus();
  if (!before.running) throw new Error("LM Studio is not reachable on localhost:1234");

  let providerCreated = false;
  if (!before.providerExists) {
    createProvider({ name: "LM Studio (local)", baseUrl: BASE_URL, authToken: "lm-studio" });
    providerCreated = true;
    log.info("LM Studio registered as a local provider", { baseUrl: BASE_URL });
  }

  let embeddingsEnabled = false;
  const model = before.embedModel ?? (await discoverEmbedModel("openai", BASE_URL)) ?? FALLBACK_EMBED_MODEL;
  if (before.embedModel && !before.embeddingsOn) {
    setEmbeddingsEnabled(true, { provider: "openai", baseUrl: BASE_URL, model });
    embeddingsEnabled = true;
  }

  return { status: await lmStudioStatus(), providerCreated, embeddingsEnabled };
}
