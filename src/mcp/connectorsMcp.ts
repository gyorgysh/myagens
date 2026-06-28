import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { listConnectors, connectorScope, type ConnectorScope } from "../core/connectors.js";
import { resolveSecret } from "../core/vault.js";
import { log } from "../logger.js";

/**
 * Tool names that MUTATE remote state (create/update/send/delete/move/share).
 * Under a connector's read-only scope these are stripped, so the agent only
 * ever sees the read-only (list/get/search) tools for that connector.
 */
const WRITE_TOOLS = new Set<string>([
  // Notion
  "notion_create_page",
  // Google Calendar
  "gcal_create_event",
  // Gmail
  "gmail_send_message",
  "gmail_create_draft",
  "gmail_delete_message",
  "gmail_modify_labels",
  // Google Drive
  "gdrive_create_file",
  "gdrive_update_file",
  "gdrive_delete_file",
  "gdrive_move_file",
  "gdrive_share_file",
  // Apple Calendar
  "applecal_create_event",
  "applecal_update_event",
  "applecal_delete_event",
  // Apple Mail
  "applemail_send",
  "applemail_delete_message",
  "applemail_flag_message",
]);

/**
 * Drop mutating tools when the connector is granted read-only access. With a
 * `write` scope every tool is kept. This is the single chokepoint so a tool can
 * never be exposed beyond its connector's granted scope. Typed as the SDK's own
 * `SdkMcpToolDefinition<any>[]` (what `createSdkMcpServer({ tools })` accepts), so
 * the heterogeneous tool array round-trips through the filter unchanged.
 */
function scopeTools(tools: SdkMcpToolDefinition<any>[], scope: ConnectorScope): SdkMcpToolDefinition<any>[] {
  if (scope === "write") return tools;
  return tools.filter((tl) => !WRITE_TOOLS.has(tl.name));
}

/**
 * Live external connectors exposed as in-process MCP servers. Unlike the
 * placeholder catalog in `core/connectors.ts`, these talk to real APIs using a
 * vault-stored credential. A connector only contributes tools when it is both
 * `enabled` and has a `secretId` attached in the panel Connectors view, so the
 * agent never sees a tool it has no credential for.
 *
 * Wired connectors: Notion, Google Calendar, Gmail, Google Drive,
 * Apple Calendar (iCloud CalDAV), Apple Mail (iCloud IMAP/SMTP).
 * `buildConnectorMcps()` returns a `{ name: server }` map ready to spread
 * into a `runTurn` `mcpServers` object; it's empty when nothing is configured.
 */

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const GCAL_BASE = "https://www.googleapis.com/calendar/v3";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const GDRIVE_BASE = "https://www.googleapis.com/drive/v3";
const GDRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const ICLOUD_CALDAV_BASE = "https://caldav.icloud.com";
const ICLOUD_IMAP_HOST = "imap.mail.me.com";
const ICLOUD_IMAP_PORT = 993;
const ICLOUD_SMTP_HOST = "smtp.mail.me.com";
const ICLOUD_SMTP_PORT = 587;

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

