// Thin client over the panel's /api + /ws. The token lives in localStorage and
// is sent as a Bearer header (REST) or ?token= query (WebSocket).

const TOKEN_KEY = "myhq.panel.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class AuthError extends Error {}

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
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

const get = <T>(path: string) => req<T>("GET", path);

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

// --- Shapes mirrored from src/core (kept in sync by hand; small + stable). ---

export interface UsageStat {
  turns: number;
  costUsd: number;
  durationMs: number;
}

export interface Health {
  ts: number;
  host: string;
  platform: string;
  uptimeSec: number;
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

export interface ScheduleView {
  id: string;
  chatId: number;
  cwd: string;
  prompt: string;
  spec: string;
  specRaw: string;
  nextRunAt: number;
  lastRunAt?: number;
  createdAt: number;
  enabled: boolean;
}

export interface UsageSummary {
  total: UsageStat;
  today: UsageStat;
  daily: Array<{ day: string } & UsageStat>;
}

export interface PromptView {
  personality: string;
  workFile: string;
  work: string;
  exists: boolean;
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
export interface TaskDelegation {
  status: "running" | "ok" | "error" | "stopped";
  runId: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  output?: string;
}
export interface Task {
  id: string;
  title: string;
  notes: string;
  column: Column;
  priority: Priority;
  parentId?: string;
  delegate?: TaskDelegation;
  order: number;
  /** Creator id stamped at create-time: "atlas", a worker/lead id, or "panel". */
  createdBy?: string;
  /** Friendly creator name resolved by the server (e.g. "Atlas", "Iris", "Panel"). */
  createdByName?: string;
  createdAt: number;
  updatedAt: number;
}
export type Wip = Record<string, number | undefined>;

export interface Worker {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  model: string;
  providerId: string;
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
  /** True when this Lead has a live Telegram bot listening (role+token+enabled). */
  listening?: boolean;
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

export interface Connector {
  id: string;
  name: string;
  description: string;
  credential: string;
  status: "coming-soon";
  secretId?: string;
  enabled: boolean;
}

export type HeartbeatMode = "off" | "alert" | "active";
export interface HeartbeatConfig {
  mode: HeartbeatMode;
  intervalMs: number;
  cpuPct: number;
  memPct: number;
  swapPct: number;
  diskPct: number;
  staleCardHours: number;
  spendAlertEnabled: boolean;
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
}

export interface ChatView {
  messages: ChatMessage[];
  cwd: string;
  busy: boolean;
  bypassAllowed: boolean;
  auto: boolean;
  hasContext: boolean;
  /** Approvals are handled in Telegram (the panel mirrors the main chat). */
  approvalsInTelegram?: boolean;
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
  serviceInstalled: boolean;
  persona: string;
  autonomy: Autonomy;
  defaultLanguage: string;
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
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  // The plaintext token is never sent to the client (SEC-2); only whether one
  // is set and a masked hint of its last few chars.
  hasToken: boolean;
  tokenHint: string;
  createdAt: number;
  updatedAt: number;
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

export const api = {
  me: () =>
    get<{ ok: boolean; chatEnabled: boolean; version: string; updateAvailable: boolean; atlasName: string; brandName: string }>("/api/me"),
  sessions: () => get<{ sessions: SessionView[] }>("/api/sessions"),
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
  createSchedule: (s: { prompt: string; when: string; cwd?: string }) =>
    req<{ schedules: ScheduleView[] }>("POST", "/api/schedules", s),
  updateSchedule: (id: string, patch: { prompt?: string; when?: string; cwd?: string }) =>
    req<{ schedules: ScheduleView[] }>("PUT", `/api/schedules/${id}`, patch),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    req<{ schedules: ScheduleView[] }>("PUT", `/api/schedules/${id}/enabled`, { enabled }),
  runScheduleNow: (id: string) =>
    req<{ ok: boolean; schedules: ScheduleView[] }>("POST", `/api/schedules/${id}/run`, {}),
  deleteSchedule: (id: string) => req<{ ok: boolean }>("DELETE", `/api/schedules/${id}`),
  usage: () => get<UsageSummary>("/api/usage"),

  prompt: () => get<PromptView>("/api/prompt"),
  savePrompt: (content: string) => req<PromptView>("PUT", "/api/prompt", { content }),

  skills: () => get<{ skills: Skill[] }>("/api/skills"),
  createSkill: (s: Partial<Skill>) => req<Skill>("POST", "/api/skills", s),
  updateSkill: (id: string, s: Partial<Skill>) => req<Skill>("PUT", `/api/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: boolean }>("DELETE", `/api/skills/${id}`),

  claudeFiles: () => get<{ roots: ClaudeRoot[] }>("/api/claude-files"),
  claudeFile: (path: string) =>
    get<{ path: string; content: string }>(`/api/claude-files/content?path=${encodeURIComponent(path)}`),
  saveClaudeFile: (path: string, content: string) =>
    req<{ ok: boolean }>("PUT", "/api/claude-files/content", { path, content }),

  tasks: () => get<{ tasks: Task[]; columns: ColumnDef[]; wip: Wip }>("/api/tasks"),
  createTask: (t: { title: string; notes?: string; column?: Column; priority?: Priority }) =>
    req<Task>("POST", "/api/tasks", t),
  updateTask: (id: string, t: Partial<Task>) => req<Task>("PATCH", `/api/tasks/${id}`, t),
  reorderTasks: (moves: Array<{ id: string; column: Column; order: number }>) =>
    req<{ tasks: Task[] }>("POST", "/api/tasks/reorder", { moves }),
  deleteTask: (id: string) => req<{ ok: boolean }>("DELETE", `/api/tasks/${id}`),
  setWip: (column: Column, limit: number | null) =>
    req<{ wip: Wip }>("PUT", "/api/tasks/wip", { column, limit }),
  delegateTask: (id: string) => req<{ ok: boolean }>("POST", `/api/tasks/${id}/delegate`),
  stopTask: (id: string) => req<{ ok: boolean }>("POST", `/api/tasks/${id}/stop`),
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

  claudeUsage: () => get<ClaudeUsageSnapshot>("/api/claude-usage"),

  usageProbe: () => get<ProbeResult>("/api/usage-probe"),
  runProbe: () => req<{ ok: boolean; message: string }>("POST", "/api/usage-probe/run"),

  agent: () => get<MainAgent>("/api/agent"),
  saveAgent: (s: { model?: string; providerId?: string; persona?: string; autonomy?: Autonomy; defaultLanguage?: string }) =>
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
      providers: Array<{ id: string; name: string }>;
    }>("/api/workers"),
  createWorker: (w: Partial<Worker>) => req<Worker>("POST", "/api/workers", w),
  updateWorker: (id: string, w: Partial<Worker>) => req<Worker>("PUT", `/api/workers/${id}`, w),
  deleteWorker: (id: string) => req<{ ok: boolean }>("DELETE", `/api/workers/${id}`),
  runWorker: (id: string) => req<WorkerRun>("POST", `/api/workers/${id}/run`),
  stopWorker: (id: string) => req<{ ok: boolean }>("POST", `/api/workers/${id}/stop`),
  workerRuns: (id: string) => get<{ runs: WorkerRun[] }>(`/api/workers/${id}/runs`),
  workerWizard: (body: { goal: string; context?: string; crew?: boolean; schedule?: string; cwd?: string }) =>
    req<{ configs: Partial<Worker>[] }>("POST", "/api/workers/wizard", body),

  status: () => get<StatusSnapshot>("/api/status"),

  connectors: () => get<{ connectors: Connector[] }>("/api/connectors"),
  saveConnector: (id: string, c: { secretId?: string; enabled?: boolean }) =>
    req<Connector>("PUT", `/api/connectors/${id}`, c),

  heartbeat: () => get<HeartbeatView>("/api/heartbeat"),
  saveHeartbeat: (c: Partial<HeartbeatConfig>) => req<HeartbeatView>("PUT", "/api/heartbeat", c),
  runHeartbeat: () => req<{ signals: number }>("POST", "/api/heartbeat/run"),

  vault: () => get<{ secrets: SecretView[] }>("/api/vault"),
  createSecret: (s: { name: string; value: string; description?: string }) =>
    req<SecretView>("POST", "/api/vault", s),
  updateSecret: (id: string, s: { name?: string; value?: string; description?: string }) =>
    req<SecretView>("PUT", `/api/vault/${id}`, s),
  deleteSecret: (id: string) => req<{ ok: boolean }>("DELETE", `/api/vault/${id}`),
  revealSecret: (id: string) => get<{ value: string }>(`/api/vault/${id}/reveal`),
  importSecrets: () => req<{ imported: number }>("POST", "/api/vault/import"),

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

  suggestions: (status?: SuggestionStatus) =>
    get<{ suggestions: Suggestion[] }>(`/api/suggestions${status ? `?status=${status}` : ""}`),
  acceptSuggestion: (id: string) => req<Suggestion>("POST", `/api/suggestions/${id}/accept`),
  delegateSuggestion: (id: string) =>
    req<{ suggestion: Suggestion; leadName?: string; started: boolean }>(
      "POST",
      `/api/suggestions/${id}/delegate`,
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

  languages: () => get<{ languages: Record<string, string> }>("/api/languages"),

  chat: () => get<ChatView>("/api/chat"),
  sendChat: (text: string) => req<ChatView>("POST", "/api/chat/send", { text }),
  stopChat: () => req<{ ok: boolean }>("POST", "/api/chat/stop"),
  clearChat: () => req<ChatView>("POST", "/api/chat/clear"),
  chatSettings: (s: { cwd?: string; auto?: boolean }) =>
    req<ChatView>("PUT", "/api/chat/settings", s),

  providers: () => get<{ providers: Provider[] }>("/api/providers"),
  createProvider: (p: Partial<Provider>) => req<Provider>("POST", "/api/providers", p),
  updateProvider: (id: string, p: Partial<Provider>) =>
    req<Provider>("PUT", `/api/providers/${id}`, p),
  deleteProvider: (id: string) => req<{ ok: boolean }>("DELETE", `/api/providers/${id}`),
  fetchModels: (baseUrl: string, authToken: string) =>
    req<{ models: string[] }>("POST", "/api/providers/models", { baseUrl, authToken }),
  providerModels: (id: string) => get<{ models: string[] }>(`/api/providers/${id}/models`),

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
};
