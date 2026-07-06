import { randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "connectors.json";

/**
 * Catalog of external MCP connectors, grouped into four `category` buckets for
 * the panel's filter tabs: `productivity` (Notion, Google Calendar, Gmail,
 * Google Drive, Apple Calendar, Apple Mail, Slack), `dev` (GitHub, Unreal
 * Engine, Unity), `database` (PostgreSQL, SQLite), and `image` (Recraft,
 * Ideogram, Replicate, fal.ai, Local Stable Diffusion). All are **live**: each
 * is wired to a real MCP server in `src/mcp/connectorsMcp.ts` (image-gen tools
 * in `src/mcp/imageGenMcp.ts`), contributing tools to every interactive/delegated
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

/** Broad grouping used for panel category filter tabs. */
export type ConnectorCategory = "productivity" | "dev" | "database" | "image" | "social";

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
  /** Grouping for the panel's category filter tabs. */
  category: ConnectorCategory;
  /**
   * Multi-account connectors (the social platforms) hold a list of named
   * accounts, each with its own vault credential, instead of the single
   * `secretId`. Tools take an `account` label so different agents can drive
   * different accounts (e.g. one Lead posts as the company, another as a
   * side project).
   */
  multiAccount?: boolean;
}

export const CONNECTORS: ConnectorDef[] = [
  { id: "notion", name: "Notion", description: "Search, read, and create Notion pages/databases.", credential: "Notion integration token", status: "live", hasWrite: true, category: "productivity" },
  { id: "gcal", name: "Google Calendar", description: "List and create calendar events.", credential: "Google OAuth access token", status: "live", hasWrite: true, category: "productivity" },
  { id: "gmail", name: "Gmail", description: "List, read, send, draft, label, and delete Gmail messages.", credential: "Google OAuth access token (gmail + gmail.send scope)", status: "live", hasWrite: true, category: "productivity" },
  { id: "gdrive", name: "Google Drive", description: "List, read, create, update, move, share, and delete Drive files.", credential: "Google OAuth access token (drive scope)", status: "live", hasWrite: true, category: "productivity" },
  { id: "apple-calendar", name: "Apple Calendar", description: "List calendars and events, create, update, and delete events via iCloud CalDAV.", credential: "iCloud email:app-specific-password", status: "live", hasWrite: true, category: "productivity" },
  { id: "apple-mail", name: "Apple Mail", description: "List folders, read and search messages, send and delete email via iCloud IMAP/SMTP.", credential: "iCloud email:app-specific-password", status: "live", hasWrite: true, category: "productivity" },
  { id: "slack", name: "Slack", description: "List channels, read and search messages; post messages, reply in threads, and upload files via the Slack Web API.", credential: "Slack bot token (xoxb-…)", status: "live", hasWrite: true, category: "productivity" },
  { id: "github", name: "GitHub", description: "List repos, issues and PRs, read file contents; create/comment on issues, open PRs, and push files.", credential: "GitHub personal access token (ghp_… / fine-grained)", status: "live", hasWrite: true, category: "dev" },
  { id: "jira", name: "Jira", description: "List projects, search issues (JQL), read issue detail; create issues, transition status, and add comments in Jira Cloud.", credential: "email:api-token@your-site.atlassian.net", status: "live", hasWrite: true, category: "dev" },
  { id: "linear", name: "Linear", description: "List teams and projects, search issues, read issue detail; create issues, move issue state, and add comments via the Linear GraphQL API.", credential: "Linear API key (lin_api_…)", status: "live", hasWrite: true, category: "dev" },
  { id: "unreal-engine", name: "Unreal Engine", description: "Control a running Unreal Engine 5.8+ editor via the built-in MCP plugin (no credential needed; enable the plugin and toggle this on).", credential: "Editor MCP URL (optional override; defaults to http://127.0.0.1:8000/mcp)", status: "live", hasWrite: true, category: "dev" },
  { id: "unity", name: "Unity", description: "Control a running Unity Editor via the mcp-unity package (CoderGamester). Requires Node.js 18+.", credential: "Absolute path to mcp-unity server script (e.g. /path/to/project/Library/PackageCache/com.gamelovers.mcp-unity@<hash>/Server~/build/index.js)", status: "live", hasWrite: true, category: "dev" },
  { id: "postgres", name: "PostgreSQL", description: "Inspect and query a PostgreSQL database: list tables, describe schemas, run read-only SELECTs (and, with write scope, mutating statements).", credential: "PostgreSQL connection string (postgresql://user:pass@host:5432/db)", status: "live", hasWrite: true, category: "database" },
  { id: "sqlite", name: "SQLite", description: "Inspect and query a local SQLite database file: list tables, describe schemas, run read-only SELECTs (and, with write scope, mutating statements).", credential: "Absolute path to the SQLite database file (e.g. /path/to/app.db)", status: "live", hasWrite: true, category: "database" },
  { id: "recraft", name: "Recraft", description: "Generate images via Recraft: strong at web design assets, icon sets, and isometric/vector illustration.", credential: "Recraft API key", status: "live", hasWrite: false, category: "image" },
  { id: "ideogram", name: "Ideogram", description: "Generate images via Ideogram: strong at images with correct rendered text (buttons, labels, posters).", credential: "Ideogram API key", status: "live", hasWrite: false, category: "image" },
  { id: "replicate", name: "Replicate", description: "Generic gateway to hundreds of hosted image models (Flux, SDXL, LoRA fine-tunes, and more) via a model id you supply per generation.", credential: "Replicate API token", status: "live", hasWrite: false, category: "image" },
  { id: "fal", name: "fal.ai", description: "Fast inference gateway for Flux, SDXL, and other diffusion models via a model id you supply per generation.", credential: "fal.ai API key", status: "live", hasWrite: false, category: "image" },
  { id: "local_sd", name: "Local Stable Diffusion", description: "Generate images through your own Automatic1111/SD.Next/Forge-compatible server — no API key, no cloud cost.", credential: "Base URL of the local server (e.g. http://127.0.0.1:7860)", status: "live", hasWrite: false, category: "image" },
  { id: "bluesky", name: "Bluesky", description: "Search posts, read your timeline and notifications; post, reply, and delete posts on Bluesky. Supports multiple accounts.", credential: "handle:app-password (e.g. me.bsky.social:xxxx-xxxx-xxxx-xxxx — generate under Settings → App Passwords)", status: "live", hasWrite: true, category: "social", multiAccount: true },
  { id: "mastodon", name: "Mastodon", description: "Search, read your home timeline and notifications; post, reply, and delete statuses on any Mastodon instance. Supports multiple accounts.", credential: "access-token@instance (e.g. AbC123@mastodon.social — token from Preferences → Development)", status: "live", hasWrite: true, category: "social", multiAccount: true },
  { id: "discord", name: "Discord", description: "List servers and channels, read recent messages; post messages as a bot. Supports multiple bot accounts.", credential: "Discord bot token (from the Developer Portal; invite the bot to your server)", status: "live", hasWrite: true, category: "social", multiAccount: true },
  { id: "reddit", name: "Reddit", description: "Search Reddit, browse subreddits, read posts and comments; submit posts and comment. Supports multiple accounts.", credential: "client_id:client_secret:username:password (create a \"script\" app at reddit.com/prefs/apps)", status: "live", hasWrite: true, category: "social", multiAccount: true },
  { id: "x", name: "X (Twitter)", description: "Post, reply, and delete tweets via the X API. The free API tier is effectively write-only (posting works; reading requires a paid tier). Supports multiple accounts.", credential: "api_key:api_secret:access_token:access_secret (OAuth 1.0a keys from developer.x.com, app with Read & Write)", status: "live", hasWrite: true, category: "social", multiAccount: true },
];

