import { loadJson, saveJson } from "./jsonStore.js";
import { audit } from "./audit.js";

const FILE = "connectors.json";

/**
 * Catalog of external MCP connectors. Two are **live** (Notion, Google
 * Calendar): wired to a real MCP server in `src/mcp/connectorsMcp.ts`,
 * contributing tools to every interactive/delegated run once enabled with a
 * vault-attached credential. The rest are placeholders ("coming-soon"): the
 * registration surface + credential slot exist so the panel can show what's
 * planned, but no MCP server is wired yet. Telegram is our channel, so Slack is
 * intentionally absent.
 */
export interface ConnectorDef {
  id: string;
  name: string;
  description: string;
  /** What credential it will need (free text; resolved from the vault later). */
  credential: string;
  status: "live" | "coming-soon";
}

export const CONNECTORS: ConnectorDef[] = [
  { id: "notion", name: "Notion", description: "Search, read, and create Notion pages/databases.", credential: "Notion integration token", status: "live" },
  { id: "gcal", name: "Google Calendar", description: "List and create calendar events.", credential: "Google OAuth access token", status: "live" },
  { id: "gmail", name: "Gmail", description: "List, read, send, draft, label, and delete Gmail messages.", credential: "Google OAuth access token (gmail + gmail.send scope)", status: "live" },
  { id: "gdrive", name: "Google Drive", description: "List, read, create, update, move, share, and delete Drive files.", credential: "Google OAuth access token (drive scope)", status: "live" },
  { id: "apple-calendar", name: "Apple Calendar", description: "List calendars and events, create, update, and delete events via iCloud CalDAV.", credential: "iCloud email:app-specific-password", status: "live" },
  { id: "apple-mail", name: "Apple Mail", description: "List folders, read and search messages, send and delete email via iCloud IMAP/SMTP.", credential: "iCloud email:app-specific-password", status: "live" },
];

interface ConnectorConfig {
  /** Vault secret id (`vault:<id>`) holding this connector's credential. */
  secretId?: string;
  enabled: boolean;
}

interface ConnectorFile {
  version: 1;
  config: Record<string, ConnectorConfig>;
}

export interface ConnectorView extends ConnectorDef {
  secretId?: string;
  enabled: boolean;
}

function load(): ConnectorFile {
  return loadJson<ConnectorFile>(FILE, { version: 1, config: {} });
}

export function listConnectors(): ConnectorView[] {
  const { config } = load();
  return CONNECTORS.map((c) => ({
    ...c,
    secretId: config[c.id]?.secretId,
    enabled: config[c.id]?.enabled ?? false,
  }));
}

export function setConnector(id: string, patch: { secretId?: string; enabled?: boolean }): ConnectorView | undefined {
  const def = CONNECTORS.find((c) => c.id === id);
  if (!def) return undefined;
  const file = load();
  const cur = file.config[id] ?? { enabled: false };
  if (patch.secretId !== undefined) cur.secretId = patch.secretId || undefined;
  if (patch.enabled !== undefined) cur.enabled = patch.enabled;
  file.config[id] = cur;
  saveJson<ConnectorFile>(FILE, file);
  audit("connector.update", { id, enabled: cur.enabled });
  return listConnectors().find((c) => c.id === id);
}
