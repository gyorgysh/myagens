import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "memory.json";

/**
 * A single durable fact the agent has learned and may recall on future turns.
 * Phase 1 is deliberately simple: plain JSON + keyword search. `salience` is a
 * 0..1 weight nudging important facts up the ranking; `useCount`/`lastUsedAt`
 * track recall so a later phase can decay unused entries.
 */
export interface MemoryEntry {
  id: string;
  text: string;
  tags: string[];
  salience: number;
  useCount: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
}

export interface MemoryInput {
  text: string;
  tags?: string[];
  salience?: number;
}

/** Split text into lowercased word tokens of length >= 3 for matching. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3);
}

function clampSalience(n: number | undefined, fallback: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * In-memory fact store, persisted to memory.json. A singleton held live in the
 * process (mirrors WorkerManager) so concurrent turns mutate one array rather
 * than racing on load-modify-save of the file.
 */
export class MemoryStore {
  private entries = loadJson<MemoryFile>(FILE, { version: 1, entries: [] }).entries;

  /** All entries, most salient first, then most recently updated. */
  list(): MemoryEntry[] {
    return [...this.entries].sort(
      (a, b) => b.salience - a.salience || b.updatedAt - a.updatedAt,
    );
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Keyword search: score each entry by how many query tokens appear in its
   * text/tags, nudged by salience. Returns matches only, best first.
   */
  search(query: string, limit = 10): MemoryEntry[] {
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return [];
    const scored: Array<{ e: MemoryEntry; score: number }> = [];
    for (const e of this.entries) {
      const hay = new Set(tokenize(`${e.text} ${e.tags.join(" ")}`));
      let hits = 0;
      for (const t of terms) if (hay.has(t)) hits++;
      if (hits > 0) scored.push({ e, score: hits + e.salience });
    }
    scored.sort((a, b) => b.score - a.score || b.e.salience - a.e.salience);
    return scored.slice(0, limit).map((s) => s.e);
  }

  create(input: MemoryInput): MemoryEntry {
    const now = Date.now();
    const text = input.text.trim();
    // De-dupe exact repeats: bump the existing entry instead of growing noise.
    const existing = this.entries.find((e) => e.text.toLowerCase() === text.toLowerCase());
    if (existing) {
      existing.salience = Math.max(existing.salience, clampSalience(input.salience, existing.salience));
      if (input.tags) existing.tags = dedupeTags([...existing.tags, ...input.tags]);
      existing.updatedAt = now;
      this.persist();
      return existing;
    }
    const entry: MemoryEntry = {
      id: randomBytes(4).toString("hex"),
      text,
      tags: dedupeTags(input.tags ?? []),
      salience: clampSalience(input.salience, 0.5),
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.persist();
    audit("memory.create", { id: entry.id, tags: entry.tags });
    return entry;
  }

  update(id: string, patch: Partial<MemoryInput>): MemoryEntry | undefined {
    const e = this.get(id);
    if (!e) return undefined;
    if (patch.text !== undefined) e.text = patch.text.trim() || e.text;
    if (patch.tags !== undefined) e.tags = dedupeTags(patch.tags);
    if (patch.salience !== undefined) e.salience = clampSalience(patch.salience, e.salience);
    e.updatedAt = Date.now();
    this.persist();
    audit("memory.update", { id });
    return e;
  }

  remove(id: string): boolean {
    const next = this.entries.filter((e) => e.id !== id);
    if (next.length === this.entries.length) return false;
    this.entries = next;
    this.persist();
    audit("memory.delete", { id });
    return true;
  }

  /** Search for a turn's prompt and record the recall (bumps usage stats). */
  recallForPrompt(prompt: string, limit = 5): MemoryEntry[] {
    const hits = this.search(prompt, limit);
    if (hits.length === 0) return [];
    const now = Date.now();
    for (const e of hits) {
      e.useCount++;
      e.lastUsedAt = now;
    }
    this.persist();
    return hits;
  }

  private persist(): void {
    saveJson<MemoryFile>(FILE, { version: 1, entries: this.entries });
  }
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

/** Render entries as a compact bullet list for the system prompt. */
export function formatMemories(entries: MemoryEntry[]): string {
  return entries
    .map((e) => `- ${e.text}${e.tags.length ? ` [${e.tags.join(", ")}]` : ""}`)
    .join("\n");
}

export const memory = new MemoryStore();