/** One named account on a multi-account (social) connector. */
export interface ConnectorAccount {
  id: string;
  /** Short human label the agent uses to pick the account (e.g. "company"). */
  label: string;
  /** Vault secret id (`vault:<id>`) holding this account's credential. */
  secretId: string;
}

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
  /** Named accounts for `multiAccount` connectors (socials). */
  accounts?: ConnectorAccount[];
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
  /** Named accounts (multi-account connectors only; empty otherwise). */
  accounts: ConnectorAccount[];
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
      accounts: config[c.id]?.accounts ?? [],
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

// ---------------------------------------------------------------------------
// Multi-account CRUD (social connectors)
// ---------------------------------------------------------------------------

/** Validation/normalisation shared by add + update. Returns an error string or the clean label. */
function cleanLabel(label: string, existing: ConnectorAccount[], selfId?: string): string | { error: string } {
  const l = label.trim();
  if (!l) return { error: "label required" };
  if (l.length > 40) return { error: "label too long (max 40 chars)" };
  if (existing.some((a) => a.id !== selfId && a.label.toLowerCase() === l.toLowerCase())) {
    return { error: "an account with that label already exists" };
  }
  return l;
}

/** Add a named account to a multi-account connector. Returns the view or an error. */
export function addConnectorAccount(
  id: string,
  input: { label: string; secretId: string },
): ConnectorView | { error: string } {
  const def = CONNECTORS.find((c) => c.id === id);
  if (!def) return { error: "unknown connector" };
  if (!def.multiAccount) return { error: "connector does not support accounts" };
  if (!input.secretId) return { error: "secretId required" };
  const file = load();
  const cur = file.config[id] ?? { enabled: false };
  const accounts = cur.accounts ?? [];
  const label = cleanLabel(input.label, accounts);
  if (typeof label !== "string") return label;
  const account: ConnectorAccount = { id: randomBytes(6).toString("hex"), label, secretId: input.secretId };
  cur.accounts = [...accounts, account];
  file.config[id] = cur;
  saveJson<ConnectorFile>(FILE, file);
  audit("connector.account.add", { id, accountId: account.id, label: account.label });
  return listConnectors().find((c) => c.id === id)!;
}

/** Update an account's label and/or credential. Returns the view or an error. */
export function updateConnectorAccount(
  id: string,
  accountId: string,
  patch: { label?: string; secretId?: string },
): ConnectorView | { error: string } {
  const file = load();
  const accounts = file.config[id]?.accounts ?? [];
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return { error: "account not found" };
  if (patch.label !== undefined) {
    const label = cleanLabel(patch.label, accounts, accountId);
    if (typeof label !== "string") return label;
    account.label = label;
  }
  if (patch.secretId !== undefined) {
    if (!patch.secretId) return { error: "secretId required" };
    account.secretId = patch.secretId;
  }
  saveJson<ConnectorFile>(FILE, file);
  audit("connector.account.update", { id, accountId, label: account.label });
  return listConnectors().find((c) => c.id === id)!;
}

/** Remove an account from a multi-account connector. Returns the view or an error. */
export function removeConnectorAccount(id: string, accountId: string): ConnectorView | { error: string } {
  const file = load();
  const cur = file.config[id];
  const accounts = cur?.accounts ?? [];
  if (!cur || !accounts.some((a) => a.id === accountId)) return { error: "account not found" };
  cur.accounts = accounts.filter((a) => a.id !== accountId);
  saveJson<ConnectorFile>(FILE, file);
  audit("connector.account.remove", { id, accountId });
  return listConnectors().find((c) => c.id === id)!;
}
