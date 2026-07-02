// Thin client over the panel's /api + /ws. The token lives in localStorage and
// is sent as a Bearer header (REST) or ?token= query (WebSocket).

const TOKEN_KEY = "myagens.panel.token";
// Pre-rename key, so a browser that already logged in before the myhq->MyAgens
// rename doesn't get silently signed out.
const LEGACY_TOKEN_KEY = "myhq.panel.token";

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacy) {
    localStorage.setItem(TOKEN_KEY, legacy);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
  return legacy;
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  // Drop the service worker's cached API responses on sign-out. Sensitive routes
  // aren't cached at all (see sw.ts), but purging api-cache here guarantees no
  // previously-fetched data lingers on disk once the token is gone.
  if (typeof caches !== "undefined") void caches.delete("api-cache").catch(() => {});
}

export class AuthError extends Error {}

/** A non-OK HTTP response (other than 401, which throws AuthError). Carries the
 *  status code so callers can special-case e.g. 429 rate limiting. */
export class ApiError extends Error {
  constructor(public status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
  }
}

function authHeaders(json = false): Record<string, string> {
  const token = getToken();
  const h: Record<string, string> = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (json) h["content-type"] = "application/json";
  return h;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError("unauthorized");
  if (!res.ok) throw new ApiError(res.status, `${path} → ${res.status}`);
  return (await res.json()) as T;
}

const get = <T>(path: string) => req<T>("GET", path);

/** Fetch a binary response (e.g. an image) with the same Bearer-header auth as
 *  `req`/`get`. REST routes only accept the token via the Authorization header
 *  (unlike the `/ws` handshake, which also allows `?token=`), so binary assets
 *  must be fetched and turned into an object URL rather than linked directly. */
async function reqBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) throw new AuthError("unauthorized");
  if (!res.ok) throw new ApiError(res.status, `${path} → ${res.status}`);
  return res.blob();
}

/** Validate a token by hitting /api/me; returns true if accepted. */
export async function checkToken(token: string): Promise<boolean> {
  const res = await fetch("/api/me", { headers: { authorization: `Bearer ${token}` } });
  return res.ok;
}

/** Open the health WebSocket with the token in the query string. */
export function openHealthSocket(): WebSocket {
  const token = getToken() ?? "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
}

/** One connected panel device, as broadcast in `{type:"presence"}` WS frames. */
export interface PresenceClient {
  clientId: string;
  label: string;
  since: number;
}

/** Result of probing whether the backend has locked this client out (429). */
export interface LockoutProbe {
  locked: boolean;
  /** Seconds remaining on the lockout (best-effort, from Retry-After / body). */
  retryAfterSec: number;
}

/**
 * Cheap unauthenticated-friendly probe to tell a real backend outage apart from
 * a brute-force lockout. The health WebSocket fails silently on a 429 (the
 * browser can't read the handshake status), so when it won't open we hit a plain
 * REST endpoint and read the 429 + Retry-After the server attaches to a lockout.
 */
export async function probeLockout(): Promise<LockoutProbe> {
  try {
    const res = await fetch("/api/me", { headers: authHeaders() });
    if (res.status !== 429) return { locked: false, retryAfterSec: 0 };
    const header = Number(res.headers.get("retry-after"));
    let retryAfterSec = Number.isFinite(header) && header > 0 ? header : 0;
    if (!retryAfterSec) {
      const body = (await res.json().catch(() => null)) as { retryAfterMs?: number } | null;
      if (body?.retryAfterMs) retryAfterSec = Math.ceil(body.retryAfterMs / 1000);
    }
    return { locked: true, retryAfterSec };
  } catch {
    // Network error → genuine outage, not a lockout.
    return { locked: false, retryAfterSec: 0 };
  }
}

// --- Shapes mirrored from src/core (kept in sync by hand; small + stable). ---

