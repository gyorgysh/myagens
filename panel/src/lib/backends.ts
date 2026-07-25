import { api } from "../api.ts";

/**
 * Agent backends that keep the Model field in the pickers. Their model is the
 * backend's own (an installed Ollama model, an Antigravity label, a Cursor
 * model id), never a Claude one, so Provider still doesn't apply to them.
 * Every other non-Claude backend runs on its CLI's own default model and shows
 * no model input at all.
 */
const MODEL_FIELD_BACKENDS = {
  ollama: "ollama",
  "agy-cli": "agy",
  "cursor-cli": "cursor",
} as const;

/** Which model-field hint applies, or undefined when this backend has no
 *  model input (Claude uses the provider/model pair instead). */
export function backendModelKind(backendId: string): "ollama" | "agy" | "cursor" | undefined {
  return MODEL_FIELD_BACKENDS[backendId as keyof typeof MODEL_FIELD_BACKENDS];
}

/** Live model list for a backend's Fetch button; undefined when the backend
 *  has no list to offer. Errors degrade to an empty list. */
export function fetchModelsFor(backendId: string): (() => Promise<string[]>) | undefined {
  switch (backendId) {
    case "ollama":
      return () => api.ollamaStatus().then((s) => s.models).catch(() => []);
    case "agy-cli":
      return () => api.agyModels().then((r) => r.models).catch(() => []);
    case "cursor-cli":
      return () => api.cursorModels().then((r) => r.models).catch(() => []);
    default:
      return undefined;
  }
}
