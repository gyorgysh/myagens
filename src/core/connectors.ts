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
  { id: "gmail", name: "Gmail", description: "Read and send email.", credential: "Google OAuth token", status: "coming-soon" },
  { id: "gdrive", name: "Google Drive", description: "Browse and fetch files.", credential: "Google OAuth token", status: "coming-soon" },
  { id: "apple-calendar", name: "Apple Calendar", description: "Read and create events in macOS Calendar.", credential: "macOS Calendar access (EventKit)", status: "coming-soon" },
  { id: "apple-mail", name: "Apple Mail", description: "Read and send email via iCloud Mail.", credential: "iCloud app-specific password", status: "coming-soon" },
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