function notionMcp(token: string, scope: ConnectorScope) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  return createSdkMcpServer({
    name: "notion",
    version: "1.0.0",
    tools: scopeTools([
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
    ], scope),
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

function gcalMcp(token: string, scope: ConnectorScope) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return createSdkMcpServer({
    name: "gcal",
    version: "1.0.0",
    tools: scopeTools([
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
    ], scope),
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
// Gmail
// ---------------------------------------------------------------------------

interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: {
    headers?: { name: string; value: string }[];
    body?: { data?: string; size?: number };
    parts?: GmailPart[];
    mimeType?: string;
  };
  internalDate?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailLabel {
  id?: string;
  name?: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

function decodeGmailBody(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function extractTextFromParts(parts?: GmailPart[]): string {
  if (!parts) return "";
  for (const p of parts) {
    if (p.mimeType === "text/plain" && p.body?.data) return decodeGmailBody(p.body.data);
  }
  for (const p of parts) {
    if (p.parts) {
      const nested = extractTextFromParts(p.parts);
      if (nested) return nested;
    }
  }
  return "";
}

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function summarizeGmail(msg: GmailMessage): string {
  const from = getHeader(msg, "From");
  const subject = getHeader(msg, "Subject");
  const date = getHeader(msg, "Date");
  return `- id ${msg.id} · ${date} · From: ${from} · Subject: ${subject}`;
}

function gmailMcp(token: string, scope: ConnectorScope) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return createSdkMcpServer({
    name: "gmail",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "gmail_list_messages",
        "List Gmail messages matching a query. Supports Gmail search syntax (e.g. " +
          '"is:unread from:alice", "subject:invoice", "label:work"). Returns message ' +
          "ids, subjects, senders, and dates.",
        {
          query: z.string().optional().describe('Gmail search query (default: "is:inbox").'),
          maxResults: z.number().int().min(1).max(100).optional().describe("Max messages to return (default 20)."),
          labelIds: z.array(z.string()).optional().describe("Filter by label ids (e.g. [\"INBOX\", \"UNREAD\"])."),
        },
        async (a) => {
          const params = new URLSearchParams({ maxResults: String(a.maxResults ?? 20) });
          if (a.query) params.set("q", a.query);
          if (a.labelIds?.length) a.labelIds.forEach((l) => params.append("labelIds", l));
          const listRes = await fetch(`${GMAIL_BASE}/users/me/messages?${params}`, { headers });
          if (!listRes.ok) return text(await asError(listRes));
          const listData = (await listRes.json()) as { messages?: { id: string }[]; resultSizeEstimate?: number };
          const ids = listData.messages ?? [];
          if (!ids.length) return text("No messages found.");
          // Fetch snippets for each (batch via individual requests, max 20)
          const fetched = await Promise.all(
            ids.slice(0, 20).map((m) =>
              fetch(`${GMAIL_BASE}/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers })
                .then((r) => (r.ok ? (r.json() as Promise<GmailMessage>) : null))
                .catch(() => null),
            ),
          );
          const lines = fetched.filter(Boolean).map((m) => summarizeGmail(m!));
          return text(lines.join("\n") + `\n(${listData.resultSizeEstimate ?? ids.length} total matches)`);
        },
      ),
      tool(
        "gmail_get_message",
        "Fetch the full content of a Gmail message by id, including body and attachment list.",
        {
          messageId: z.string().describe("The Gmail message id."),
        },
        async (a) => {
          const res = await fetch(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(a.messageId)}?format=full`, { headers });
          if (!res.ok) return text(await asError(res));
          const msg = (await res.json()) as GmailMessage;
          const from = getHeader(msg, "From");
          const to = getHeader(msg, "To");
          const subject = getHeader(msg, "Subject");
          const date = getHeader(msg, "Date");
          let body = "";
          if (msg.payload?.body?.data) {
            body = decodeGmailBody(msg.payload.body.data);
          } else {
            body = extractTextFromParts(msg.payload?.parts);
          }
          const attachments = collectAttachments(msg.payload?.parts);
          const attStr = attachments.length
            ? `\nAttachments: ${attachments.map((a) => `${a.filename} (${a.attachmentId})`).join(", ")}`
            : "";
          return text(
            `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body.slice(0, 4000)}${body.length > 4000 ? "\n[truncated]" : ""}${attStr}`,
          );
        },
      ),
      tool(
        "gmail_get_attachment",
        "Download a Gmail attachment by message id and attachment id. Returns the content as text or base64.",
        {
          messageId: z.string(),
          attachmentId: z.string(),
          filename: z.string().optional().describe("Original filename (for context only)."),
        },
        async (a) => {
          const res = await fetch(
            `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(a.messageId)}/attachments/${encodeURIComponent(a.attachmentId)}`,
            { headers },
          );
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { data?: string; size?: number };
          const decoded = decodeGmailBody(data.data);
          // If it looks like text, return as text; otherwise return base64 size info
          const isPrintable = /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(decoded.slice(0, 200));
          if (isPrintable) {
            return text(decoded.slice(0, 8000) + (decoded.length > 8000 ? "\n[truncated]" : ""));
          }
          return text(`Binary attachment (${data.size ?? 0} bytes). Use gmail_get_attachment for download link.`);
        },
      ),
      tool(
        "gmail_send_message",
        "Send an email via Gmail. Supports plain text and HTML body.",
        {
          to: z.string().describe("Recipient(s), comma-separated."),
          subject: z.string(),
          body: z.string().describe("Email body (plain text)."),
          cc: z.string().optional(),
          bcc: z.string().optional(),
          replyToMessageId: z.string().optional().describe("Thread message id to reply to."),
        },
        async (a) => {
          // Look up the sender's address
          const profileRes = await fetch(`${GMAIL_BASE}/users/me/profile`, { headers });
          const profile = profileRes.ok ? ((await profileRes.json()) as { emailAddress?: string }) : {};
          const from = profile.emailAddress ?? "me";
          const lines = [
            `From: ${from}`,
            `To: ${a.to}`,
            ...(a.cc ? [`Cc: ${a.cc}`] : []),
            ...(a.bcc ? [`Bcc: ${a.bcc}`] : []),
            `Subject: ${a.subject}`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            a.body,
          ];
          const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
          const bodyObj: Record<string, unknown> = { raw };
          if (a.replyToMessageId) {
            // Fetch the thread id to thread the reply correctly
            const orig = await fetch(`${GMAIL_BASE}/users/me/messages/${a.replyToMessageId}?format=metadata`, { headers });
            if (orig.ok) {
              const origData = (await orig.json()) as GmailMessage;
              if (origData.threadId) bodyObj.threadId = origData.threadId;
            }
          }
          const res = await fetch(`${GMAIL_BASE}/users/me/messages/send`, {
            method: "POST",
            headers,
            body: JSON.stringify(bodyObj),
          });
          if (!res.ok) return text(await asError(res));
          const sent = (await res.json()) as GmailMessage;
          return text(`Sent. Message id: ${sent.id ?? "unknown"}.`);
        },
      ),
      tool(
        "gmail_create_draft",
        "Save a draft email in Gmail.",
        {
          to: z.string(),
          subject: z.string(),
          body: z.string(),
          cc: z.string().optional(),
        },
        async (a) => {
          const lines = [
            `To: ${a.to}`,
            ...(a.cc ? [`Cc: ${a.cc}`] : []),
            `Subject: ${a.subject}`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            a.body,
          ];
          const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
          const res = await fetch(`${GMAIL_BASE}/users/me/drafts`, {
            method: "POST",
            headers,
            body: JSON.stringify({ message: { raw } }),
          });
          if (!res.ok) return text(await asError(res));
          const draft = (await res.json()) as { id?: string };
          return text(`Draft saved. Draft id: ${draft.id ?? "unknown"}.`);
        },
      ),
      tool(
        "gmail_delete_message",
        "Move a Gmail message to Trash (soft delete).",
        {
          messageId: z.string(),
        },
        async (a) => {
          const res = await fetch(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(a.messageId)}/trash`, {
            method: "POST",
            headers,
          });
          if (!res.ok) return text(await asError(res));
          return text(`Message ${a.messageId} moved to Trash.`);
        },
      ),
      tool(
        "gmail_modify_labels",
        "Add or remove Gmail labels on a message (e.g. mark as read, star, archive).",
        {
          messageId: z.string(),
          addLabelIds: z.array(z.string()).optional().describe('Labels to add, e.g. ["STARRED", "UNREAD"].'),
          removeLabelIds: z.array(z.string()).optional().describe('Labels to remove, e.g. ["UNREAD", "INBOX"].'),
        },
        async (a) => {
          const res = await fetch(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(a.messageId)}/modify`, {
            method: "POST",
            headers,
            body: JSON.stringify({ addLabelIds: a.addLabelIds ?? [], removeLabelIds: a.removeLabelIds ?? [] }),
          });
          if (!res.ok) return text(await asError(res));
          return text(`Labels updated on message ${a.messageId}.`);
        },
      ),
      tool(
        "gmail_list_labels",
        "List all Gmail labels (system and user-defined). Useful to find label ids for filtering.",
        {},
        async () => {
          const res = await fetch(`${GMAIL_BASE}/users/me/labels`, { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { labels?: GmailLabel[] };
          const lines = (data.labels ?? []).map(
            (l) => `- ${l.name} (id: ${l.id})${l.messagesUnread ? ` unread: ${l.messagesUnread}` : ""}`,
          );
          return text(lines.join("\n") || "No labels.");
        },
      ),
    ], scope),
  });
}

function collectAttachments(parts?: GmailPart[]): { filename: string; attachmentId: string }[] {
  const result: { filename: string; attachmentId: string }[] = [];
  if (!parts) return result;
  for (const p of parts) {
    if (p.filename && p.body?.attachmentId) result.push({ filename: p.filename, attachmentId: p.body.attachmentId });
    if (p.parts) result.push(...collectAttachments(p.parts));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

interface GDriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  description?: string;
}

function summarizeGDriveFile(f: GDriveFile): string {
  const size = f.size ? ` (${Math.round(Number(f.size) / 1024)}KB)` : "";
  return `- ${f.name ?? "(unnamed)"}${size} · id ${f.id} · type ${f.mimeType ?? "?"}${f.modifiedTime ? ` · modified ${f.modifiedTime.slice(0, 10)}` : ""}`;
}

function gdriveMcp(token: string, scope: ConnectorScope) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,parents,description";
  return createSdkMcpServer({
    name: "gdrive",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "gdrive_list_files",
        "List files in Google Drive. Optionally filter by folder, name, or MIME type. " +
          "Supports Drive query syntax.",
        {
          query: z.string().optional().describe("Drive query, e.g. \"name contains 'report'\" or \"'folderId' in parents\"."),
          maxResults: z.number().int().min(1).max(100).optional(),
          orderBy: z.string().optional().describe("Sort field, e.g. \"modifiedTime desc\"."),
        },
        async (a) => {
          const params = new URLSearchParams({
            pageSize: String(a.maxResults ?? 25),
            fields: `files(${FIELDS})`,
            ...(a.query ? { q: a.query } : {}),
            ...(a.orderBy ? { orderBy: a.orderBy } : { orderBy: "modifiedTime desc" }),
          });
          const res = await fetch(`${GDRIVE_BASE}/files?${params}`, { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { files?: GDriveFile[] };
          const lines = (data.files ?? []).map(summarizeGDriveFile);
          return text(lines.join("\n") || "No files found.");
        },
      ),
      tool(
        "gdrive_get_file",
        "Get metadata and, for text files/docs, the content of a Drive file by id.",
        {
          fileId: z.string(),
          exportFormat: z
            .enum(["text/plain", "text/html", "application/pdf"])
            .optional()
            .describe("Export format for Google Docs/Sheets/Slides (default: text/plain)."),
        },
        async (a) => {
          const metaRes = await fetch(`${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}?fields=${FIELDS}`, { headers });
          if (!metaRes.ok) return text(await asError(metaRes));
          const meta = (await metaRes.json()) as GDriveFile;
          const summary = summarizeGDriveFile(meta);
          // For Google Docs/Sheets/Slides, export as text
          const isGoogleDoc =
            meta.mimeType?.startsWith("application/vnd.google-apps.") &&
            meta.mimeType !== "application/vnd.google-apps.folder";
          const isPlainText =
            meta.mimeType?.startsWith("text/") || meta.mimeType === "application/json";
          if (isGoogleDoc) {
            const fmt = a.exportFormat ?? "text/plain";
            const exportRes = await fetch(
              `${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}/export?mimeType=${encodeURIComponent(fmt)}`,
              { headers },
            );
            if (!exportRes.ok) return text(`${summary}\n(Export failed: ${await asError(exportRes)})`);
            const content = await exportRes.text();
            return text(`${summary}\n\n${content.slice(0, 8000)}${content.length > 8000 ? "\n[truncated]" : ""}`);
          }
          if (isPlainText) {
            const dlRes = await fetch(`${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}?alt=media`, { headers });
            if (!dlRes.ok) return text(`${summary}\n(Download failed: ${await asError(dlRes)})`);
            const content = await dlRes.text();
            return text(`${summary}\n\n${content.slice(0, 8000)}${content.length > 8000 ? "\n[truncated]" : ""}`);
          }
          return text(`${summary}${meta.webViewLink ? `\nView: ${meta.webViewLink}` : ""}`);
        },
      ),
      tool(
        "gdrive_search",
        "Full-text search across Google Drive files. Returns matching files with snippets.",
        {
          query: z.string().describe("Search terms (full-text search across file content and names)."),
          maxResults: z.number().int().min(1).max(50).optional(),
        },
        async (a) => {
          const q = `fullText contains '${a.query.replace(/'/g, "\\'")}'`;
          const params = new URLSearchParams({ q, pageSize: String(a.maxResults ?? 20), fields: `files(${FIELDS})` });
          const res = await fetch(`${GDRIVE_BASE}/files?${params}`, { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { files?: GDriveFile[] };
          const lines = (data.files ?? []).map(summarizeGDriveFile);
          return text(lines.join("\n") || "No results.");
        },
      ),
      tool(
        "gdrive_create_file",
        "Create a new text file or Google Doc in Drive. For plain text pass content; " +
          "for a Google Doc leave content empty.",
        {
          name: z.string(),
          content: z.string().optional().describe("File text content (empty = create empty Google Doc)."),
          mimeType: z
            .string()
            .optional()
            .describe('MIME type (default "text/plain"; use "application/vnd.google-apps.document" for a Google Doc).'),
          folderId: z.string().optional().describe("Parent folder id (default: Drive root)."),
          description: z.string().optional(),
        },
        async (a) => {
          const mimeType = a.mimeType ?? (a.content !== undefined ? "text/plain" : "application/vnd.google-apps.document");
          const meta: Record<string, unknown> = {
            name: a.name,
            mimeType,
            ...(a.folderId ? { parents: [a.folderId] } : {}),
            ...(a.description ? { description: a.description } : {}),
          };
          if (a.content !== undefined) {
            // Multipart upload
            const boundary = "boundary_gdrive_upload";
            const body = [
              `--${boundary}`,
              "Content-Type: application/json; charset=UTF-8",
              "",
              JSON.stringify(meta),
              `--${boundary}`,
              `Content-Type: ${mimeType}`,
              "",
              a.content,
              `--${boundary}--`,
            ].join("\r\n");
            const res = await fetch(`${GDRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${FIELDS}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": `multipart/related; boundary=${boundary}`,
              },
              body,
            });
            if (!res.ok) return text(await asError(res));
            const f = (await res.json()) as GDriveFile;
            return text(`Created: ${summarizeGDriveFile(f)}`);
          }
          const res = await fetch(`${GDRIVE_BASE}/files?fields=${FIELDS}`, {
            method: "POST",
            headers,
            body: JSON.stringify(meta),
          });
          if (!res.ok) return text(await asError(res));
          const f = (await res.json()) as GDriveFile;
          return text(`Created: ${summarizeGDriveFile(f)}`);
        },
      ),
      tool(
        "gdrive_update_file",
        "Update the content or metadata of an existing Drive file.",
        {
          fileId: z.string(),
          content: z.string().optional().describe("New file content."),
          name: z.string().optional().describe("New file name."),
          description: z.string().optional(),
        },
        async (a) => {
          if (a.content !== undefined) {
            const res = await fetch(`${GDRIVE_UPLOAD_BASE}/files/${encodeURIComponent(a.fileId)}?uploadType=media`, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
              body: a.content,
            });
            if (!res.ok) return text(await asError(res));
          }
          if (a.name || a.description !== undefined) {
            const meta: Record<string, string> = {};
            if (a.name) meta.name = a.name;
            if (a.description !== undefined) meta.description = a.description;
            const res = await fetch(`${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}?fields=id,name`, {
              method: "PATCH",
              headers,
              body: JSON.stringify(meta),
            });
            if (!res.ok) return text(await asError(res));
          }
          return text(`File ${a.fileId} updated.`);
        },
      ),
      tool(
        "gdrive_delete_file",
        "Permanently delete a Drive file or folder by id.",
        {
          fileId: z.string(),
        },
        async (a) => {
          const res = await fetch(`${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}`, {
            method: "DELETE",
            headers,
          });
          if (!res.ok) return text(await asError(res));
          return text(`File ${a.fileId} deleted.`);
        },
      ),
      tool(
        "gdrive_move_file",
        "Move a Drive file to a different folder.",
        {
          fileId: z.string(),
          targetFolderId: z.string(),
        },
        async (a) => {
          // Get current parents first
          const metaRes = await fetch(`${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}?fields=parents`, { headers });
          if (!metaRes.ok) return text(await asError(metaRes));
          const meta = (await metaRes.json()) as { parents?: string[] };
          const removeParents = (meta.parents ?? []).join(",");
          const params = new URLSearchParams({ addParents: a.targetFolderId, ...(removeParents ? { removeParents } : {}), fields: "id,parents" });
          const res = await fetch(`${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}?${params}`, {
            method: "PATCH",
            headers,
          });
          if (!res.ok) return text(await asError(res));
          return text(`File ${a.fileId} moved to folder ${a.targetFolderId}.`);
        },
      ),
      tool(
        "gdrive_share_file",
        "Share a Drive file with a user or make it public.",
        {
          fileId: z.string(),
          role: z.enum(["reader", "commenter", "writer", "owner"]).describe("Permission level."),
          type: z.enum(["user", "group", "domain", "anyone"]),
          emailAddress: z.string().optional().describe("Email (required for user/group type)."),
        },
        async (a) => {
          const body: Record<string, string> = { role: a.role, type: a.type };
          if (a.emailAddress) body.emailAddress = a.emailAddress;
          const res = await fetch(`${GDRIVE_BASE}/files/${encodeURIComponent(a.fileId)}/permissions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          if (!res.ok) return text(await asError(res));
          const perm = (await res.json()) as { id?: string };
          return text(`Shared. Permission id: ${perm.id ?? "unknown"}.`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Apple Calendar (iCloud CalDAV)
// ---------------------------------------------------------------------------

/** Parse basic fields out of a VEVENT iCalendar block. */
function parseVEvent(vcal: string): { uid: string; summary: string; dtstart: string; dtend: string; description: string; location: string } | null {
  const get = (key: string) => {
    const m = vcal.match(new RegExp(`${key}[^:]*:([^\r\n]*)`, "i"));
    return m ? m[1].trim() : "";
  };
  const uid = get("UID");
  if (!uid) return null;
  return { uid, summary: get("SUMMARY"), dtstart: get("DTSTART"), dtend: get("DTEND"), description: get("DESCRIPTION"), location: get("LOCATION") };
}

/** Format a CalDAV date string (YYYYMMDD or YYYYMMDDTHHmmssZ) into ISO-like. */
function calFmt(d: string): string {
  if (!d) return "?";
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/, "$1-$2-$3T$4:$5:$6$7");
}

/** Build a VCALENDAR/VEVENT iCal string. */
function buildVEvent(uid: string, summary: string, dtstart: string, dtend: string, description?: string, location?: string): string {
  const fmtDt = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d+/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MyHQ//CalDAV//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${fmtDt(new Date().toISOString())}`,
    `DTSTART:${fmtDt(dtstart)}`,
    `DTEND:${fmtDt(dtend)}`,
    `SUMMARY:${summary}`,
    ...(description ? [`DESCRIPTION:${description}`] : []),
    ...(location ? [`LOCATION:${location}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/**
 * Apple Calendar via iCloud CalDAV. Credential is "username:app-specific-password"
 * (the user's iCloud email + an app-specific password from appleid.apple.com).
 */
function appleCalendarMcp(credential: string, scope: ConnectorScope) {
  const [username, ...passParts] = credential.split(":");
  const password = passParts.join(":");
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const caldavHeaders = {
    Authorization: authHeader,
    "Content-Type": "application/xml; charset=utf-8",
    Depth: "1",
  };

  /** Discover the principal calendars URL for this user. */
  async function discoverCalendars(): Promise<{ href: string; displayName: string }[]> {
    // First find the principal URL
    const principalBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;
    const principalRes = await fetch(`${ICLOUD_CALDAV_BASE}/`, {
      method: "PROPFIND",
      headers: { ...caldavHeaders, Depth: "0" },
      body: principalBody,
    });
    // iCloud redirects to per-user URLs; follow the Location or parse the response
    const principalText = await principalRes.text();
    const principalMatch = principalText.match(/<[^>]*current-user-principal[^>]*>.*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/is);
    const principalHref = principalMatch ? principalMatch[1].trim() : `/${username}/principal/`;
    const calBase = `${ICLOUD_CALDAV_BASE}${principalHref.startsWith("/") ? "" : "/"}${principalHref}`;

    // Discover calendar home
    const homeBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="urn:ietf:params:xml:ns:caldav">
  <d:prop><cs:calendar-home-set/></d:prop>
</d:propfind>`;
    const homeRes = await fetch(calBase, {
      method: "PROPFIND",
      headers: { ...caldavHeaders, Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: homeBody,
    });
    const homeText = await homeRes.text();
    const homeMatch = homeText.match(/<[^>]*calendar-home-set[^>]*>.*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/is);
    const homeHref = homeMatch ? homeMatch[1].trim() : `/${username}/calendars/`;
    const calHomeUrl = homeHref.startsWith("http") ? homeHref : `${ICLOUD_CALDAV_BASE}${homeHref}`;

    // List calendars
    const listBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <cs:calendar-description/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;
    const listRes = await fetch(calHomeUrl, {
      method: "PROPFIND",
      headers: { ...caldavHeaders, Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: listBody,
    });
    const listText = await listRes.text();
    const cals: { href: string; displayName: string }[] = [];
    const responseRe = /<[^>]*response[^>]*>([\s\S]*?)<\/[^>]*response>/gi;
    let m: RegExpExecArray | null;
    while ((m = responseRe.exec(listText)) !== null) {
      const block = m[1];
      if (!block.includes("calendar")) continue;
      const hrefM = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i);
      const nameM = block.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i);
      if (hrefM) cals.push({ href: hrefM[1].trim(), displayName: nameM ? nameM[1].trim() : "(unnamed)" });
    }
    return cals;
  }

  return createSdkMcpServer({
    name: "apple-calendar",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "applecal_list_calendars",
        "List all iCloud CalDAV calendars for this account.",
        {},
        async () => {
          try {
            const cals = await discoverCalendars();
            if (!cals.length) return text("No calendars found.");
            return text(cals.map((c) => `- ${c.displayName} · href: ${c.href}`).join("\n"));
          } catch (e) {
            return text(`Error: ${String(e)}`);
          }
        },
      ),
      tool(
        "applecal_list_events",
        "List events from an iCloud calendar within a date range.",
        {
          calendarHref: z.string().describe("Calendar href path (from applecal_list_calendars)."),
          timeMin: z.string().describe("Start of range (ISO 8601, e.g. 2025-01-01T00:00:00Z)."),
          timeMax: z.string().describe("End of range (ISO 8601)."),
        },
        async (a) => {
          const fmtDt = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d+/, "");
          const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${fmtDt(a.timeMin)}" end="${fmtDt(a.timeMax)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
          const url = a.calendarHref.startsWith("http") ? a.calendarHref : `${ICLOUD_CALDAV_BASE}${a.calendarHref}`;
          const res = await fetch(url, {
            method: "REPORT",
            headers: { ...caldavHeaders, Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
            body: reportBody,
          });
          if (!res.ok) return text(await asError(res));
          const xml = await res.text();
          const events: string[] = [];
          const calDataRe = /<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi;
          let m: RegExpExecArray | null;
          while ((m = calDataRe.exec(xml)) !== null) {
            const ev = parseVEvent(m[1]);
            if (ev) events.push(`- ${calFmt(ev.dtstart)} – ${calFmt(ev.dtend)} · ${ev.summary}${ev.location ? ` @ ${ev.location}` : ""}${ev.uid ? ` · uid ${ev.uid}` : ""}`);
          }
          return text(events.length ? events.join("\n") : "No events in range.");
        },
      ),
      tool(
        "applecal_create_event",
        "Create a new event in an iCloud calendar.",
        {
          calendarHref: z.string().describe("Calendar href path."),
          summary: z.string(),
          dtstart: z.string().describe("Start datetime (ISO 8601, e.g. 2025-06-15T10:00:00Z)."),
          dtend: z.string().describe("End datetime (ISO 8601)."),
          description: z.string().optional(),
          location: z.string().optional(),
        },
        async (a) => {
          const uid = `myhq-${Date.now()}-${Math.random().toString(36).slice(2)}@myhq`;
          const ical = buildVEvent(uid, a.summary, a.dtstart, a.dtend, a.description, a.location);
          const base = a.calendarHref.startsWith("http") ? a.calendarHref : `${ICLOUD_CALDAV_BASE}${a.calendarHref}`;
          const url = `${base.replace(/\/$/, "")}/${uid}.ics`;
          const res = await fetch(url, {
            method: "PUT",
            headers: { Authorization: authHeader, "Content-Type": "text/calendar; charset=utf-8" },
            body: ical,
          });
          if (!res.ok && res.status !== 201 && res.status !== 204) return text(await asError(res));
          return text(`Event created. UID: ${uid}.`);
        },
      ),
      tool(
        "applecal_update_event",
        "Update an existing event in an iCloud calendar. Provide the event UID.",
        {
          calendarHref: z.string(),
          uid: z.string().describe("The event UID (from applecal_list_events)."),
          summary: z.string().optional(),
          dtstart: z.string().optional(),
          dtend: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
        },
        async (a) => {
          // Fetch the existing event first
          const base = a.calendarHref.startsWith("http") ? a.calendarHref : `${ICLOUD_CALDAV_BASE}${a.calendarHref}`;
          const url = `${base.replace(/\/$/, "")}/${a.uid}.ics`;
          const getRes = await fetch(url, { headers: { Authorization: authHeader } });
          if (!getRes.ok) return text(await asError(getRes));
          const existing = parseVEvent(await getRes.text());
          if (!existing) return text("Could not parse existing event.");
          const ical = buildVEvent(
            a.uid,
            a.summary ?? existing.summary,
            a.dtstart ?? existing.dtstart,
            a.dtend ?? existing.dtend,
            a.description ?? existing.description,
            a.location ?? existing.location,
          );
          const putRes = await fetch(url, {
            method: "PUT",
            headers: { Authorization: authHeader, "Content-Type": "text/calendar; charset=utf-8" },
            body: ical,
          });
          if (!putRes.ok && putRes.status !== 204) return text(await asError(putRes));
          return text(`Event ${a.uid} updated.`);
        },
      ),
      tool(
        "applecal_delete_event",
        "Delete an event from an iCloud calendar by UID.",
        {
          calendarHref: z.string(),
          uid: z.string(),
        },
        async (a) => {
          const base = a.calendarHref.startsWith("http") ? a.calendarHref : `${ICLOUD_CALDAV_BASE}${a.calendarHref}`;
          const url = `${base.replace(/\/$/, "")}/${a.uid}.ics`;
          const res = await fetch(url, { method: "DELETE", headers: { Authorization: authHeader } });
          if (!res.ok && res.status !== 204) return text(await asError(res));
          return text(`Event ${a.uid} deleted.`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Apple Mail (iCloud IMAP + SMTP via nodemailer / imapflow)
// ---------------------------------------------------------------------------

/**
 * Apple Mail connector. Credential is "username:app-specific-password"
 * (iCloud email + app-specific password from appleid.apple.com).
 * Uses ImapFlow for reading, nodemailer for sending.
 */
function appleMailMcp(credential: string, scope: ConnectorScope) {
  const [username, ...passParts] = credential.split(":");
  const password = passParts.join(":");

  function makeImapClient() {
    return new ImapFlow({
      host: ICLOUD_IMAP_HOST,
      port: ICLOUD_IMAP_PORT,
      secure: true,
      auth: { user: username, pass: password },
      logger: false,
    });
  }

  function makeSmtpTransport() {
    return nodemailer.createTransport({
      host: ICLOUD_SMTP_HOST,
      port: ICLOUD_SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: { user: username, pass: password },
    });
  }

  return createSdkMcpServer({
    name: "apple-mail",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "applemail_list_folders",
        "List all IMAP folders/mailboxes in the iCloud Mail account.",
        {},
        async () => {
          const client = makeImapClient();
          try {
            await client.connect();
            const folders = await client.list();
            return text(folders.map((f) => `- ${f.path}${f.flags?.has("\\Noselect") ? " (no-select)" : ""}`).join("\n") || "No folders.");
          } catch (e) {
            return text(`IMAP error: ${String(e)}`);
          } finally {
            await client.logout().catch(() => {});
          }
        },
      ),
      tool(
        "applemail_list_messages",
        "List recent messages from an iCloud Mail folder.",
        {
          folder: z.string().optional().describe('Folder/mailbox name (default "INBOX").'),
          maxResults: z.number().int().min(1).max(100).optional().describe("Number of recent messages (default 20)."),
          unseen: z.boolean().optional().describe("If true, only return unseen messages."),
        },
        async (a) => {
          const client = makeImapClient();
          try {
            await client.connect();
            await client.mailboxOpen(a.folder ?? "INBOX");
            const criteria = a.unseen ? { seen: false } : {};
            const rawUids = await client.search(criteria, { uid: true });
            const uids = rawUids || [];
            const recent = uids.slice(-Math.min(a.maxResults ?? 20, uids.length)).reverse();
            if (!recent.length) return text("No messages.");
            const lines: string[] = [];
            for await (const msg of client.fetch(recent.join(","), { envelope: true, uid: true }, { uid: true })) {
              const env = msg.envelope;
              const from = env?.from?.map((a) => a.address ?? a.name ?? "?").join(", ") ?? "?";
              const subject = env?.subject ?? "(no subject)";
              const date = env?.date ? new Date(env.date).toISOString().slice(0, 16) : "?";
              lines.push(`- uid ${msg.uid} · ${date} · From: ${from} · ${subject}`);
            }
            return text(lines.join("\n"));
          } catch (e) {
            return text(`IMAP error: ${String(e)}`);
          } finally {
            await client.logout().catch(() => {});
          }
        },
      ),
      tool(
        "applemail_get_message",
        "Fetch the full content of an iCloud Mail message by UID.",
        {
          uid: z.number().int().describe("Message UID from applemail_list_messages."),
          folder: z.string().optional().describe('Folder name (default "INBOX").'),
        },
        async (a) => {
          const client = makeImapClient();
          try {
            await client.connect();
            await client.mailboxOpen(a.folder ?? "INBOX");
            const msgs = await client.fetchOne(String(a.uid), { envelope: true, source: true, bodyStructure: true }, { uid: true });
            if (!msgs) return text("Message not found.");
            const env = msgs.envelope;
            const from = env?.from?.map((addr) => addr.address ?? addr.name ?? "?").join(", ") ?? "?";
            const to = env?.to?.map((addr) => addr.address ?? "?").join(", ") ?? "?";
            const subject = env?.subject ?? "(no subject)";
            const date = env?.date ? new Date(env.date).toISOString() : "?";
            const body = msgs.source ? msgs.source.toString().slice(0, 8000) : "(no body)";
            return text(`From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`);
          } catch (e) {
            return text(`IMAP error: ${String(e)}`);
          } finally {
            await client.logout().catch(() => {});
          }
        },
      ),
      tool(
        "applemail_search",
        "Search iCloud Mail messages by sender, subject, or body text.",
        {
          folder: z.string().optional().describe('Folder to search (default "INBOX").'),
          from: z.string().optional(),
          subject: z.string().optional(),
          body: z.string().optional(),
          maxResults: z.number().int().min(1).max(50).optional(),
        },
        async (a) => {
          const client = makeImapClient();
          try {
            await client.connect();
            await client.mailboxOpen(a.folder ?? "INBOX");
            // Build a SearchObject from the optional filters
            const searchCriteria: Record<string, string> = {};
            if (a.from) searchCriteria.from = a.from;
            if (a.subject) searchCriteria.subject = a.subject;
            if (a.body) searchCriteria.body = a.body;
            const rawUids = await client.search(searchCriteria, { uid: true });
            const uids = rawUids || [];
            const recent = uids.slice(-Math.min(a.maxResults ?? 20, uids.length)).reverse();
            if (!recent.length) return text("No messages found.");
            const lines: string[] = [];
            for await (const msg of client.fetch(recent.join(","), { envelope: true, uid: true }, { uid: true })) {
              const env = msg.envelope;
              const from = env?.from?.map((addr) => addr.address ?? addr.name ?? "?").join(", ") ?? "?";
              lines.push(`- uid ${msg.uid} · ${env?.date ? new Date(env.date).toISOString().slice(0, 16) : "?"} · From: ${from} · ${env?.subject ?? "(no subject)"}`);
            }
            return text(lines.join("\n"));
          } catch (e) {
            return text(`IMAP error: ${String(e)}`);
          } finally {
            await client.logout().catch(() => {});
          }
        },
      ),
      tool(
        "applemail_send",
        "Send an email via iCloud Mail (SMTP).",
        {
          to: z.string().describe("Recipient(s), comma-separated."),
          subject: z.string(),
          body: z.string().describe("Plain text email body."),
          cc: z.string().optional(),
          bcc: z.string().optional(),
        },
        async (a) => {
          const transport = makeSmtpTransport();
          try {
            const info = await transport.sendMail({
              from: username,
              to: a.to,
              cc: a.cc,
              bcc: a.bcc,
              subject: a.subject,
              text: a.body,
            });
            return text(`Sent. Message id: ${info.messageId ?? "unknown"}.`);
          } catch (e) {
            return text(`SMTP error: ${String(e)}`);
          } finally {
            transport.close();
          }
        },
      ),
      tool(
        "applemail_delete_message",
        "Move an iCloud Mail message to Trash.",
        {
          uid: z.number().int(),
          folder: z.string().optional().describe('Source folder (default "INBOX").'),
        },
        async (a) => {
          const client = makeImapClient();
          try {
            await client.connect();
            await client.mailboxOpen(a.folder ?? "INBOX");
            await client.messageMove(String(a.uid), "Deleted Messages", { uid: true });
            return text(`Message ${a.uid} moved to Trash.`);
          } catch (e) {
            return text(`IMAP error: ${String(e)}`);
          } finally {
            await client.logout().catch(() => {});
          }
        },
      ),
      tool(
        "applemail_flag_message",
        "Flag or unflag an iCloud Mail message.",
        {
          uid: z.number().int(),
          folder: z.string().optional(),
          flagged: z.boolean().describe("true to flag, false to unflag."),
        },
        async (a) => {
          const client = makeImapClient();
          try {
            await client.connect();
            await client.mailboxOpen(a.folder ?? "INBOX");
            if (a.flagged) {
              await client.messageFlagsAdd(String(a.uid), ["\\Flagged"], { uid: true });
            } else {
              await client.messageFlagsRemove(String(a.uid), ["\\Flagged"], { uid: true });
            }
            return text(`Message ${a.uid} ${a.flagged ? "flagged" : "unflagged"}.`);
          } catch (e) {
            return text(`IMAP error: ${String(e)}`);
          } finally {
            await client.logout().catch(() => {});
          }
        },
      ),
    ], scope),
  });
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
  if (notionToken) out.notion = notionMcp(notionToken, connectorScope("notion"));
  const gcalToken = credentialFor("gcal");
  if (gcalToken) out.gcal = gcalMcp(gcalToken, connectorScope("gcal"));
  const gmailToken = credentialFor("gmail");
  if (gmailToken) out.gmail = gmailMcp(gmailToken, connectorScope("gmail"));
  const gdriveToken = credentialFor("gdrive");
  if (gdriveToken) out.gdrive = gdriveMcp(gdriveToken, connectorScope("gdrive"));
  const appleCalCred = credentialFor("apple-calendar");
  if (appleCalCred) out["apple-calendar"] = appleCalendarMcp(appleCalCred, connectorScope("apple-calendar"));
  const appleMailCred = credentialFor("apple-mail");
  if (appleMailCred) out["apple-mail"] = appleMailMcp(appleMailCred, connectorScope("apple-mail"));
  if (Object.keys(out).length) {
    log.debug("Connector MCPs enabled", {
      connectors: Object.keys(out).map((id) => `${id}:${connectorScope(id)}`),
    });
  }
  return out;
}

/** Names of the live connectors that have wired MCP servers (for the panel). */
export const LIVE_CONNECTORS = ["notion", "gcal", "gmail", "gdrive", "apple-calendar", "apple-mail"] as const;
