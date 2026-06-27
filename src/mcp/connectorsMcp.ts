import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listConnectors } from "../core/connectors.js";
import { resolveSecret } from "../core/vault.js";
import { log } from "../logger.js";

/**
 * Live external connectors exposed as in-process MCP servers. Unlike the
 * placeholder catalog in `core/connectors.ts`, these talk to real APIs using a
 * vault-stored credential. A connector only contributes tools when it is both
 * `enabled` and has a `secretId` attached in the panel Connectors view, so the
 * agent never sees a tool it has no credential for.
 *
 * Currently wired: Notion (integration token) and Google Calendar (OAuth access
 * token). `buildConnectorMcps()` returns a `{ name: server }` map ready to spread
 * into a `runTurn` `mcpServers` object; it's empty when nothing is configured.
 */

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

/** Resolve the live, enabled credential for a connector id, or undefined. */
function credentialFor(id: string): string | undefined {
  const c = listConnectors().find((x) => x.id === id);
  if (!c || !c.enabled || !c.secretId) return undefined;
  const token = resolveSecret(c.secretId);
  return token || undefined;
}

/** Compact a fetch error / non-2xx body into a short tool-result string. */
async function asError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {
    /* ignore */
  }
  return `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

function notionMcp(token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  return createSdkMcpServer({
    name: "notion",
    version: "1.0.0",
    tools: [
      tool(
        "notion_search",
        "Search Notion pages and databases the integration can access. Returns " +
          "matching items with their ids and titles.",
        {
          query: z.string().describe("Text to search for."),
          pageSize: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
        },
        async (a) => {
          const res = await fetch(`${NOTION_BASE}/search`, {
            method: "POST",
            headers,
            body: JSON.stringify({ query: a.query, page_size: a.pageSize ?? 10 }),
          });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { results?: NotionObject[] };
          const items = (data.results ?? []).map(summarizeNotion);
          return text(items.length ? items.join("\n") : "No matches.");
        },
      ),
      tool(
        "notion_get_page",
        "Fetch a Notion page's properties (and a preview of its title) by id.",
        { pageId: z.string().describe("The page id (with or without dashes).") },
        async (a) => {
          const res = await fetch(`${NOTION_BASE}/pages/${encodeURIComponent(a.pageId)}`, { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as NotionObject;
          return text(summarizeNotion(data));
        },
      ),
      tool(
        "notion_query_database",
        "Query a Notion database, returning its rows (pages). Optionally filter " +
          "by a property and value (equals match on title/rich_text/select).",
        {
          databaseId: z.string(),
          pageSize: z.number().int().min(1).max(100).optional(),
        },
        async (a) => {
          const res = await fetch(`${NOTION_BASE}/databases/${encodeURIComponent(a.databaseId)}/query`, {
            method: "POST",
            headers,
            body: JSON.stringify({ page_size: a.pageSize ?? 25 }),
          });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { results?: NotionObject[] };
          const rows = (data.results ?? []).map(summarizeNotion);
          return text(rows.length ? rows.join("\n") : "No rows.");
        },
      ),
      tool(
        "notion_create_page",
        "Create a new page. Provide either a parent database id (the page becomes " +
          "a row) or a parent page id (the page becomes a child), plus a title.",
        {
          title: z.string(),
          parentDatabaseId: z.string().optional(),
          parentPageId: z.string().optional(),
          body: z.string().optional().describe("Optional plain-text body paragraph."),
        },
        async (a) => {
          if (!a.parentDatabaseId && !a.parentPageId) {
            return text("Provide parentDatabaseId or parentPageId.");
          }
          const parent = a.parentDatabaseId
            ? { database_id: a.parentDatabaseId }
            : { page_id: a.parentPageId };
          const properties = a.parentDatabaseId
            ? { Name: { title: [{ text: { content: a.title } }] } }
            : { title: { title: [{ text: { content: a.title } }] } };
          const children = a.body
            ? [
                {
                  object: "block",
                  type: "paragraph",
                  paragraph: { rich_text: [{ type: "text", text: { content: a.body } }] },
                },
              ]
            : undefined;
          const res = await fetch(`${NOTION_BASE}/pages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ parent, properties, ...(children ? { children } : {}) }),
          });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as NotionObject;
          return text(`Created page ${data.id}.`);
        },
      ),
    ],
  });
}

