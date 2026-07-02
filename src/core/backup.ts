import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { config } from "../config.js";
import { dataPath, saveJson } from "./jsonStore.js";
import { vault } from "./vault.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";

/**
 * Full-fleet backup & restore.
 *
 * One passphrase-protected archive of the whole data dir's durable state
 * (sessions, memory, tasks, schedules, workers, providers, connectors, tunnel,
 * heartbeat, …) plus a portable copy of the vault secrets. Built for disaster
 * recovery and migrating an install to a new machine.
 *
 * Format (binary): a 12-byte magic+version header, then scrypt(passphrase)-derived
 * AES-256-GCM over a gzipped JSON envelope. The vault is included as the vault's
 * own portable backup blob (passphrase-encrypted plaintext, host-key independent)
 * rather than its raw host-key ciphertext, so secrets survive the migration.
 */

const MAGIC = "MYAGNBK1"; // 8 bytes
// Pre-rename magic, still accepted so an archive made before the myhq->MyAgens
// rename can still be restored.
const LEGACY_MAGICS = ["MYHQBAK1"];
const VAULT_INCLUDE_NAME = "__vault_backup__"; // sentinel key in the envelope

/**
 * Durable state files we back up. We enumerate them explicitly (rather than
 * sweeping the whole dir) so transient/host-specific artifacts never travel:
 * the raw `vault.json` (host-key ciphertext, useless elsewhere), the `vault.key`
 * master key, `instance.lock`, `*.tmp`, logs, run transcripts, the audit trail,
 * and any ad-hoc files a user dropped in the data dir.
 */
const STATE_FILES = [
  "state.json", // sessions (resume tokens, cwd, modes, usage)
  "memory.json", // long-term memory
  "tasks.json", // kanban board
  "columnConfig.json", // kanban columns
  "schedules.json", // scheduled jobs
  "workers.json", // sub-agents / Leads
  "providers.json", // model-endpoint presets
  "connectors.json", // external integrations
  "tunnel.json", // remote-access relay config
  "heartbeat.json", // proactive monitoring config
  "mainAgent.json", // main-agent model/provider
  "maintenance.json", // memory-maintenance stats
  "embeddings.json", // semantic-memory backend choice
  "skills.json", // reusable prompt library
  "suggestions.json", // crew suggestion inbox
  "planSettings.json", // subscription plan
  "chat.json", // panel chat session
  "push.json", // web-push subscriptions
  "agentUsage.json", // per-agent usage totals
  "usageProbe.json", // live usage-limit snapshot
  "update.json", // update bookkeeping
] as const;

/** Files that exist but are deliberately never exported. Directories (logs/,
 *  data/runs/, data/audit/) are already excluded by listSkipped()'s isFile()
 *  check below, so they don't need an entry here. */
const EXCLUDED = new Set(["vault.json", "vault.key", "instance.lock", ".gitkeep", ".DS_Store"]);

interface ManifestEntry {
  name: string;
  bytes: number;
}

export interface BackupManifest {
  files: ManifestEntry[];
  /** Number of secrets the vault would contribute. */
  vaultSecrets: number;
  /** Sum of all included file sizes (excluding the vault blob, which is small). */
  totalBytes: number;
  /** data-dir files present but excluded from the archive, for transparency. */
  skipped: string[];
}

interface Envelope {
  version: 1;
  exportedAt: number;
  brand: string;
  platform: string;
  /** filename → raw file content (UTF-8 JSON text). */
  files: Record<string, string>;
  /** Portable vault backup blob (vaultbak1.…), present only if secrets exist. */
  [VAULT_INCLUDE_NAME]?: string;
}

/** Inspect the data dir and report what a backup would contain. */
export function backupManifest(): BackupManifest {
  const files: ManifestEntry[] = [];
  let totalBytes = 0;
  for (const name of STATE_FILES) {
    const p = dataPath(name);
    if (!existsSync(p)) continue;
    try {
      const bytes = statSync(p).size;
      files.push({ name, bytes });
      totalBytes += bytes;
    } catch {
      /* skip unreadable */
    }
  }
  const skipped = listSkipped();
  return { files, vaultSecrets: vault.list().length, totalBytes, skipped };
}

/** Files present in the data dir that are not part of the curated backup set. */
function listSkipped(): string[] {
  const known = new Set<string>(STATE_FILES);
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dataPath("."));
  } catch {
    return out;
  }
  for (const name of names) {
    if (known.has(name) || EXCLUDED.has(name)) continue;
    let isFile = false;
    try {
      isFile = statSync(dataPath(name)).isFile();
    } catch {
      continue;
    }
    if (isFile) out.push(name);
  }
  return out.sort();
}

