import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { platform } from "node:os";
import { randomBytes as id4 } from "node:crypto";
import { loadJson, saveJson, dataPath } from "./jsonStore.js";
import { listProviders, updateProvider } from "./providers.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";

const FILE = "vault.json";
const KEY_FILE = "vault.key";
const KEYCHAIN_SERVICE = "cct-vault";
const KEYCHAIN_ACCOUNT = "master";

/** A secret at rest: value is AES-256-GCM encrypted; metadata is plain. */
interface VaultEntry {
  id: string;
  name: string;
  description: string;
  ciphertext: string;
  /** Masked preview (last 4 chars) computed once at write time, never re-derived. */
  hint?: string;
  createdAt: number;
  updatedAt: number;
}

interface VaultFile {
  version: 1;
  entries: VaultEntry[];
  /** Last time the master key was rotated (epoch ms). */
  keyRotatedAt?: number;
}

/** Panel-safe view: never carries the plaintext, only a masked hint. */
export interface SecretView {
  id: string;
  name: string;
  description: string;
  hint: string;
  createdAt: number;
  updatedAt: number;
}

// --- master key (macOS Keychain, else a 0600 key file) ---

let cachedKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (platform() === "darwin") {
    const fromKc = keychainGet();
    if (fromKc) return (cachedKey = fromKc);
    const key = randomBytes(32);
    keychainSet(key);
    return (cachedKey = key);
  }
  const p = dataPath(KEY_FILE);
  if (existsSync(p)) return (cachedKey = Buffer.from(readFileSync(p, "utf8").trim(), "base64"));
  const key = randomBytes(32);
  writeFileSync(p, key.toString("base64"), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch (err) {
    log.error(`vault: failed to chmod key file ${p} to 0600 — master key may be world-readable`, { err: String(err) });
  }
  // A world-readable master key defeats the vault entirely; verify the mode landed.
  try {
    const mode = statSync(p).mode & 0o777;
    if (mode !== 0o600) {
      log.error(
        `vault: key file ${p} has mode ${mode.toString(8)} (expected 600) — master key is readable by other users`,
      );
    }
  } catch (err) {
    log.error(`vault: could not stat key file ${p} to verify permissions`, { err: String(err) });
  }
  return (cachedKey = key);
}

function keychainGet(): Buffer | null {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out ? Buffer.from(out, "base64") : null;
  } catch {
    return null; // not yet stored
  }
}

function keychainSet(key: Buffer): void {
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key.toString("base64")],
      { stdio: "ignore" },
    );
  } catch (err) {
    log.warn("Keychain write failed; falling back to key file", {
      error: err instanceof Error ? err.message : String(err),
    });
    const p = dataPath(KEY_FILE);
    writeFileSync(p, key.toString("base64"), { mode: 0o600 });
  }
}

/** Persist a (new) master key to the platform store and refresh the cache. */
function storeMasterKey(key: Buffer): void {
  if (platform() === "darwin") {
    keychainSet(key);
  } else {
    const p = dataPath(KEY_FILE);
    writeFileSync(p, key.toString("base64"), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      /* best effort */
    }
  }
  cachedKey = key;
}