export interface UsageStat {
  turns: number;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Health {
  ts: number;
  host: string;
  platform: string;
  uptimeSec: number;
  processUptimeSec: number;
  cpu: { load: number; cores: number[]; loadAvg: [number, number, number]; tempC?: number };
  mem: { total: number; used: number; available: number };
  swap: { total: number; used: number };
  disks: Array<{ mount: string; size: number; used: number; usePct: number }>;
  io: { readBytesSec?: number; writeBytesSec?: number; tps?: number };
}

export interface SessionView {
  chatId: number;
  cwd: string;
  autonomy: Autonomy;
  busy: boolean;
  hasContext: boolean;
  projects: string[];
  allowedTools: string[];
  allowedBashCmds: string[];
  usage: { total: UsageStat; today: UsageStat };
}

/** One conversation-search hit (live chat message or run transcript). */
export interface ConversationHit {
  id: string;
  source: "chat" | "run";
  label: string;
  snippet: string;
  ts: number;
  runId?: string;
  score: number;
}

export interface ScheduleView {
  id: string;
  chatId: number;
  cwd: string;
  prompt: string;
  spec: string;
  specRaw: string;
  nextRunAt: number;
  lastRunAt?: number;
  lastError?: string;
  busySince?: number;
  createdAt: number;
  enabled: boolean;
  webhookUrl?: string;
}

export interface WebhookTriggerView {
  id: string;
  name: string;
  prompt: string;
  cwd?: string;
  leadId?: string;
  leadName?: string;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  fireCount: number;
  secretHint: string;
  path: string;
}

export interface UsageSummary {
  total: UsageStat;
  today: UsageStat;
  daily: Array<{ day: string } & UsageStat>;
}

export type AgentRole = "atlas" | "lead" | "worker" | "task" | "schedule" | "agentchat";
export interface AgentUsageEntry {
  name: string;
  role: AgentRole;
  total: UsageStat;
  daily: Record<string, UsageStat>;
}

export type AgentDailyByRole = Partial<Record<AgentRole, Array<{ day: string } & UsageStat>>>;

export interface PromptView {
  personality: string;
  workFile: string;
  work: string;
  exists: boolean;
  /** Shipped default playbook (git-tracked template), if readable. */
  defaultWork?: string;
  /** Whether the live playbook matches the shipped default (false = customized). */
  matchesDefault?: boolean;
  /** Byte size of work.md (0 if absent). */
  workBytes: number;
}

export interface ClaudeFile {
  path: string;
  rel: string;
  kind: "agent" | "skill" | "command" | "memory";
  bytes: number;
}
export interface ClaudeRoot {
  root: string;
  files: ClaudeFile[];
}

/** Column id is now any string defined by the column config (no longer a fixed union). */
export type Column = string;
export interface ColumnDef { id: string; name: string; order: number; collapsed?: boolean; }
export type Priority = "low" | "normal" | "high";
export interface TaskRunConfig {
  /** Per-run wall-clock timeout in ms (0 = no timeout). */
  timeoutMs: number;
  /** Max concurrent delegated runs (0 = unlimited); the rest queue. */
  maxConcurrent: number;
}
export interface TaskDelegation {
  status: "queued" | "running" | "ok" | "error" | "stopped";
  runId: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  output?: string;
}
/** A card's repeat rule (mirrors src/core/tasks.ts Recurrence). */
export type Recurrence =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | { kind: "monthly"; dayOfMonth: number; hour: number; minute: number };
export interface TaskRecurrence {
  rule: Recurrence;
  nextRunAt: number;
  lastRunAt?: number;
}
export interface Task {
  id: string;
  title: string;
  notes: string;
  column: Column;
  priority: Priority;
  /** When set, this card is a recurring template that spawns backlog copies. */
  recurrence?: TaskRecurrence;
  parentId?: string;
  /** Ids of cards this one is blocked by (must reach done before it can run). */
  blockedBy?: string[];
  /** Subset of blockedBy that's still unsatisfied (server-computed). */
  blockingIds?: string[];
  /** True when the delegator is holding this card waiting on a prerequisite. */
  waitingOnPrereq?: boolean;
  delegate?: TaskDelegation;
  /** How many times this card has been re-delegated after a failure. */
  retryCount?: number;
  /** True when a retry would resume the prior Claude session (not start over). */
  canResume?: boolean;
  order: number;
  /** Creator id stamped at create-time: "atlas", a worker/lead id, or "panel". */
  createdBy?: string;
  /** Friendly creator name resolved by the server (e.g. "Atlas", "Iris", "Panel"). */
  createdByName?: string;
  createdAt: number;
  updatedAt: number;
}
export type Wip = Record<string, number | undefined>;

/** Delegation queue state: whether dispatch is paused and how many cards wait. */
export interface QueueState {
  paused: boolean;
  queued: number;
  /** Cards held waiting on a blockedBy prerequisite. */
  blocked?: number;
}

/** Coarse provider classification (mirrors ProviderKind on the backend). */
export type ProviderKind = "anthropic" | "ollama" | "lmstudio" | "custom";

/** A provider option for the worker form, with its endpoint type for display. */
export interface NamedProvider {
  id: string;
  name: string;
  kind: ProviderKind;
}

/** An agent backend option (which CLI/runtime drives a turn) for the Agent
 *  settings and worker form selectors — a separate concept from the
 *  embeddings PreferredBackend or status.ts's BackendStatus. */
export interface NamedBackend {
  id: string;
  displayName: string;
}

export interface Worker {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  model: string;
  providerId: string;
  /** Agent backend id (see NamedBackend); "" = the default Claude backend. */
  backendId?: string;
  systemPrompt: string;
  skillId: string;
  schedule: string;
  when: string;
  nextRunAt?: number;
  enabled: boolean;
  running: boolean;
  lastRunAt?: number;
  lastRunId?: string;
  role?: "" | "lead" | "assistant";
  portfolio?: string;
  parentId?: string;
  telegramToken?: string;
  /** The Lead bot's @username (from getMe), for a t.me link. */
  botUsername?: string;
  persona?: string;
  autonomy?: Autonomy;
  language?: string;
  webhookUrl?: string;
  /** Avatar slug from the curated set; empty/undefined means derive from id. */
  avatar?: string;
  /** True when this Lead has a live Telegram bot listening (role+token+enabled). */
  listening?: boolean;
  /** True when autonomy is auto_until_error and the worker has hit a tool error. */
  escalated?: boolean;
  /** Byte size of CLAUDE.md in the worker's cwd (0 if absent). The SDK auto-loads
   *  it as project context on every turn; large files cost tokens. */
  claudeMdBytes?: number;
  /** Telegram streaming mode override for Lead bots. Empty string = use global default. */
  streamMode?: "" | "rich" | "draft" | "edit";
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  cwd?: string;
  useCount: number;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A portable skill package produced by the export endpoint. */
export interface SkillBundle {
  kind: "myagens.skill";
  version: 1;
  exportedAt: number;
  skill: { name: string; description?: string; prompt: string; cwd?: string };
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  body: string;
  /** Distinct `{{variable}}` names referenced in the body, in order. */
  variables: string[];
  useCount: number;
  createdAt: number;
  updatedAt: number;
}

export type PlanType = "pro" | "max" | "api";

export interface ClaudeAccount {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  authMethod?: string;
}

export interface ClaudeDailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface ClaudeModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
}

export interface ClaudeUsageWindow {
  count: number;
  baseline: number;
  pctOfBaseline: number;
  resetsAt: string;
  resetsLabel: string;
  resetsInMs: number;
}

export interface ClaudeActiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status: string;
}

export interface ClaudeUsageSnapshot {
  account: ClaudeAccount;
  lastRecordedDay?: ClaudeDailyActivity;
  todayDate: string;
  hasTodayData: boolean;
  daily: ClaudeUsageWindow;
  weekly: ClaudeUsageWindow;
  activeSessions: ClaudeActiveSession[];
  recentDays: ClaudeDailyActivity[];
  lastDayTokens: Record<string, ClaudeModelTokens>;
  totalMessages: number;
  totalSessions: number;
  firstSessionDate?: string;
  fetchedAt: number;
}

export interface PlanSettings {
  plan: PlanType;
  monthlyCap: number;
  billingDay: number;
  alertThresholdPct: number;
  dailyCapUsd?: number;
  weeklyCapUsd?: number;
  costCheckIntervalMs?: number;
  lastCostCheckAt?: number;
  probeIntervalMs: number;
}

export interface UsageLimitWindow {
  percent: number;
  resetsAt: string;
  resetsInMs: number;
  label: string;
  severity: "normal" | "warning" | "critical";
}

export interface ProbeAccount {
  email?: string;
  fullName?: string;
  hasPro: boolean;
  hasMax: boolean;
  subscriptionStatus?: string;
  subscriptionType?: string;
}

export interface ProbeResult {
  probedAt?: string;
  source: "oauth" | "fallback" | "none";
  /** Cached data shown because the latest refresh failed (e.g. rate-limited). */
  stale?: boolean;
  error?: string;
  account?: ProbeAccount;
  limits: UsageLimitWindow[];
  extraUsageEnabled?: boolean;
  activity?: {
    lastDate: string;
    messageCount: number;
    toolCallCount: number;
    sessionCount: number;
    weeklyMessageCount: number;
  };
}

