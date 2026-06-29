/**
 * Conversation search across sessions.
 *
 * There is no single conversation store: the live panel/Telegram chat lives in
 * memory (`chatBridge.history()`), while every autonomous worker/task run keeps
 * a full NDJSON transcript on disk (`data/runs/*.ndjson`, 72h retention). This
 * module unifies both into one searchable corpus and ranks matches with the
 * shared hybrid `semanticSearch` (cosine 0.7 + keyword 0.3, keyword-only when
 * embeddings are off), so the panel can offer one search box over all of it.
 *
 * Run transcripts can be large, so each run is collapsed to a single item whose
 * text is the concatenation of its `text`/`tool` events, capped per run to keep
 * embedding cheap. The matched snippet shown to the user is extracted around the
 * first query-term hit.
 */
import { chatBridge } from "./chatBridge.js";
import { listRuns, readRunLog } from "./runLog.js";
import { semanticSearch, type SearchItem } from "./semanticSearch.js";

/** How many of the most recent run transcripts to scan per search. */
const MAX_RUNS_SCANNED = 60;
/** Cap on the searchable text pulled from one run transcript (chars). */
const RUN_TEXT_CAP = 8_000;

export type ConversationSource = "chat" | "run";

export interface ConversationHit {
  /** Stable id: chat message id or `run:<runId>`. */
  id: string;
  source: ConversationSource;
  /** "user"/"assistant" for chat; the run owner label for runs. */
  label: string;
  /** A short excerpt around the matched text. */
  snippet: string;
  /** Epoch ms of the message / run. */
  ts: number;
  /** For run hits: the run id, so the panel can open the full transcript. */
  runId?: string;
  /** Relevance score from the ranker (higher = better). */
  score: number;
}

interface Candidate extends SearchItem {
  source: ConversationSource;
  label: string;
  ts: number;
  runId?: string;
  /** Full text used for snippet extraction (same as `text`). */
  full: string;
}

/** Flatten the live chat history into per-message search candidates. */
function chatCandidates(): Candidate[] {
  return chatBridge.history().map((m) => ({
    id: m.id,
    source: "chat" as const,
    label: m.role,
    ts: m.ts,
    text: m.text,
    full: m.text,
  }));
}

/** Collapse each recent run transcript into one search candidate. */
function runCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const run of listRuns().slice(0, MAX_RUNS_SCANNED)) {
    const events = readRunLog(run.runId);
    if (events.length === 0) continue;
    let label = run.runId;
    let ts = run.mtime;
    const parts: string[] = [];
    for (const e of events) {
      if (e.kind === "start") {
        if (e.arg) label = e.arg;
        if (e.ts) ts = e.ts;
      } else if (e.kind === "text" && e.text) {
        parts.push(e.text);
      } else if (e.kind === "tool" && e.tool) {
        parts.push(`${e.tool} ${e.arg ?? ""}`);
      } else if (e.kind === "result" && e.text) {
        parts.push(e.text);
      }
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, RUN_TEXT_CAP);
    if (!text) continue;
    out.push({ id: `run:${run.runId}`, source: "run", label, ts, runId: run.runId, text, full: text });
  }
  return out;
}

/** Build a ~240-char snippet centred on the first matching query term. */
function snippetFor(text: string, query: string): string {
  const terms = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return text.slice(0, 240) + (text.length > 240 ? "…" : "");
  const start = Math.max(0, at - 80);
  const end = Math.min(text.length, at + 160);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/**
 * Search the unified conversation corpus (live chat + run transcripts) and
 * return the top `limit` hits, newest-first within equal relevance.
 */
export async function searchConversations(query: string, limit = 25): Promise<ConversationHit[]> {
  const q = query.trim();
  if (!q) return [];
  const candidates = [...chatCandidates(), ...runCandidates()];
  if (candidates.length === 0) return [];

  const hits = await semanticSearch(candidates, q, limit);
  return hits.map((h) => ({
    id: h.item.id,
    source: h.item.source,
    label: h.item.label,
    snippet: snippetFor(h.item.full, q),
    ts: h.item.ts,
    runId: h.item.runId,
    score: h.score,
  }));
}