/** AES-256-GCM encrypt with an explicit key (defaults to the master key). */
function encrypt(plain: string, key: Buffer = loadMasterKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

/** AES-256-GCM decrypt with an explicit key (defaults to the master key). */
function decrypt(blob: string, key: Buffer = loadMasterKey()): string {
  const [v, ivB, tagB, ctB] = blob.split(".");
  if (v !== "v1" || !ivB || !tagB || !ctB) throw new Error("malformed ciphertext");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
}

function hint(plain: string): string {
  return plain.length <= 4 ? "••••" : `••••${plain.slice(-4)}`;
}

export interface SecretInput {
  name: string;
  value: string;
  description?: string;
}

/** Encrypted secret store. Secrets are referenced elsewhere as `vault:<id>`. */
export class VaultStore {
  private file = loadJson<VaultFile>(FILE, { version: 1, entries: [] });
  private entries = this.file.entries;
  private keyRotatedAt = this.file.keyRotatedAt;

  constructor() {
    this.backfillHints();
  }

  /**
   * One-time migration: older entries have no stored `hint`. Decrypt each such
   * entry exactly once to compute and persist the masked preview, so `list()`
   * never has to touch the ciphertext again.
   */
  private backfillHints(): void {
    let changed = false;
    for (const e of this.entries) {
      if (e.hint === undefined) {
        e.hint = safeHint(e.ciphertext);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Epoch ms of the last master-key rotation, or undefined if never rotated. */
  lastRotatedAt(): number | undefined {
    return this.keyRotatedAt;
  }

  list(): SecretView[] {
    return [...this.entries]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        hint: e.hint ?? "••••",
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }));
  }

  create(input: SecretInput): SecretView {
    const now = Date.now();
    const entry: VaultEntry = {
      id: id4(4).toString("hex"),
      name: input.name.trim() || "secret",
      description: input.description?.trim() ?? "",
      ciphertext: encrypt(input.value),
      hint: hint(input.value),
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.persist();
    audit("vault.create", { id: entry.id, name: entry.name });
    return this.list().find((s) => s.id === entry.id)!;
  }

  update(id: string, patch: Partial<SecretInput>): SecretView | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    if (patch.name !== undefined) e.name = patch.name.trim() || e.name;
    if (patch.description !== undefined) e.description = patch.description.trim();
    if (patch.value !== undefined && patch.value !== "") {
      e.ciphertext = encrypt(patch.value);
      e.hint = hint(patch.value);
    }
    e.updatedAt = Date.now();
    this.persist();
    audit("vault.update", { id });
    return this.list().find((s) => s.id === id);
  }

  remove(id: string): boolean {
    const next = this.entries.filter((e) => e.id !== id);
    if (next.length === this.entries.length) return false;
    this.entries = next;
    this.persist();
    audit("vault.delete", { id });
    return true;
  }

  /** Decrypt a secret by id (panel "reveal" / internal resolution). */
  reveal(id: string): string | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    try {
      return decrypt(e.ciphertext);
    } catch (err) {
      log.error("Vault decrypt failed", { id, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  /**
   * Rotate the master key: decrypt every entry with the current key, generate a
   * fresh 32-byte key, store it (Keychain or `vault.key`), re-encrypt all
   * entries, and stamp `keyRotatedAt`. Atomic in spirit: if any entry fails to
   * decrypt the rotation aborts and nothing is changed.
   */
  rotateKey(): { rotated: number; keyRotatedAt: number } {
    // 1. Decrypt everything up-front with the current key (throws on any failure).
    const plaintexts = this.entries.map((e) => ({ id: e.id, value: decrypt(e.ciphertext) }));
    // 2. Generate + persist a new master key.
    const newKey = randomBytes(32);
    storeMasterKey(newKey);
    // 3. Re-encrypt all entries under the new key.
    const now = Date.now();
    for (const e of this.entries) {
      const p = plaintexts.find((x) => x.id === e.id)!;
      e.ciphertext = encrypt(p.value, newKey);
    }
    this.keyRotatedAt = now;
    this.persist();
    audit("vault.rotate", { rotated: this.entries.length });
    return { rotated: this.entries.length, keyRotatedAt: now };
  }

  /**
   * Encrypted, passphrase-protected backup of all secrets (plaintext values
   * included). Uses scrypt(passphrase, salt) → AES-256-GCM. The returned blob is
   * portable: it does not depend on the host master key, so it can be restored
   * on another machine via `importBackup`.
   */
  exportBackup(passphrase: string): string {
    if (!passphrase || passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
    const payload = JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      secrets: this.entries.map((e) => ({
        name: e.name,
        description: e.description,
        value: decrypt(e.ciphertext),
        createdAt: e.createdAt,
      })),
    });
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(payload, "utf8"), c.final()]);
    audit("vault.export", { count: this.entries.length });
    return [
      "vaultbak1",
      salt.toString("base64"),
      iv.toString("base64"),
      c.getAuthTag().toString("base64"),
      ct.toString("base64"),
    ].join(".");
  }

  /**
   * Restore secrets from a passphrase-protected backup. New ids are minted and
   * values are re-encrypted under the local master key. Returns the count
   * imported. Existing secrets are left untouched (additive restore).
   */
  importBackup(blob: string, passphrase: string): { imported: number } {
    const [magic, saltB, ivB, tagB, ctB] = blob.trim().split(".");
    if (magic !== "vaultbak1" || !saltB || !ivB || !tagB || !ctB) throw new Error("not a valid vault backup");
    const key = scryptSync(passphrase, Buffer.from(saltB, "base64"), 32);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    let plain: string;
    try {
      plain = Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
    } catch {
      throw new Error("wrong passphrase or corrupt backup");
    }
    const parsed = JSON.parse(plain) as {
      secrets?: Array<{ name?: string; description?: string; value?: string; createdAt?: number }>;
    };
    const secrets = Array.isArray(parsed.secrets) ? parsed.secrets : [];
    const now = Date.now();
    let imported = 0;
    for (const s of secrets) {
      if (typeof s.value !== "string") continue;
      this.entries.push({
        id: id4(4).toString("hex"),
        name: (s.name ?? "secret").trim() || "secret",
        description: (s.description ?? "").trim(),
        ciphertext: encrypt(s.value),
        hint: hint(s.value),
        createdAt: s.createdAt ?? now,
        updatedAt: now,
      });
      imported++;
    }
    if (imported > 0) this.persist();
    audit("vault.import-backup", { imported });
    return { imported };
  }

  private persist(): void {
    saveJson<VaultFile>(FILE, { version: 1, entries: this.entries, keyRotatedAt: this.keyRotatedAt });
  }
}

function safeHint(ciphertext: string): string {
  try {
    return hint(decrypt(ciphertext));
  } catch {
    return "••••";
  }
}

export const vault = new VaultStore();

const REF = /^vault:(.+)$/;

/** True if a stored value is a vault reference rather than a plaintext secret. */
export function isSecretRef(value: string | undefined): boolean {
  return typeof value === "string" && REF.test(value);
}

/**
 * Resolve a possibly-referenced value to its plaintext. `vault:<id>` is looked
 * up and decrypted; anything else is returned unchanged so plaintext configs
 * keep working during/after migration.
 */
export function resolveSecret(value: string | undefined): string {
  if (!value) return "";
  const m = REF.exec(value);
  if (!m) return value;
  return vault.reveal(m[1]) ?? "";
}

/** Build a reference string for a stored secret id. */
export function secretRef(id: string): string {
  return `vault:${id}`;
}

/** Describes one place where a vault secret is referenced. */
export interface VaultUsage {
  /** Human-readable category (e.g. "Lead bot", "Provider", "Tunnel", "Connector"). */
  kind: string;
  /** Display name of the referencing entity. */
  name: string;
}

/**
 * Scan all data stores that carry vault:<id> references and return a map of
 * vault id → list of usages. Read-only; never modifies any store.
 */
export function vaultUsages(): Record<string, VaultUsage[]> {
  const usages: Record<string, VaultUsage[]> = {};
  const add = (id: string, usage: VaultUsage) => {
    (usages[id] ??= []).push(usage);
  };
  const extractId = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    const m = REF.exec(ref);
    return m?.[1];
  };

  // Providers
  for (const p of listProviders()) {
    const id = extractId(p.authToken);
    if (id) add(id, { kind: "Provider", name: p.name });
  }

  // Workers (Lead bot tokens + provider tokens via providerId)
  try {
    const workerData = loadJson<{ workers?: Array<{ name?: string; telegramToken?: string; role?: string }> }>(
      "workers.json", { workers: [] },
    );
    for (const w of workerData.workers ?? []) {
      const id = extractId(w.telegramToken);
      if (id) add(id, { kind: "Lead bot token", name: w.name ?? "unknown" });
    }
  } catch { /* non-fatal */ }

  // Tunnel (authToken + passwordRef)
  try {
    const tunnelData = loadJson<{ authToken?: string; passwordRef?: string; provider?: string }>(
      "tunnel.json", {},
    );
    const tId = extractId(tunnelData.authToken);
    if (tId) add(tId, { kind: "Tunnel auth token", name: tunnelData.provider ?? "relay" });
    const pId = extractId(tunnelData.passwordRef);
    if (pId) add(pId, { kind: "Tunnel password", name: "Basic Auth" });
  } catch { /* non-fatal */ }

  // Connectors
  try {
    const connData = loadJson<{ connectors?: Array<{ id?: string; name?: string; secretId?: string }> }>(
      "connectors.json", { connectors: [] },
    );
    for (const c of connData.connectors ?? []) {
      const id = extractId(c.secretId);
      if (id) add(id, { kind: "Connector", name: c.name ?? c.id ?? "unknown" });
    }
  } catch { /* non-fatal */ }

  return usages;
}

/**
 * Scan & import: move every provider's plaintext auth token into the vault and
 * rewrite the provider to reference it (`vault:<id>`). Already-referenced tokens
 * are skipped. Resolution at use-time is transparent, so nothing else changes.
 */
export function importProviderSecrets(): { imported: number } {
  let imported = 0;
  for (const p of listProviders()) {
    if (!p.authToken || isSecretRef(p.authToken)) continue;
    const sec = vault.create({
      name: `provider:${p.name}`,
      value: p.authToken,
      description: `Auth token for provider "${p.name}"`,
    });
    updateProvider(p.id, { authToken: secretRef(sec.id) });
    imported++;
  }
  audit("vault.import", { imported });
  return { imported };
}