export interface PlanView extends PlanSettings {
  periodStart: string;
  periodCostUsd: number;
  daysUntilReset: number;
  dailyAvgUsd: number;
  estimatedMonthlyUsd: number;
  pctUsed: number;
}

export interface MaintenanceStats {
  lastRunAt?: number;
  nextRunAt?: number;
  memoriesCompacted: number;
  memoriesDeleted: number;
  memoriesMerged: number;
  memoriesRewritten: number;
  memoriesShortened: number;
  skillsArchived: number;
}

/** Dry-run of the deterministic compaction steps before an actual run. */
export interface MaintenancePreview {
  toDelete: MemoryEntry[];
  toDemote: MemoryEntry[];
  toMerge: { kept: MemoryEntry; dropped: MemoryEntry[] }[];
}

export interface DelegationRecord {
  ts: number;
  fromAgentId?: string;
  toAgentId?: string;
  leadName?: string;
  task?: string;
  summary?: string;
  outputTail?: string;
  durationMs?: number;
  costUsd?: number;
  type?: string;
}

/** Council decision rule applied to the relevance-weighted tallies. */
export type CouncilRule = "majority" | "supermajority" | "unanimous";

export interface WorkerRun {
  id: string;
  workerId: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "ok" | "error" | "stopped";
  costUsd?: number;
  durationMs?: number;
  error?: string;
  output: string;
}

/** One line of a full run transcript (runs/YYYY-MM-DD/<runId>.ndjson). */
export interface RunLogEvent {
  ts: number;
  kind: "text" | "tool" | "result" | "start" | "end";
  text?: string;
  tool?: string;
  arg?: string;
  isError?: boolean;
  status?: string;
  costUsd?: number;
  durationMs?: number;
}

export type ConnectorScope = "read" | "write";

export type ConnectorTokenStatus = "none" | "ok" | "expiring" | "expired";

export type ConnectorCategory = "productivity" | "dev" | "database" | "image";

export interface Connector {
  id: string;
  name: string;
  description: string;
  credential: string;
  status: "live" | "coming-soon";
  hasWrite: boolean;
  category: ConnectorCategory;
  secretId?: string;
  enabled: boolean;
  scope: ConnectorScope;
  /** Epoch-ms token expiry, if tracked. */
  expiresAt?: number;
  /** Derived credential freshness from `expiresAt`. */
  tokenStatus: ConnectorTokenStatus;
}

export type ImageProviderId = "recraft" | "ideogram" | "replicate" | "fal" | "local_sd";

export interface GalleryImage {
  id: string;
  provider: string;
  prompt: string;
  tags: string[];
  createdAt: number;
  path: string;
  width?: number;
  height?: number;
  sourceChat?: number;
}

export interface GalleryFilter {
  tag?: string;
  provider?: string;
  from?: number;
  to?: number;
  q?: string;
}

export type WebhookParamIn = "query" | "header" | "body" | "path";

export interface WebhookParam {
  name: string;
  in: WebhookParamIn;
  description?: string;
  required?: boolean;
}

export interface WebhookTool {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  params: WebhookParam[];
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: number;
}

export type WebhookToolInput = Partial<Omit<WebhookTool, "id" | "createdAt">>;

export interface Branding {
  brandName?: string;
  agentName?: string;
  panelTitle?: string;
  logoUrl?: string;
  faviconUrl?: string;
  emailFooter?: string;
  accentColor?: string;
}

export interface BrandingView {
  branding: Branding;
  unlocked: boolean;
  effective: Branding;
}

export type HeartbeatMode = "off" | "alert" | "active";
export type HeartbeatSignalKey =
  | "cpu"
  | "mem"
  | "swap"
  | "disk"
  | "stale"
  | "spend"
  | "calendar"
  | "anomaly";
export interface AnomalyConfig {
  enabled: boolean;
  deleteWindowMin: number;
  deleteThreshold: number;
  workStart: string;
  workEnd: string;
  lookbackMin: number;
}
export interface HeartbeatConfig {
  mode: HeartbeatMode;
  intervalMs: number;
  cpuPct: number;
  memPct: number;
  swapPct: number;
  diskPct: number;
  staleCardHours: number;
  spendAlertEnabled: boolean;
  mutedSignals: HeartbeatSignalKey[];
  calendarEnabled: boolean;
  calendarWindowMin: number;
  calendarLeadMin: number;
  quietStart?: string;
  quietEnd?: string;
  anomaly: AnomalyConfig;
}
export interface HeartbeatView {
  config: HeartbeatConfig;
  lastTickAt?: number;
  alerts: Array<{ ts: number; text: string }>;
}

export interface BackendStatus {
  id: string;
  name: string;
  kind: "anthropic" | "provider" | "local";
  baseUrl: string;
  reachable: boolean;
  authOk: boolean;
  models: string[];
  error?: string;
}
export interface ServiceStatus {
  indicator: "none" | "minor" | "major" | "critical" | "unknown";
  description: string;
  url: string;
  error?: string;
}
export interface StatusSnapshot {
  checkedAt: number;
  service: ServiceStatus;
  backends: BackendStatus[];
}

export interface SecretView {
  id: string;
  name: string;
  description: string;
  hint: string;
  createdAt: number;
  updatedAt: number;
}

export interface BackupManifest {
  files: Array<{ name: string; bytes: number }>;
  vaultSecrets: number;
  totalBytes: number;
  skipped: string[];
}

export interface BackupImportResult {
  filesRestored: number;
  vaultRestored: number;
  names: string[];
  exportedAt?: number;
}

export type MemoryTier = "hot" | "warm" | "cold";

export interface MemoryEntry {
  id: string;
  text: string;
  tags: string[];
  salience: number;
  tier: MemoryTier;
  useCount: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  embedded?: boolean;
}

export interface MemoryExport {
  version: 1;
  exportedAt: number;
  entries: Array<Omit<MemoryEntry, "embedded">>;
}

export interface MemoryStats {
  total: number;
  byTier: Record<MemoryTier, number>;
  totalRecalls: number;
  recalledCount: number;
  embedded: number;
  tagCount: number;
  lastRecalledAt?: number;
}

export type SuggestionStatus = "pending" | "accepted" | "dismissed";

