import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";
import { probeProviderModels } from "./providerModels.js";
import { log } from "../logger.js";

const FILE = "providers.json";

/** A model endpoint preset. Anthropic-compatible base URL + auth token, used to
 *  point a worker at a local model server (LM Studio, Ollama, …) or a proxy —
 *  or, when `purpose` is "voice", an OpenAI/xAI-compatible key used by the
 *  voice transcription/TTS backends (see core/voiceSettings.ts). */
export interface Provider {
  id: string;
  name: string;
  /** ANTHROPIC_BASE_URL, e.g. http://localhost:1234 (or an OpenAI/xAI-compatible
   *  base URL when purpose is "voice"). */
  baseUrl: string;
  /** ANTHROPIC_AUTH_TOKEN (often a placeholder like "lmstudio" locally), or the
   *  voice provider's API key when purpose is "voice". */
  authToken: string;
  /** "chat" (default, omitted for existing rows) or "voice". Chat pickers and
   *  voice pickers each only see their own purpose so the lists never mix. */
  purpose?: "chat" | "voice";
  createdAt: number;
  updatedAt: number;
}

interface ProviderFile {
  version: 1;
  providers: Provider[];
}

/** Panel-safe view: never carries the plaintext authToken, only a masked hint. */
export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  hasToken: boolean;
  tokenHint: string;
  purpose: "chat" | "voice";
  createdAt: number;
  updatedAt: number;
}

/** Coarse classification of a provider endpoint, for display. "anthropic" is
 *  the implicit default when no provider is set (the cloud API); local servers
 *  are recognised by their well-known ports, anything else is a custom proxy. */
export type ProviderKind = "anthropic" | "ollama" | "lmstudio" | "custom";

/** Classify a provider's base URL. LM Studio defaults to :1234, Ollama :11434. */
export function providerKind(baseUrl: string): ProviderKind {
  const url = baseUrl.toLowerCase();
  if (url.includes(":11434") || url.includes("ollama")) return "ollama";
  if (url.includes(":1234") || url.includes("lmstudio") || url.includes("lm-studio")) return "lmstudio";
  return "custom";
}

function tokenHint(token: string): string {
  if (!token) return "";
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

/** Strip the plaintext authToken, replacing it with a boolean + masked hint. */
export function toProviderView(p: Provider): ProviderView {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    hasToken: Boolean(p.authToken),
    tokenHint: tokenHint(p.authToken),
    purpose: p.purpose ?? "chat",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function load(): Provider[] {
  return loadJson<ProviderFile>(FILE, { version: 1, providers: [] }).providers;
}

function persist(providers: Provider[]): void {
  saveJson<ProviderFile>(FILE, { version: 1, providers });
}

export function listProviders(opts?: { purpose?: "chat" | "voice" }): Provider[] {
  const all = load().sort((a, b) => a.name.localeCompare(b.name));
  if (!opts?.purpose) return all;
  return all.filter((p) => (p.purpose ?? "chat") === opts.purpose);
}

/** Masked provider list for the panel (no plaintext tokens). */
export function listProviderViews(opts?: { purpose?: "chat" | "voice" }): ProviderView[] {
  return listProviders(opts).map(toProviderView);
}

export function getProvider(id: string): Provider | undefined {
  return load().find((p) => p.id === id);
}

export interface ProviderInput {
  name: string;
  baseUrl: string;
  authToken?: string;
  purpose?: "chat" | "voice";
}

export function createProvider(input: ProviderInput): Provider {
  const now = Date.now();
  const provider: Provider = {
    id: randomBytes(4).toString("hex"),
    name: input.name.trim() || "Untitled",
    baseUrl: input.baseUrl.trim(),
    authToken: input.authToken?.trim() ?? "",
    purpose: input.purpose === "voice" ? "voice" : undefined,
    createdAt: now,
    updatedAt: now,
  };
  const providers = load();
  providers.push(provider);
  persist(providers);
  audit("provider.create", { id: provider.id, name: provider.name, baseUrl: provider.baseUrl });
  return provider;
}

export function updateProvider(id: string, input: Partial<ProviderInput>): Provider | undefined {
  const providers = load();
  const p = providers.find((x) => x.id === id);
  if (!p) return undefined;
  if (input.name !== undefined) p.name = input.name.trim() || p.name;
  if (input.baseUrl !== undefined) p.baseUrl = input.baseUrl.trim();
  // A blank authToken means "keep the existing one" — the panel never receives
  // the plaintext back (SEC-2), so it can only send a token the user re-typed.
  if (input.authToken !== undefined && input.authToken.trim() !== "")
    p.authToken = input.authToken.trim();
  p.updatedAt = Date.now();
  persist(providers);
  audit("provider.update", { id });
  return p;
}

export function deleteProvider(id: string): boolean {
  const providers = load();
  const next = providers.filter((p) => p.id !== id);
  if (next.length === providers.length) return false;
  persist(next);
  audit("provider.delete", { id });
  return true;
}

/** Local model servers we probe at startup, matching the panel prefill presets. */
const LOCAL_PRESETS: ProviderInput[] = [
  { name: "Ollama (local)", baseUrl: "http://localhost:11434", authToken: "ollama" },
  { name: "LM Studio (local)", baseUrl: "http://localhost:1234", authToken: "lmstudio" },
];

/** Normalise a base URL for comparison (drop trailing slash + a /v1 suffix). */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Best-effort startup auto-detection of local model servers. Probes the default
 * Ollama (:11434) and LM Studio (:1234) endpoints and, for each one that's live,
 * adds a provider preset if the user doesn't already have a provider pointing at
 * that endpoint. Never overwrites or removes anything — a user who deleted an
 * auto-added preset and stopped that server won't get it back; one who left the
 * server running keeps it. Runs concurrently and swallows all errors so a flaky
 * endpoint can never block boot.
 */
export async function autoDetectLocalProviders(): Promise<void> {
  const existing = new Set(load().map((p) => normalizeBase(p.baseUrl)));
  await Promise.all(
    LOCAL_PRESETS.map(async (preset) => {
      if (existing.has(normalizeBase(preset.baseUrl))) return;
      try {
        const probe = await probeProviderModels(preset.baseUrl, preset.authToken);
        if (!probe.reachable || !probe.models.length) return;
        createProvider(preset);
        log.info("Local model provider auto-detected and added", {
          name: preset.name,
          baseUrl: preset.baseUrl,
          models: probe.models.length,
        });
      } catch {
        // Unreachable or errored — skip silently; probed again next boot.
      }
    }),
  );
}