/**
 * Build the encrypted archive. Returns the raw bytes (binary, downloadable).
 * `passphrase` must be ≥8 chars; it derives both the archive key and the inner
 * vault blob's key, so a single passphrase unlocks everything on restore.
 */
export function exportBackup(passphrase: string): Buffer {
  if (!passphrase || passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");

  const files: Record<string, string> = {};
  for (const name of STATE_FILES) {
    const p = dataPath(name);
    if (!existsSync(p)) continue;
    try {
      files[name] = readFileSync(p, "utf8");
    } catch (err) {
      log.warn("backup: skipping unreadable file", { name, error: errText(err) });
    }
  }

  const envelope: Envelope = {
    version: 1,
    exportedAt: Date.now(),
    brand: config.BRAND_NAME ?? "MyAgens",
    platform: process.platform,
    files,
  };
  // Include vault secrets as the portable, host-key-independent blob.
  if (vault.list().length > 0) {
    envelope[VAULT_INCLUDE_NAME] = vault.exportBackup(passphrase);
  }

  const plain = gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"));
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();

  audit("backup.export", { files: Object.keys(files).length, vaultSecrets: vault.list().length });
  // [ MAGIC(8) | saltLen handled positionally: salt(16) | iv(12) | tag(16) | ct ]
  return Buffer.concat([Buffer.from(MAGIC, "ascii"), salt, iv, tag, ct]);
}

export interface ImportResult {
  /** State files written back to the data dir. */
  filesRestored: number;
  /** Secrets restored into the vault (0 if vault not included or skipped). */
  vaultRestored: number;
  /** Filenames that were restored. */
  names: string[];
  exportedAt?: number;
}

/**
 * Restore an archive into the data dir. Decryption happens entirely up-front:
 * if the passphrase is wrong or the archive is corrupt, nothing is written.
 * State files are overwritten in place; vault secrets are additively restored
 * (new ids, re-encrypted under the local master key) unless `includeVault` is
 * false. The caller is expected to restart the process so the new state loads.
 */
export function importBackup(
  archive: Buffer,
  passphrase: string,
  opts: { includeVault?: boolean } = {},
): ImportResult {
  const includeVault = opts.includeVault !== false;
  const envelope = decodeArchive(archive, passphrase);

  const names: string[] = [];
  for (const [name, content] of Object.entries(envelope.files)) {
    // Defence-in-depth: only allow names from our known set, never a path.
    if (!(STATE_FILES as readonly string[]).includes(name)) continue;
    if (typeof content !== "string") continue;
    try {
      // Validate it parses as JSON before committing it to disk.
      const parsed = JSON.parse(content);
      saveJson(name, parsed);
      names.push(name);
    } catch (err) {
      log.warn("backup: skipping malformed entry on import", { name, error: errText(err) });
    }
  }

  let vaultRestored = 0;
  const vaultBlob = envelope[VAULT_INCLUDE_NAME];
  if (includeVault && typeof vaultBlob === "string" && vaultBlob) {
    try {
      vaultRestored = vault.importBackup(vaultBlob, passphrase).imported;
    } catch (err) {
      log.error("backup: vault restore failed", { error: errText(err) });
    }
  }

  audit("backup.import", { filesRestored: names.length, vaultRestored });
  return { filesRestored: names.length, vaultRestored, names, exportedAt: envelope.exportedAt };
}

/** Decrypt + parse an archive; throws on wrong passphrase or corruption. */
function decodeArchive(archive: Buffer, passphrase: string): Envelope {
  if (!passphrase) throw new Error("passphrase required");
  if (archive.length < 8 + 16 + 12 + 16) throw new Error("not a valid backup archive");
  const magic = archive.subarray(0, 8).toString("ascii");
  if (magic !== MAGIC && !LEGACY_MAGICS.includes(magic)) throw new Error("not a valid backup archive");

  let off = 8;
  const salt = archive.subarray(off, (off += 16));
  const iv = archive.subarray(off, (off += 12));
  const tag = archive.subarray(off, (off += 16));
  const ct = archive.subarray(off);

  const key = scryptSync(passphrase, salt, 32);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new Error("wrong passphrase or corrupt archive");
  }

  let json: string;
  try {
    json = gunzipSync(plain).toString("utf8");
  } catch {
    throw new Error("corrupt archive (decompression failed)");
  }

  const parsed = JSON.parse(json) as Envelope;
  if (!parsed || typeof parsed !== "object" || typeof parsed.files !== "object") {
    throw new Error("malformed backup envelope");
  }
  return parsed;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
