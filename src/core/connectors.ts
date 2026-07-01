import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "connectors.json";

/**
 * Catalog of external MCP connectors. All twelve are **live** (Notion, Google
 * Calendar, Gmail, Google Drive, Apple Calendar, Apple Mail, Slack, GitHub,
 * Unreal Engine, Unity, PostgreSQL, SQLite): each is wired to a real MCP server
 * in `src/mcp/connectorsMcp.ts`, contributing tools to every interactive/delegated
 * run once enabled. Most connectors require a vault-attached credential; the
 * Unreal Engine connector is credential-free (SSE to local editor), the
 * Unity connector credential is the path to the mcp-unity server script, the
 * PostgreSQL credential is a connection string, and the SQLite credential is a
 * path to the database file.
 * The `credential` field on each def is the human-readable hint for what
 * secret to vault (token type / format), surfaced in the panel.
 */
/**
 * Access scope for a connector's tools:
 *  - `read`  : only read-only tools (list/get/search) are exposed.
 *  - `write` : read-only **and** mutating tools (create/update/send/delete).
 * Lets a user grant e.g. read-only email while keeping send/delete off.
 */
export type ConnectorScope = "read" | "write";

export interface ConnectorDef {
  id: string;
  name: string;
  description: string;
  /** What credential it will need (free text; resolved from the vault later). */
  credential: string;
  status: "live" | "coming-soon";
  /**
   * Whether this connector has mutating tools at all. Read-only connectors
   * ignore the scope toggle (nothing to gate); the panel hides the control.
   */
  hasWrite: boolean;
}

export const CONNECTORS: ConnectorDef[] = [
  { id: "notion", name: "Notion", description: "Search, read, and create Notion pages/databases.", credential: "Notion integration token", status: "live", hasWrite: true },
  { id: "gcal", name: "Google Calendar", description: "List and create calendar events.", credential: "Google OAuth access token", status: "live", hasWrite: true },
  { id: "gmail", name: "Gmail", description: "List, read, send, draft, label, and delete Gmail messages.", credential: "Google OAuth access token (gmail + gmail.send scope)", status: "live", hasWrite: true },
  { id: "gdrive", name: "Google Drive", description: "List, read, create, update, move, share, and delete Drive files.", credential: "Google OAuth access token (drive scope)", status: "live", hasWrite: true },
  { id: "apple-calendar", name: "Apple Calendar", description: "List calendars and events, create, update, and delete events via iCloud CalDAV.", credential: "iCloud email:app-specific-password", status: "live", hasWrite: true },
  { id: "apple-mail", name: "Apple Mail", description: "List folders, read and search messages, send and delete email via iCloud IMAP/SMTP.", credential: "iCloud email:app-specific-password", status: "live", hasWrite: true },
  { id: "slack", name: "Slack", description: "List channels, read and search messages; post messages, reply in threads, and upload files via the Slack Web API.", credential: "Slack bot token (xoxb-…)", status: "live", hasWrite: true },
  { id: "github", name: "GitHub", description: "List repos, issues and PRs, read file contents; create/comment on issues, open PRs, and push files.", credential: "GitHub personal access token (ghp_… / fine-grained)", status: "live", hasWrite: true },
  { id: "unreal-engine", name: "Unreal Engine", description: "Control a running Unreal Engine 5.8+ editor via the built-in MCP plugin (no credential needed; enable the plugin and toggle this on).", credential: "Editor MCP URL (optional override; defaults to http://127.0.0.1:8000/mcp)", status: "live", hasWrite: true },
  { id: "unity", name: "Unity", description: "Control a running Unity Editor via the mcp-unity package (CoderGamester). Requires Node.js 18+.", credential: "Absolute path to mcp-unity server script (e.g. /path/to/project/Library/PackageCache/com.gamelovers.mcp-unity@<hash>/Server~/build/index.js)", status: "live", hasWrite: true },
  { id: "postgres", name: "PostgreSQL", description: "Inspect and query a PostgreSQL database: list tables, describe schemas, run read-only SELECTs (and, with write scope, mutating statements).", credential: "PostgreSQL connection string (postgresql://user:pass@host:5432/db)", status: "live", hasWrite: true },
  { id: "sqlite", name: "SQLite", description: "Inspect and query a local SQLite database file: list tables, describe schemas, run read-only SELECTs (and, with write scope, mutating statements).", credential: "Absolute path to the SQLite database file (e.g. /path/to/app.db)", status: "live", hasWrite: true },
];

