// Thin client over the panel's /api + /ws. The token lives in localStorage and
// is sent as a Bearer header (REST) or ?token= query (WebSocket).

const TOKEN_KEY = "cct.panel.token";

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

async function get<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) throw new AuthError("unauthorized");
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
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
  mode: "safe" | "auto";
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
  nextRunAt: number;
  lastRunAt?: number;
  createdAt: number;
}

export interface UsageSummary {
  total: UsageStat;
  today: UsageStat;
  daily: Array<{ day: string } & UsageStat>;
}

export const api = {
  sessions: () => get<{ sessions: SessionView[] }>("/api/sessions"),
  schedules: () => get<{ schedules: ScheduleView[] }>("/api/schedules"),
  usage: () => get<UsageSummary>("/api/usage"),
};
