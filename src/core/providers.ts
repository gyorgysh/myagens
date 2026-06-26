import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "providers.json";

/** A model endpoint preset. Anthropic-compatible base URL + auth token, used to
 *  point a worker at a local model server (LM Studio, Ollama, …) or a proxy. */
export interface Provider {
  id: string;
  name: string;
  /** ANTHROPIC_BASE_URL, e.g. http://localhost:1234 */
  baseUrl: string;
  /** ANTHROPIC_AUTH_TOKEN (often a placeholder like "lmstudio" locally). */
  authToken: string;
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
  createdAt: number;
  updatedAt: number;
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

export function listProviders(): Provider[] {
  return load().sort((a, b) => a.name.localeCompare(b.name));
}

/** Masked provider list for the panel (no plaintext tokens). */
export function listProviderViews(): ProviderView[] {
  return listProviders().map(toProviderView);
}

export function getProvider(id: string): Provider | undefined {
  return load().find((p) => p.id === id);
}

export interface ProviderInput {
  name: string;
  baseUrl: string;
  authToken?: string;
}

export function createProvider(input: ProviderInput): Provider {
  const now = Date.now();
  const provider: Provider = {
    id: randomBytes(4).toString("hex"),
    name: input.name.trim() || "Untitled",
    baseUrl: input.baseUrl.trim(),
    authToken: input.authToken?.trim() ?? "",
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