interface ConnectorConfig {
  /** Vault secret id (`vault:<id>`) holding this connector's credential. */
  secretId?: string;
  enabled: boolean;
  /** Access scope; defaults to read-only when unset. */
  scope?: ConnectorScope;
  /**
   * Optional epoch-ms at which the stored OAuth/token credential expires. Set
   * for connectors whose tokens are short-lived (Google access tokens et al.)
   * so the panel can warn before they go stale. Undefined = no known expiry.
   */
  expiresAt?: number;
}

/** How soon (ms) before expiry we start warning. */
const EXPIRY_WARN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/** Credential freshness derived from `expiresAt`. */
export type ConnectorTokenStatus = "none" | "ok" | "expiring" | "expired";

/** Classify a connector's credential freshness from its expiry timestamp. */
export function tokenStatus(expiresAt: number | undefined, now = Date.now()): ConnectorTokenStatus {
  if (expiresAt === undefined) return "none";
  if (expiresAt <= now) return "expired";
  if (expiresAt - now <= EXPIRY_WARN_WINDOW_MS) return "expiring";
  return "ok";
}

interface ConnectorFile {
  version: 1;
  config: Record<string, ConnectorConfig>;
}

export interface ConnectorView extends ConnectorDef {
  secretId?: string;
  enabled: boolean;
  /** Resolved access scope (defaults to read-only). */
  scope: ConnectorScope;
  /** Epoch-ms token expiry, if tracked. */
  expiresAt?: number;
  /** Derived credential freshness from `expiresAt`. */
  tokenStatus: ConnectorTokenStatus;
}

function load(): ConnectorFile {
  return loadJson<ConnectorFile>(FILE, { version: 1, config: {} });
}

export function listConnectors(): ConnectorView[] {
  const { config } = load();
  return CONNECTORS.map((c) => {
    const expiresAt = config[c.id]?.expiresAt;
    return {
      ...c,
      secretId: config[c.id]?.secretId,
      enabled: config[c.id]?.enabled ?? false,
      scope: config[c.id]?.scope ?? "read",
      expiresAt,
      tokenStatus: tokenStatus(expiresAt),
    };
  });
}

export function setConnector(
  id: string,
  patch: { secretId?: string; enabled?: boolean; scope?: ConnectorScope; expiresAt?: number | null },
): ConnectorView | undefined {
  const def = CONNECTORS.find((c) => c.id === id);
  if (!def) return undefined;
  const file = load();
  const cur = file.config[id] ?? { enabled: false };
  if (patch.secretId !== undefined) cur.secretId = patch.secretId || undefined;
  if (patch.enabled !== undefined) cur.enabled = patch.enabled;
  if (patch.scope !== undefined && (patch.scope === "read" || patch.scope === "write")) {
    cur.scope = patch.scope;
  }
  // null clears the expiry; a positive number sets it; undefined leaves it be.
  if (patch.expiresAt === null) cur.expiresAt = undefined;
  else if (typeof patch.expiresAt === "number" && patch.expiresAt > 0) cur.expiresAt = patch.expiresAt;
  file.config[id] = cur;
  saveJson<ConnectorFile>(FILE, file);
  audit("connector.update", { id, enabled: cur.enabled, scope: cur.scope ?? "read" });
  return listConnectors().find((c) => c.id === id);
}

/** The resolved access scope for a connector (read-only when unset/unknown). */
export function connectorScope(id: string): ConnectorScope {
  return load().config[id]?.scope ?? "read";
}