export interface Suggestion {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  title: string;
  detail: string;
  category?: string;
  status: SuggestionStatus;
  createdAt: number;
  decidedAt?: number;
  taskId?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  error?: boolean;
  costUsd?: number;
  /** True when this user message was sent in planning mode (preamble stripped). */
  planning?: boolean;
}

/** One pending tool-call approval, mirrored from the shared session. */
export interface ApprovalView {
  id: string;
  chatId: number;
  toolName: string;
  preview: string;
  lead?: string;
  ts: number;
}

/** One option of a pending AskUserQuestion prompt. */
export interface AskOptionView {
  label: string;
  description?: string;
}

/** A pending AskUserQuestion prompt, mirrored from the main Telegram chat. */
export interface AskQuestionView {
  id: string;
  chatId: number;
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskOptionView[];
  ts: number;
}

/** An image attached to a chat message: raw base64 bytes + its MIME type. */
export interface ChatImage {
  base64: string;
  mediaType: string;
}

export interface ChatView {
  messages: ChatMessage[];
  cwd: string;
  busy: boolean;
  auto: boolean;
  hasContext: boolean;
  /** The shared session's persisted "always allow" tool presets (read-only). */
  allowedTools: string[];
  /** The shared session's persisted "always allow" Bash command presets. */
  allowedBashCmds: string[];
  /** Tool-call approvals currently awaiting a decision. */
  approvals: ApprovalView[];
  /** AskUserQuestion prompts currently awaiting an answer. */
  asks: AskQuestionView[];
}

/** Snapshot of an interactive chat with one specific worker / Lead. */
export interface AgentChatView {
  agentId: string;
  name: string;
  /** Avatar slug for chat bubbles (worker's avatar, or derived from id). */
  avatar?: string;
  cwd: string;
  messages: ChatMessage[];
  busy: boolean;
  hasContext: boolean;
}

export type Autonomy = "supervised" | "standard" | "full" | "auto_until_error";

export interface EmbeddingConfig {
  enabled: boolean;
  provider: "ollama" | "openai";
  baseUrl: string;
  model: string;
}

export type PreferredBackend = "ollama" | "lmstudio";

export interface OllamaStatus {
  running: boolean;
  baseUrl: string;
  models: string[];
  hasEmbedModel: boolean;
  providerExists: boolean;
  embeddingsOn: boolean;
}

export interface OllamaConnectResult {
  status: OllamaStatus;
  providerCreated: boolean;
  embeddingsEnabled: boolean;
}

export interface LmStudioStatus {
  running: boolean;
  baseUrl: string;
  models: string[];
  embedModel: string | null;
  providerExists: boolean;
  embeddingsOn: boolean;
}

export interface LmStudioConnectResult {
  status: LmStudioStatus;
  providerCreated: boolean;
  embeddingsEnabled: boolean;
}

export interface MainAgent {
  model: string;
  providerId: string;
  effectiveModel: string;
  providerName?: string;
  providerBaseUrl?: string;
  providers: Array<{ id: string; name: string }>;
  /** Agent backend id (which CLI/runtime drives turns); "" = the default
   *  Claude backend. Not to be confused with the embeddings preferredBackend/
   *  activeBackend fields below, an unrelated concept. */
  backendId: string;
  /** Every registered agent backend, for the selector. */
  backends: NamedBackend[];
  serviceInstalled: boolean;
  persona: string;
  autonomy: Autonomy;
  defaultLanguage: string;
  /** Global dry-run: mutating tools are echoed, not executed. */
  dryRun: boolean;
  /** Provider to fail over to when the plan is rate-limited ("" = off). */
  fallbackProviderId: string;
  /** Model id to use on the fallback provider ("" = provider default). */
  fallbackModel: string;
  /** Usage percent at/above which fallback engages. */
  fallbackThreshold: number;
  /** Live degraded-mode state when autonomous turns are running on the fallback. */
  degraded: { active: boolean; since?: string; reason?: string; provider?: string };
  /** The main bot's @username (from getMe), for a t.me link. */
  botUsername?: string;
  embeddings: EmbeddingConfig;
  /** User-preferred local backend when both are running (null = none). */
  preferredBackend: PreferredBackend | null;
  /** Which backend the active embedding config points at (null = off/custom). */
  activeBackend: PreferredBackend | null;
  /** Env-forced mode: "auto" (panel controls it) or "on"/"off" (locked by .env). */
  embeddingEnvMode: "auto" | "on" | "off";
  /** True when embeddings are in auto-detect mode (vs. a manual pin or off). */
  embeddingAuto: boolean;
  /** Named directory shortcuts injected into the system prompt each turn. */
  knownPaths: Array<{ label: string; path: string }>;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  // The plaintext token is never sent to the client (SEC-2); only whether one
  // is set and a masked hint of its last few chars.
  hasToken: boolean;
  tokenHint: string;
  purpose: "chat" | "voice";
  createdAt: number;
  updatedAt: number;
}

export interface VoiceSettingsView {
  sttEngine: "openai" | "vosk" | "xai";
  sttProviderId: string;
  sttProviderName?: string;
  sttModel: string;
  voskModelPath: string;
  ttsEngine: "openai" | "piper" | "xai";
  ttsProviderId: string;
  ttsProviderName?: string;
  ttsModel: string;
  ttsVoice: string;
  piperPath: string;
  piperModel: string;
  sendVoiceNotes: boolean;
  voiceProviders: Array<{ id: string; name: string }>;
}

export interface VoiceSettingsPatch {
  sttEngine?: "openai" | "vosk" | "xai" | "";
  sttProviderId?: string;
  sttModel?: string;
  voskModelPath?: string;
  ttsEngine?: "openai" | "piper" | "xai" | "";
  ttsProviderId?: string;
  ttsModel?: string;
  ttsVoice?: string;
  piperPath?: string;
  piperModel?: string;
  sendVoiceNotes?: boolean;
}

export interface LogEntry {
  seq: number;
  ts: number;
  level: "error" | "warn" | "info" | "debug";
  msg: string;
  meta?: Record<string, unknown>;
}

export interface LogUsageSummary {
  windowHours: number;
  filesScanned: number;
  totalToolCalls: number;
  tools: Array<{ name: string; count: number }>;
  commands: Array<{ name: string; count: number }>;
}

export interface UpdateStatus {
  branch: string;
  current: string;
  latest?: string;
  behindBy: number;
  available: boolean;
  commits: string[];
  checkedAt?: number;
  error?: string;
  checking: boolean;
  updating: boolean;
  serviceInstalled: boolean;
  /** Host platform (process.platform) so the UI can show the right manual command. */
  platform?: string;
  /** A turn/delegation is in flight — update/restore would interrupt it. */
  active?: boolean;
}