interface NotionObject {
  id: string;
  object?: string;
  url?: string;
  properties?: Record<string, unknown>;
  title?: { plain_text?: string }[];
}

/** Best-effort title + id summary for a Notion page/database object. */
function summarizeNotion(o: NotionObject): string {
  let title = "";
  // Databases carry a top-level `title`; pages carry a title-typed property.
  if (Array.isArray(o.title)) title = o.title.map((t) => t.plain_text ?? "").join("");
  if (!title && o.properties) {
    for (const v of Object.values(o.properties)) {
      const p = v as { type?: string; title?: { plain_text?: string }[] };
      if (p?.type === "title" && Array.isArray(p.title)) {
        title = p.title.map((t) => t.plain_text ?? "").join("");
        break;
      }
    }
  }
  return `- [${o.object ?? "page"}] ${title || "(untitled)"} · id ${o.id}`;
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

function gcalMcp(token: string) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return createSdkMcpServer({
    name: "gcal",
    version: "1.0.0",
    tools: [
      tool(
        "gcal_list_events",
        "List upcoming Google Calendar events. Defaults to the primary calendar " +
          "and the next 10 events from now.",
        {
          calendarId: z.string().optional().describe('Calendar id (default "primary").'),
          maxResults: z.number().int().min(1).max(50).optional(),
          timeMin: z.string().optional().describe("RFC3339 lower bound (default: now)."),
        },
        async (a) => {
          const cal = encodeURIComponent(a.calendarId ?? "primary");
          const params = new URLSearchParams({
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: String(a.maxResults ?? 10),
            timeMin: a.timeMin ?? new Date().toISOString(),
          });
          const res = await fetch(`${GCAL_BASE}/calendars/${cal}/events?${params}`, { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { items?: GCalEvent[] };
          const items = (data.items ?? []).map(summarizeEvent);
          return text(items.length ? items.join("\n") : "No upcoming events.");
        },
      ),
      tool(
        "gcal_create_event",
        "Create a Google Calendar event. Provide a summary and start/end times " +
          "(RFC3339, e.g. 2025-01-30T15:00:00Z, or a date YYYY-MM-DD for all-day).",
        {
          summary: z.string(),
          start: z.string().describe("RFC3339 datetime or YYYY-MM-DD date."),
          end: z.string().describe("RFC3339 datetime or YYYY-MM-DD date."),
          calendarId: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
        },
        async (a) => {
          const cal = encodeURIComponent(a.calendarId ?? "primary");
          const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
          const body = {
            summary: a.summary,
            description: a.description,
            location: a.location,
            start: isDate(a.start) ? { date: a.start } : { dateTime: a.start },
            end: isDate(a.end) ? { date: a.end } : { dateTime: a.end },
          };
          const res = await fetch(`${GCAL_BASE}/calendars/${cal}/events`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as GCalEvent;
          return text(`Created event ${data.id ?? ""}${data.htmlLink ? ` · ${data.htmlLink}` : ""}.`);
        },
      ),
    ],
  });
}

interface GCalEvent {
  id?: string;
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

function summarizeEvent(e: GCalEvent): string {
  const when = e.start?.dateTime ?? e.start?.date ?? "?";
  return `- ${when} · ${e.summary ?? "(no title)"}${e.id ? ` · id ${e.id}` : ""}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type McpServer = ReturnType<typeof createSdkMcpServer>;

/**
 * Build the live connector MCP servers that are currently enabled + credentialed.
 * Returns a map keyed by MCP server name, ready to spread into a `runTurn`
 * `mcpServers` object. Empty when nothing is configured.
 */
export function buildConnectorMcps(): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  const notionToken = credentialFor("notion");
  if (notionToken) out.notion = notionMcp(notionToken);
  const gcalToken = credentialFor("gcal");
  if (gcalToken) out.gcal = gcalMcp(gcalToken);
  if (Object.keys(out).length) {
    log.debug("Connector MCPs enabled", { connectors: Object.keys(out) });
  }
  return out;
}

/** Names of the live connectors that have wired MCP servers (for the panel). */
export const LIVE_CONNECTORS = ["notion", "gcal"] as const;