export type TunnelProviderId = "ngrok" | "cloudflare";
export type TunnelState = "stopped" | "starting" | "running" | "error";
export interface TunnelView {
  enabled: boolean;
  state: TunnelState;
  provider: TunnelProviderId;
  hasToken: boolean;
  domain: string;
  autoStart: boolean;
  basicAuth: boolean;
  basicAuthUser: string;
  hasPassword: boolean;
  url?: string;
  error?: string;
  startedAt?: number;
}
export interface TunnelPassword {
  user: string;
  password: string | null;
}

export interface PushView {
  configured: boolean;
  publicKey?: string;
  subscriptions: Array<{ id: string; label?: string; createdAt: number }>;
}

export interface AuditEvent {
  ts: number;
  source: string;
  action: string;
  detail?: Record<string, unknown>;
}
export interface AuditFacets {
  actors: string[];
  resources: string[];
  actions: string[];
}
export interface Anomaly {
  key: string;
  kind: "delete-burst" | "vault-offhours" | "new-grant";
  severity: "warning" | "critical";
  text: string;
  ts: number;
  count: number;
}
export interface AuditQueryParams {
  q?: string;
  actor?: string;
  action?: string;
  resource?: string;
  since?: number;
  limit?: number;
}

export const api = {
  me: () =>
    get<{ ok: boolean; chatEnabled: boolean; version: string; updateAvailable: boolean; updateCount: number; atlasName: string; brandName: string; branding?: Branding; brandingUnlocked?: boolean; subscriptionPlan: boolean; defaultWorkdir: string; homeDir: string; platform: string; allowedUserCount: number; panelHost: string; panelPort: number; tunnelEnabled: boolean; terminalEnabled: boolean }>("/api/me"),
  sendFeedback: (kind: "bug" | "suggestion" | "other", message: string, email?: string) =>
    req<{ ok: boolean }>("POST", "/api/feedback", { kind, message, email }),
  health: () => get<Health>("/api/health"),
  sessions: () => get<{ sessions: SessionView[] }>("/api/sessions"),
  searchConversations: (q: string, limit = 25) =>
    get<{ hits: ConversationHit[] }>(`/api/conversations/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  logs: (params?: { date?: string; q?: string; level?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.date) qs.set("date", params.date);
    if (params?.q) qs.set("q", params.q);
    if (params?.level) qs.set("level", params.level);
    if (params?.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{ logs: LogEntry[] }>(`/api/logs${suffix}`);
  },
  logDates: () => get<{ dates: string[] }>("/api/logs/dates"),
  logsSearch: (params?: { q?: string; level?: string; hours?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.level) qs.set("level", params.level);
    if (params?.hours) qs.set("hours", String(params.hours));
    if (params?.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{ logs: LogEntry[] }>(`/api/logs/search${suffix}`);
  },
  logsSummary: (hours?: number) =>
    get<LogUsageSummary>(`/api/logs/summary${hours ? `?hours=${hours}` : ""}`),
  schedules: () => get<{ schedules: ScheduleView[] }>("/api/schedules"),
  createSchedule: (s: { prompt: string; when: string; cwd?: string; webhookUrl?: string }) =>
    req<{ schedules: ScheduleView[] }>("POST", "/api/schedules", s),
  updateSchedule: (id: string, patch: { prompt?: string; when?: string; cwd?: string; webhookUrl?: string }) =>
    req<{ schedules: ScheduleView[] }>("PUT", `/api/schedules/${id}`, patch),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    req<{ schedules: ScheduleView[] }>("PUT", `/api/schedules/${id}/enabled`, { enabled }),
  runScheduleNow: (id: string) =>
    req<{ ok: boolean; schedules: ScheduleView[] }>("POST", `/api/schedules/${id}/run`, {}),
  deleteSchedule: (id: string) => req<{ ok: boolean }>("DELETE", `/api/schedules/${id}`),

  webhookTriggers: () =>
    get<{ triggers: WebhookTriggerView[]; baseUrl: string }>("/api/webhook-triggers"),
  createWebhookTrigger: (t: {
    name: string;
    prompt: string;
    cwd?: string;
    leadId?: string;
    enabled?: boolean;
  }) => req<{ trigger: WebhookTriggerView; triggers: WebhookTriggerView[] }>("POST", "/api/webhook-triggers", t),
  updateWebhookTrigger: (
    id: string,
    patch: { name?: string; prompt?: string; cwd?: string; leadId?: string; enabled?: boolean },
  ) => req<{ trigger: WebhookTriggerView; triggers: WebhookTriggerView[] }>("PUT", `/api/webhook-triggers/${id}`, patch),
  rotateWebhookTriggerSecret: (id: string) =>
    req<{ trigger: WebhookTriggerView; triggers: WebhookTriggerView[] }>("POST", `/api/webhook-triggers/${id}/rotate`, {}),
  webhookTriggerSecret: (id: string) =>
    get<{ secret: string; header: string; sampleBody: string; sampleSignature: string }>(
      `/api/webhook-triggers/${id}/secret`,
    ),
  deleteWebhookTrigger: (id: string) =>
    req<{ ok: boolean; triggers: WebhookTriggerView[] }>("DELETE", `/api/webhook-triggers/${id}`),

  usage: () => get<UsageSummary>("/api/usage"),
  usageAgents: () => get<{ agents: AgentUsageEntry[]; dailyByRole: AgentDailyByRole }>("/api/usage/agents"),

  prompt: () => get<PromptView>("/api/prompt"),
  savePrompt: (content: string) => req<PromptView>("PUT", "/api/prompt", { content }),
  restorePrompt: () => req<PromptView>("POST", "/api/prompt/restore"),

  skills: () => get<{ skills: Skill[] }>("/api/skills"),
  createSkill: (s: Partial<Skill>) => req<Skill>("POST", "/api/skills", s),
  updateSkill: (id: string, s: Partial<Skill>) => req<Skill>("PUT", `/api/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: boolean }>("DELETE", `/api/skills/${id}`),
  exportSkill: (id: string) => get<SkillBundle>(`/api/skills/${id}/export`),
  importSkill: (bundle: unknown) => req<Skill>("POST", "/api/skills/import", bundle),

  templates: () => get<{ templates: PromptTemplate[] }>("/api/templates"),
  createTemplate: (t: { name: string; description?: string; body: string }) =>
    req<PromptTemplate>("POST", "/api/templates", t),
  updateTemplate: (id: string, t: { name?: string; description?: string; body?: string }) =>
    req<PromptTemplate>("PUT", `/api/templates/${id}`, t),
  deleteTemplate: (id: string) => req<{ ok: boolean }>("DELETE", `/api/templates/${id}`),

  claudeFiles: () => get<{ roots: ClaudeRoot[] }>("/api/claude-files"),
  claudeFile: (path: string) =>
    get<{ path: string; content: string }>(`/api/claude-files/content?path=${encodeURIComponent(path)}`),
  saveClaudeFile: (path: string, content: string) =>
    req<{ ok: boolean }>("PUT", "/api/claude-files/content", { path, content }),

  tasks: () =>
    get<{ tasks: Task[]; columns: ColumnDef[]; wip: Wip; config: TaskRunConfig; queue: QueueState }>("/api/tasks"),
  saveTasksConfig: (c: Partial<TaskRunConfig>) =>
    req<{ config: TaskRunConfig }>("PUT", "/api/tasks/config", c),
  createTask: (t: {
    title: string;
    notes?: string;
    column?: Column;
    priority?: Priority;
    recurrence?: Recurrence;
  }) => req<Task>("POST", "/api/tasks", t),
  updateTask: (
    id: string,
    // recurrence is the rule (or null to clear), distinct from Task.recurrence
    // which wraps it with scheduling state.
    t: Partial<Omit<Task, "recurrence">> & { recurrence?: Recurrence | null },
  ) => req<Task>("PATCH", `/api/tasks/${id}`, t),
  reorderTasks: (moves: Array<{ id: string; column: Column; order: number }>) =>
    req<{ tasks: Task[] }>("POST", "/api/tasks/reorder", { moves }),
  deleteTask: (id: string) => req<{ ok: boolean }>("DELETE", `/api/tasks/${id}`),
  setWip: (column: Column, limit: number | null) =>
    req<{ wip: Wip }>("PUT", "/api/tasks/wip", { column, limit }),
  delegateTask: (id: string, leadId?: string) =>
    req<{ ok: boolean }>("POST", `/api/tasks/${id}/delegate`, leadId ? { leadId } : undefined),
  stopTask: (id: string) => req<{ ok: boolean }>("POST", `/api/tasks/${id}/stop`),
  retryTask: (id: string) =>
    req<{ ok: boolean; retryCount?: number }>("POST", `/api/tasks/${id}/retry`),
  unstickTask: (id: string) => req<{ ok: boolean }>("POST", `/api/tasks/${id}/unstick`),
  pauseQueue: () => req<QueueState>("POST", "/api/tasks/queue/pause"),
  resumeQueue: () => req<QueueState>("POST", "/api/tasks/queue/resume"),
  clearQueue: () => req<{ cleared: number; paused: boolean }>("POST", "/api/tasks/queue/clear"),
  addColumn: (name: string) => req<ColumnDef>("POST", "/api/tasks/columns", { name }),
  renameColumn: (id: string, name: string) => req<ColumnDef>("PUT", `/api/tasks/columns/${id}`, { name }),
  removeColumn: (id: string) => req<{ ok: boolean }>("DELETE", `/api/tasks/columns/${id}`),

  plan: () => get<PlanView>("/api/plan"),
  savePlan: (s: Partial<PlanSettings>) => req<PlanSettings>("PUT", "/api/plan", s),
  testReport: () => req<{ sent: boolean }>("POST", "/api/plan/report-test"),

  updateStatus: () => get<UpdateStatus>("/api/update"),
  checkUpdate: () => req<UpdateStatus>("POST", "/api/update/check"),
  runUpdate: () => req<{ started: boolean }>("POST", "/api/update/run"),
  restoreUpdate: () => req<{ started: boolean }>("POST", "/api/update/restore"),
  changelog: () => get<{ content: string }>("/api/update/changelog"),

  claudeUsage: () => get<ClaudeUsageSnapshot>("/api/claude-usage"),

  usageProbe: () => get<ProbeResult>("/api/usage-probe"),
  runProbe: () => req<{ ok: boolean; message: string }>("POST", "/api/usage-probe/run"),

  agent: () => get<MainAgent>("/api/agent"),
  saveAgent: (s: { model?: string; providerId?: string; backendId?: string; persona?: string; autonomy?: Autonomy; defaultLanguage?: string; dryRun?: boolean; fallbackProviderId?: string; fallbackModel?: string; fallbackThreshold?: number; knownPaths?: Array<{ label: string; path: string }> }) =>
    req<MainAgent>("PUT", "/api/agent", s),
  resetAgent: () => req<{ sessions: number; aborted: number }>("POST", "/api/agent/reset"),
  restartAgent: () => req<{ ok: boolean; restarting: boolean }>("POST", "/api/agent/restart"),
  saveEmbeddings: (s: { enabled: boolean; provider?: "ollama" | "openai"; baseUrl?: string; model?: string }) =>
    req<{ embeddings: EmbeddingConfig; activeBackend: PreferredBackend | null; embeddingAuto: boolean }>("PUT", "/api/agent/embeddings", s),
  embeddingsAuto: () =>
    req<{ embeddings: EmbeddingConfig; activeBackend: PreferredBackend | null; embeddingAuto: boolean }>("POST", "/api/agent/embeddings/auto"),
  savePreferredBackend: (preferredBackend: PreferredBackend | null) =>
    req<{ preferredBackend: PreferredBackend | null }>("PUT", "/api/agent/embeddings/preferred", { preferredBackend }),
  ollamaStatus: () => get<OllamaStatus>("/api/integrations/ollama"),
  ollamaConnect: () => req<OllamaConnectResult>("POST", "/api/integrations/ollama/connect"),
  lmStudioStatus: () => get<LmStudioStatus>("/api/integrations/lmstudio"),
  lmStudioConnect: () => req<LmStudioConnectResult>("POST", "/api/integrations/lmstudio/connect"),

  workers: () =>
    get<{
      workers: Worker[];
      skills: Array<{ id: string; name: string }>;
      providers: NamedProvider[];
      backends: NamedBackend[];
    }>("/api/workers"),
  createWorker: (w: Partial<Worker>) => req<Worker>("POST", "/api/workers", w),
  updateWorker: (id: string, w: Partial<Worker>) => req<Worker>("PUT", `/api/workers/${id}`, w),
  deleteWorker: (id: string) => req<{ ok: boolean }>("DELETE", `/api/workers/${id}`),
  runWorker: (id: string, prompt?: string) =>
    req<WorkerRun>("POST", `/api/workers/${id}/run`, prompt === undefined ? undefined : { prompt }),
  stopWorker: (id: string) => req<{ ok: boolean }>("POST", `/api/workers/${id}/stop`),
  workerRuns: (id: string) => get<{ runs: WorkerRun[] }>(`/api/workers/${id}/runs`),
  runLog: (runId: string) => get<{ events: RunLogEvent[] }>(`/api/runs/${runId}/log`),
  workerWizard: (body: { goal: string; context?: string; crew?: boolean; schedule?: string; cwd?: string }) =>
    req<{ configs: Partial<Worker>[] }>("POST", "/api/workers/wizard", body),

  status: () => get<StatusSnapshot>("/api/status"),

  connectors: () => get<{ connectors: Connector[] }>("/api/connectors"),
  saveConnector: (
    id: string,
    c: { secretId?: string; enabled?: boolean; scope?: ConnectorScope; expiresAt?: number | null },
  ) => req<Connector>("PUT", `/api/connectors/${id}`, c),

  gallery: (filter?: GalleryFilter) => {
    const qs = new URLSearchParams();
    if (filter?.tag) qs.set("tag", filter.tag);
    if (filter?.provider) qs.set("provider", filter.provider);
    if (filter?.from) qs.set("from", String(filter.from));
    if (filter?.to) qs.set("to", String(filter.to));
    if (filter?.q) qs.set("q", filter.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return get<{ images: GalleryImage[]; tags: string[] }>(`/api/gallery${suffix}`);
  },
  galleryImage: (id: string) => get<GalleryImage>(`/api/gallery/${id}`),
  galleryImageBlob: (id: string) => reqBlob(`/api/gallery/${id}/file`),
  saveGalleryImageTags: (id: string, tags: string[]) => req<GalleryImage>("PUT", `/api/gallery/${id}`, { tags }),
  deleteGalleryImage: (id: string) => req<{ ok: boolean }>("DELETE", `/api/gallery/${id}`),
  generateGalleryImage: (body: {
    providerId: ImageProviderId;
    prompt: string;
    size?: string;
    style?: string;
    model?: string;
    negativePrompt?: string;
    steps?: number;
    extraInput?: Record<string, unknown>;
  }) => req<GalleryImage>("POST", "/api/gallery/generate", body),

  webhookTools: () => get<{ tools: WebhookTool[] }>("/api/webhook-tools"),
  createWebhookTool: (t: WebhookToolInput) => req<WebhookTool>("POST", "/api/webhook-tools", t),
  updateWebhookTool: (id: string, t: WebhookToolInput) => req<WebhookTool>("PUT", `/api/webhook-tools/${id}`, t),
  deleteWebhookTool: (id: string) => req<{ ok: true }>("DELETE", `/api/webhook-tools/${id}`),

  branding: () => get<BrandingView>("/api/branding"),
  saveBranding: (b: Branding) => req<BrandingView>("PUT", "/api/branding", b),

  heartbeat: () => get<HeartbeatView>("/api/heartbeat"),
  saveHeartbeat: (c: Partial<HeartbeatConfig>) => req<HeartbeatView>("PUT", "/api/heartbeat", c),
  runHeartbeat: () => req<{ signals: number }>("POST", "/api/heartbeat/run"),

  audit: () => get<{ events: AuditEvent[] }>("/api/audit"),
  searchAudit: (params: AuditQueryParams = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    const s = qs.toString();
    return get<{ events: AuditEvent[] }>(`/api/audit/search${s ? `?${s}` : ""}`);
  },
  auditFacets: () => get<AuditFacets>("/api/audit/facets"),
  auditAnomalies: () => get<{ anomalies: Anomaly[] }>("/api/audit/anomalies"),

  vault: () =>
    get<{
      secrets: SecretView[];
      usages: Record<string, Array<{ kind: string; name: string }>>;
      keyRotatedAt?: number;
    }>("/api/vault"),
  createSecret: (s: { name: string; value: string; description?: string }) =>
    req<SecretView>("POST", "/api/vault", s),
  updateSecret: (id: string, s: { name?: string; value?: string; description?: string }) =>
    req<SecretView>("PUT", `/api/vault/${id}`, s),
  deleteSecret: (id: string) => req<{ ok: boolean }>("DELETE", `/api/vault/${id}`),
  revealSecret: (id: string) => get<{ value: string }>(`/api/vault/${id}/reveal`),
  importSecrets: () => req<{ imported: number }>("POST", "/api/vault/import"),
  rotateVaultKey: () => req<{ rotated: number; keyRotatedAt: number }>("POST", "/api/vault/rotate"),
  exportVault: (passphrase: string) => req<{ blob: string }>("POST", "/api/vault/export", { passphrase }),
  importVaultBackup: (blob: string, passphrase: string) =>
    req<{ imported: number }>("POST", "/api/vault/import-backup", { blob, passphrase }),

  // --- full-state backup & restore ---
  backupManifest: () => get<BackupManifest>("/api/backup"),
  /** POST the passphrase, get the encrypted archive back as a Blob (binary). */
  exportBackup: async (passphrase: string): Promise<Blob> => {
    const res = await fetch("/api/backup/export", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ passphrase }),
    });
    if (res.status === 401) throw new AuthError("unauthorized");
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* non-JSON body */
      }
      throw new ApiError(res.status, msg);
    }
    return res.blob();
  },
  importBackup: (archive: string, passphrase: string, includeVault: boolean) =>
    req<BackupImportResult>("POST", "/api/backup/import", { archive, passphrase, includeVault }),

  memories: (q?: string, all?: boolean) =>
    get<{ memories: MemoryEntry[] }>(
      `/api/memories${q ? `?q=${encodeURIComponent(q)}${all ? "&all=true" : ""}` : ""}`,
    ),
  memoryStats: () => get<MemoryStats>("/api/memories/stats"),
  createMemory: (m: { text: string; tags?: string[]; salience?: number; tier?: MemoryTier }) =>
    req<MemoryEntry>("POST", "/api/memories", m),
  updateMemory: (id: string, m: { text?: string; tags?: string[]; salience?: number; tier?: MemoryTier }) =>
    req<MemoryEntry>("PUT", `/api/memories/${id}`, m),
  setMemoryTier: (id: string, tier: MemoryTier) =>
    req<MemoryEntry>("PATCH", `/api/memories/${id}/tier`, { tier }),
  deleteMemory: (id: string) => req<{ ok: boolean }>("DELETE", `/api/memories/${id}`),
  exportMemories: () => get<MemoryExport>("/api/memories/export"),
  importMemories: (entries: unknown) =>
    req<{ imported: number; skipped: number }>("POST", "/api/memories/import", { entries }),

  suggestions: (status?: SuggestionStatus) =>
    get<{ suggestions: Suggestion[] }>(`/api/suggestions${status ? `?status=${status}` : ""}`),
  acceptSuggestion: (id: string) => req<Suggestion>("POST", `/api/suggestions/${id}/accept`),
  delegateSuggestion: (id: string, leadId?: string) =>
    req<{ suggestion: Suggestion; leadName?: string; started: boolean }>(
      "POST",
      `/api/suggestions/${id}/delegate`,
      leadId ? { leadId } : undefined,
    ),
  dismissSuggestion: (id: string) => req<Suggestion>("POST", `/api/suggestions/${id}/dismiss`),

  maintenance: () => get<MaintenanceStats>("/api/maintenance"),
  previewMaintenance: () => req<MaintenancePreview>("POST", "/api/maintenance/preview"),
  runMaintenance: () => req<MaintenanceStats>("POST", "/api/maintenance/run"),

  delegations: (limit?: number) =>
    get<{ delegations: DelegationRecord[] }>(
      `/api/delegations${limit ? `?limit=${limit}` : ""}`,
    ),

  council: (limit?: number) =>
    get<{ sessions: Record<string, unknown>[] }>(
      `/api/council${limit ? `?limit=${limit}` : ""}`,
    ),

  runCouncil: (proposal: string) =>
    req<{ session: Record<string, unknown> }>("POST", "/api/council", { proposal }),

  deleteCouncilSession: (id: string) => req<{ ok: boolean }>("DELETE", `/api/council/${id}`),

  councilRule: () => get<{ rule: CouncilRule }>("/api/council/rule"),
  setCouncilRule: (rule: CouncilRule) =>
    req<{ rule: CouncilRule }>("PUT", "/api/council/rule", { rule }),

  languages: () => get<{ languages: Record<string, string> }>("/api/languages"),

  chat: () => get<ChatView>("/api/chat"),
  sendChat: (text: string, planning = false, images?: ChatImage[]) =>
    req<ChatView>("POST", "/api/chat/send", { text, planning, images }),
  stopChat: () => req<{ ok: boolean }>("POST", "/api/chat/stop"),
  clearChat: () => req<ChatView>("POST", "/api/chat/clear"),
  chatSettings: (s: { cwd?: string; auto?: boolean }) =>
    req<ChatView>("PUT", "/api/chat/settings", s),
  resolveApproval: (approvalId: string, allow: boolean) =>
    req<{ ok: boolean }>("POST", "/api/chat/approve", { approvalId, allow }),
  resolveAsk: (id: string, answer: { optionIndices?: number[]; text?: string }) =>
    req<{ ok: boolean }>("POST", "/api/asks/resolve", { id, ...answer }),
  reactToMessage: (reaction: "up" | "down", text: string) =>
    req<{ ok: boolean; kind: string }>("POST", "/api/chat/react", { reaction, text }),

  // Per-agent interactive chat (talk to a specific worker / Lead).
  agentChat: (id: string) => get<AgentChatView>(`/api/agent-chat/${id}`),
  sendAgentChat: (id: string, text: string, planning = false, images?: ChatImage[]) =>
    req<AgentChatView>("POST", `/api/agent-chat/${id}/send`, { text, planning, images }),
  stopAgentChat: (id: string) => req<{ ok: boolean }>("POST", `/api/agent-chat/${id}/stop`),
  clearAgentChat: (id: string) => req<AgentChatView>("POST", `/api/agent-chat/${id}/clear`),
  agentChatSettings: (id: string, s: { cwd?: string }) =>
    req<AgentChatView>("PUT", `/api/agent-chat/${id}/settings`, s),

  providers: (purpose?: "chat" | "voice") =>
    get<{ providers: Provider[] }>(`/api/providers${purpose ? `?purpose=${purpose}` : ""}`),
  createProvider: (p: Partial<Provider>) => req<Provider>("POST", "/api/providers", p),
  updateProvider: (id: string, p: Partial<Provider>) =>
    req<Provider>("PUT", `/api/providers/${id}`, p),
  deleteProvider: (id: string) => req<{ ok: boolean }>("DELETE", `/api/providers/${id}`),
  fetchModels: (baseUrl: string, authToken: string) =>
    req<{ models: string[] }>("POST", "/api/providers/models", { baseUrl, authToken }),
  providerModels: (id: string) => get<{ models: string[] }>(`/api/providers/${id}/models`),

  voiceSettings: () => get<VoiceSettingsView>("/api/voice"),
  updateVoiceSettings: (patch: VoiceSettingsPatch) => req<VoiceSettingsView>("PUT", "/api/voice", patch),

  terminalStatus: () =>
    get<{ available: boolean; reason: "disabled" | "unsupported" | null; shell: string }>(
      "/api/terminal",
    ),
  terminalSpawn: (cols: number, rows: number) =>
    req<{ ok: boolean }>("POST", "/api/terminal/spawn", { cols, rows }),
  terminalResize: (cols: number, rows: number) =>
    req<{ ok: boolean }>("POST", "/api/terminal/resize", { cols, rows }),

  tunnel: () => get<TunnelView>("/api/tunnel"),
  saveTunnel: (s: { provider?: TunnelProviderId; authToken?: string; domain?: string; autoStart?: boolean; basicAuth?: boolean }) =>
    req<TunnelView>("PUT", "/api/tunnel", s),
  startTunnel: () => req<TunnelView>("POST", "/api/tunnel/start"),
  stopTunnel: () => req<TunnelView>("POST", "/api/tunnel/stop"),
  tunnelPassword: () => get<TunnelPassword>("/api/tunnel/password"),
  // No password → rotate to a fresh random one; a password → set it.
  setTunnelPassword: (password?: string) =>
    req<TunnelPassword>("POST", "/api/tunnel/password", password ? { password } : {}),

  // Web Push (PWA notifications).
  push: () => get<PushView>("/api/push"),
  pushSubscribe: (subscription: PushSubscriptionJSON, label?: string) =>
    req<{ ok: boolean; id: string }>("POST", "/api/push/subscribe", { subscription, label }),
  pushUnsubscribe: (id: string) => req<{ ok: boolean }>("DELETE", `/api/push/subscribe/${id}`),
  pushTest: () => req<{ ok: boolean; subscribers: number }>("POST", "/api/push/test"),
};
