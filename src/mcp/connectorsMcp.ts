import { createHmac, randomBytes } from "node:crypto";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { listConnectors, connectorScope, type ConnectorScope } from "../core/connectors.js";
import { resolveSecret } from "../core/vault.js";
import { safeFetch } from "../core/safeUrl.js";
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
  // Slack
  "slack_post_message",
  "slack_reply_thread",
  "slack_upload_file",
  // GitHub
  "github_create_issue",
  "github_comment_issue",
  "github_create_pr",
  "github_put_file",
  // Jira
  "jira_create_issue",
  "jira_transition_issue",
  "jira_comment_issue",
  // Linear
  "linear_create_issue",
  "linear_update_issue_state",
  "linear_comment_issue",
  // PostgreSQL
  "postgres_execute",
  // SQLite
  "sqlite_execute",
  // Bluesky
  "bluesky_post",
  "bluesky_delete_post",
  // Mastodon
  "mastodon_post",
  "mastodon_delete_post",
  // Discord
  "discord_post",
  // Reddit
  "reddit_submit",
  "reddit_comment",
  // X
  "x_post",
  "x_delete_post",
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
const SLACK_BASE = "https://slack.com/api";
const GITHUB_BASE = "https://api.github.com";

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

/** Strip CR/LF from an email header value to block header injection: a subject or
 *  recipient containing "\r\nBcc: attacker@x" would otherwise inject headers into
 *  the raw RFC-822 message we assemble for Gmail. */
function mailHeader(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/** Escape iCalendar text values (RFC 5545 §3.3.11): backslash, semicolon, comma,
 *  and newlines — so a summary/description/location can't inject extra iCal
 *  properties or components into a VEVENT we build. */
function icalText(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
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
        "Query a Notion database, returning its rows (pages), up to pageSize.",
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
          // Fetch metadata for each up to the requested maxResults (honour the
          // arg instead of a hardcoded 20, which silently truncated larger asks).
          const fetched = await Promise.all(
            ids.slice(0, a.maxResults ?? 20).map((m) =>
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
            `To: ${mailHeader(a.to)}`,
            ...(a.cc ? [`Cc: ${mailHeader(a.cc)}`] : []),
            ...(a.bcc ? [`Bcc: ${mailHeader(a.bcc)}`] : []),
            `Subject: ${mailHeader(a.subject)}`,
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
            `To: ${mailHeader(a.to)}`,
            ...(a.cc ? [`Cc: ${mailHeader(a.cc)}`] : []),
            `Subject: ${mailHeader(a.subject)}`,
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
            // Multipart upload. Use a random boundary so file content that happens
            // to contain the delimiter string can't corrupt the body or smuggle an
            // extra part that overrides the JSON metadata.
            const boundary = `myagens_gdrive_${randomBytes(16).toString("hex")}`;
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
    "PRODID:-//MyAgens//CalDAV//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${fmtDt(new Date().toISOString())}`,
    `DTSTART:${fmtDt(dtstart)}`,
    `DTEND:${fmtDt(dtend)}`,
    `SUMMARY:${icalText(summary)}`,
    ...(description ? [`DESCRIPTION:${icalText(description)}`] : []),
    ...(location ? [`LOCATION:${icalText(location)}`] : []),
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
          const uid = `myagens-${Date.now()}-${Math.random().toString(36).slice(2)}@myagens`;
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
// Slack (Web API)
// ---------------------------------------------------------------------------

interface SlackResponse {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

/**
 * Slack returns HTTP 200 even on logical failures, with `{ ok: false, error }`.
 * Normalise that into the same short error string the other connectors use.
 */
function slackError(data: SlackResponse): string {
  return `Slack error: ${data.error ?? "unknown"}`;
}

interface SlackChannel {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  num_members?: number;
}

interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
}

function slackMcp(token: string, scope: ConnectorScope) {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json; charset=utf-8" };

  /** GET a Slack method with query params. */
  async function slackGet(method: string, params: Record<string, string>): Promise<SlackResponse> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${SLACK_BASE}/${method}${qs ? `?${qs}` : ""}`, { headers: authHeaders });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return (await res.json()) as SlackResponse;
  }

  /** POST a Slack method with a JSON body. */
  async function slackPost(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    const res = await fetch(`${SLACK_BASE}/${method}`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return (await res.json()) as SlackResponse;
  }

  return createSdkMcpServer({
    name: "slack",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "slack_list_channels",
        "List Slack channels the bot can see (public and, if invited, private). " +
          "Returns channel ids and names.",
        {
          limit: z.number().int().min(1).max(200).optional().describe("Max channels (default 100)."),
          includePrivate: z.boolean().optional().describe("Include private channels (default true)."),
        },
        async (a) => {
          const types = a.includePrivate === false ? "public_channel" : "public_channel,private_channel";
          const data = await slackGet("conversations.list", {
            limit: String(a.limit ?? 100),
            exclude_archived: "true",
            types,
          });
          if (!data.ok) return text(slackError(data));
          const channels = (data.channels as SlackChannel[] | undefined) ?? [];
          const lines = channels.map(
            (c) => `- #${c.name ?? "?"} · id ${c.id}${c.is_private ? " (private)" : ""}${c.num_members != null ? ` · ${c.num_members} members` : ""}`,
          );
          return text(lines.join("\n") || "No channels.");
        },
      ),
      tool(
        "slack_history",
        "Fetch recent messages from a Slack channel by id. Returns message timestamps " +
          "(ts), authors, and text.",
        {
          channel: z.string().describe("Channel id (from slack_list_channels)."),
          limit: z.number().int().min(1).max(100).optional().describe("Number of recent messages (default 20)."),
        },
        async (a) => {
          const data = await slackGet("conversations.history", {
            channel: a.channel,
            limit: String(a.limit ?? 20),
          });
          if (!data.ok) return text(slackError(data));
          const msgs = (data.messages as SlackMessage[] | undefined) ?? [];
          const lines = msgs.map((m) => `- ts ${m.ts} · ${m.user ?? "?"}: ${(m.text ?? "").slice(0, 300)}`);
          return text(lines.join("\n") || "No messages.");
        },
      ),
      tool(
        "slack_search",
        "Search Slack message history with the standard Slack search syntax " +
          '(e.g. "in:#general from:@alice invoice"). Requires a token with search scope.',
        {
          query: z.string().describe("Slack search query."),
          count: z.number().int().min(1).max(50).optional().describe("Max matches (default 20)."),
        },
        async (a) => {
          const data = await slackGet("search.messages", { query: a.query, count: String(a.count ?? 20) });
          if (!data.ok) return text(slackError(data));
          const matches = ((data.messages as { matches?: (SlackMessage & { channel?: { name?: string } })[] } | undefined)?.matches) ?? [];
          const lines = matches.map(
            (m) => `- #${m.channel?.name ?? "?"} · ts ${m.ts} · ${m.user ?? "?"}: ${(m.text ?? "").slice(0, 300)}`,
          );
          return text(lines.join("\n") || "No matches.");
        },
      ),
      tool(
        "slack_post_message",
        "Post a message to a Slack channel or DM. Provide a channel id (or #name " +
          "for public channels). Returns the new message timestamp (ts).",
        {
          channel: z.string().describe("Channel id or #name."),
          text: z.string().describe("Message text (Slack mrkdwn supported)."),
        },
        async (a) => {
          const data = await slackPost("chat.postMessage", { channel: a.channel, text: a.text });
          if (!data.ok) return text(slackError(data));
          return text(`Posted to ${a.channel}. ts: ${String(data.ts ?? "unknown")}.`);
        },
      ),
      tool(
        "slack_reply_thread",
        "Reply to an existing Slack message in its thread.",
        {
          channel: z.string().describe("Channel id."),
          threadTs: z.string().describe("The parent message ts to thread under."),
          text: z.string(),
        },
        async (a) => {
          const data = await slackPost("chat.postMessage", {
            channel: a.channel,
            text: a.text,
            thread_ts: a.threadTs,
          });
          if (!data.ok) return text(slackError(data));
          return text(`Replied in thread ${a.threadTs}. ts: ${String(data.ts ?? "unknown")}.`);
        },
      ),
      tool(
        "slack_upload_file",
        "Upload a text snippet/file to a Slack channel via the external-upload flow.",
        {
          channel: z.string().describe("Channel id to share the file into."),
          filename: z.string(),
          content: z.string().describe("File text content."),
          title: z.string().optional(),
        },
        async (a) => {
          const bytes = Buffer.byteLength(a.content, "utf-8");
          // Step 1: get a signed upload URL (this method takes query params).
          const urlData = await slackGet("files.getUploadURLExternal", {
            filename: a.filename,
            length: String(bytes),
          });
          if (!urlData.ok) return text(slackError(urlData));
          const uploadUrl = String(urlData.upload_url ?? "");
          const fileId = String(urlData.file_id ?? "");
          if (!uploadUrl || !fileId) return text("Slack error: missing upload URL.");
          // Step 2: PUT the content to the signed URL.
          const putRes = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: a.content,
          });
          if (!putRes.ok) return text(`Slack upload failed: HTTP ${putRes.status}`);
          // Step 3: complete the upload and share into the channel.
          const done = await slackPost("files.completeUploadExternal", {
            files: [{ id: fileId, title: a.title ?? a.filename }],
            channel_id: a.channel,
          });
          if (!done.ok) return text(slackError(done));
          return text(`Uploaded ${a.filename} to ${a.channel}. file id: ${fileId}.`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// GitHub (REST API v3)
// ---------------------------------------------------------------------------

interface GitHubRepo {
  full_name?: string;
  private?: boolean;
  description?: string;
  default_branch?: string;
  open_issues_count?: number;
}

interface GitHubIssue {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  user?: { login?: string };
  pull_request?: unknown;
}

function githubMcp(token: string, scope: ConnectorScope) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "MyAgens-connector",
  };

  return createSdkMcpServer({
    name: "github",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "github_list_repos",
        "List repositories the authenticated user can access. Returns full names, " +
          "visibility, and default branches.",
        {
          limit: z.number().int().min(1).max(100).optional().describe("Max repos (default 30)."),
          sort: z.enum(["created", "updated", "pushed", "full_name"]).optional(),
        },
        async (a) => {
          const params = new URLSearchParams({
            per_page: String(a.limit ?? 30),
            sort: a.sort ?? "updated",
          });
          const res = await fetch(`${GITHUB_BASE}/user/repos?${params}`, { headers });
          if (!res.ok) return text(await asError(res));
          const repos = (await res.json()) as GitHubRepo[];
          const lines = repos.map(
            (r) => `- ${r.full_name}${r.private ? " (private)" : ""} · default ${r.default_branch ?? "?"}${r.open_issues_count != null ? ` · ${r.open_issues_count} open` : ""}`,
          );
          return text(lines.join("\n") || "No repositories.");
        },
      ),
      tool(
        "github_list_issues",
        "List issues (and optionally pull requests) for a repo. Returns numbers, " +
          "titles, state, and author.",
        {
          owner: z.string(),
          repo: z.string(),
          state: z.enum(["open", "closed", "all"]).optional().describe("Default open."),
          limit: z.number().int().min(1).max(100).optional(),
        },
        async (a) => {
          const params = new URLSearchParams({
            state: a.state ?? "open",
            per_page: String(a.limit ?? 30),
          });
          const res = await fetch(`${GITHUB_BASE}/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/issues?${params}`, { headers });
          if (!res.ok) return text(await asError(res));
          const issues = (await res.json()) as GitHubIssue[];
          const lines = issues.map(
            (i) => `- #${i.number} [${i.pull_request ? "PR" : "issue"}/${i.state}] ${i.title ?? ""} · @${i.user?.login ?? "?"}`,
          );
          return text(lines.join("\n") || "No issues.");
        },
      ),
      tool(
        "github_get_file",
        "Read a file's contents from a repo at a given path (and optional ref).",
        {
          owner: z.string(),
          repo: z.string(),
          path: z.string().describe("File path within the repo."),
          ref: z.string().optional().describe("Branch, tag, or commit SHA (default: default branch)."),
        },
        async (a) => {
          const params = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : "";
          const res = await fetch(
            `${GITHUB_BASE}/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/contents/${a.path.split("/").map(encodeURIComponent).join("/")}${params}`,
            { headers },
          );
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { content?: string; encoding?: string; size?: number };
          if (data.encoding === "base64" && data.content) {
            const decoded = Buffer.from(data.content, "base64").toString("utf-8");
            return text(decoded.slice(0, 8000) + (decoded.length > 8000 ? "\n[truncated]" : ""));
          }
          return text(`(${data.size ?? 0} bytes; non-text or empty file)`);
        },
      ),
      tool(
        "github_create_issue",
        "Open a new issue in a repo.",
        {
          owner: z.string(),
          repo: z.string(),
          title: z.string(),
          body: z.string().optional(),
          labels: z.array(z.string()).optional(),
        },
        async (a) => {
          const res = await fetch(`${GITHUB_BASE}/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/issues`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title: a.title, body: a.body, labels: a.labels }),
          });
          if (!res.ok) return text(await asError(res));
          const issue = (await res.json()) as GitHubIssue;
          return text(`Created issue #${issue.number}${issue.html_url ? ` · ${issue.html_url}` : ""}.`);
        },
      ),
      tool(
        "github_comment_issue",
        "Add a comment to an existing issue or pull request.",
        {
          owner: z.string(),
          repo: z.string(),
          number: z.number().int().describe("Issue or PR number."),
          body: z.string(),
        },
        async (a) => {
          const res = await fetch(`${GITHUB_BASE}/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/issues/${a.number}/comments`, {
            method: "POST",
            headers,
            body: JSON.stringify({ body: a.body }),
          });
          if (!res.ok) return text(await asError(res));
          const c = (await res.json()) as { html_url?: string };
          return text(`Commented on #${a.number}${c.html_url ? ` · ${c.html_url}` : ""}.`);
        },
      ),
      tool(
        "github_create_pr",
        "Open a pull request from a head branch into a base branch.",
        {
          owner: z.string(),
          repo: z.string(),
          title: z.string(),
          head: z.string().describe("Source branch (e.g. \"feature-x\" or \"user:branch\")."),
          base: z.string().describe("Target branch (e.g. \"main\")."),
          body: z.string().optional(),
          draft: z.boolean().optional(),
        },
        async (a) => {
          const res = await fetch(`${GITHUB_BASE}/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/pulls`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft }),
          });
          if (!res.ok) return text(await asError(res));
          const pr = (await res.json()) as { number?: number; html_url?: string };
          return text(`Opened PR #${pr.number}${pr.html_url ? ` · ${pr.html_url}` : ""}.`);
        },
      ),
      tool(
        "github_put_file",
        "Create or update a file in a repo (commits directly to a branch). To update " +
          "an existing file you must pass its current blob sha.",
        {
          owner: z.string(),
          repo: z.string(),
          path: z.string(),
          content: z.string().describe("New file content (plain text)."),
          message: z.string().describe("Commit message."),
          branch: z.string().optional().describe("Target branch (default: default branch)."),
          sha: z.string().optional().describe("Existing file blob sha (required when updating)."),
        },
        async (a) => {
          const res = await fetch(
            `${GITHUB_BASE}/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}/contents/${a.path.split("/").map(encodeURIComponent).join("/")}`,
            {
              method: "PUT",
              headers,
              body: JSON.stringify({
                message: a.message,
                content: Buffer.from(a.content, "utf-8").toString("base64"),
                branch: a.branch,
                sha: a.sha,
              }),
            },
          );
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { commit?: { sha?: string; html_url?: string } };
          return text(`Committed ${a.path}${data.commit?.html_url ? ` · ${data.commit.html_url}` : ""}.`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Jira Cloud (REST API v3)
// ---------------------------------------------------------------------------

/**
 * Parse a Jira credential of the form `email:api-token@site.atlassian.net`
 * into the site base URL and a Basic-auth header value. The token itself may
 * contain neither `@` nor `:` in practice (Atlassian tokens are opaque URL-safe
 * strings), so we split on the *last* `@` for the host and the *first* `:` for
 * the email/token boundary.
 */
function parseJiraCredential(
  cred: string,
): { base: string; auth: string } | { error: string } {
  const at = cred.lastIndexOf("@");
  if (at === -1) return { error: "Jira credential must look like email:api-token@your-site.atlassian.net" };
  const userPart = cred.slice(0, at);
  let host = cred.slice(at + 1).trim();
  const colon = userPart.indexOf(":");
  if (colon === -1) return { error: "Jira credential is missing the ':' between email and API token." };
  const email = userPart.slice(0, colon).trim();
  const token = userPart.slice(colon + 1).trim();
  if (!email || !token || !host) return { error: "Jira credential is incomplete (need email, token, and site host)." };
  host = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  return { base: `https://${host}`, auth };
}

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    issuetype?: { name?: string };
    priority?: { name?: string };
    description?: unknown;
  };
}

/** Flatten Atlassian Document Format (ADF) into plain text, best-effort. */
function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    const sep = n.type === "paragraph" || n.type === "heading" ? "\n" : "";
    return n.content.map(adfToText).join("") + sep;
  }
  return "";
}

/** Wrap plain text as a minimal ADF doc for issue bodies / comments. */
function textToAdf(s: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: s }] }],
  };
}

function jiraMcp(credential: string, scope: ConnectorScope) {
  const parsed = parseJiraCredential(credential);
  // If the credential is malformed, every tool returns the parse error rather
  // than throwing at build time (keeps the connector list resilient).
  const ready = "base" in parsed ? parsed : undefined;
  const credError = "error" in parsed ? parsed.error : undefined;
  const headers: Record<string, string> = ready
    ? { Authorization: ready.auth, Accept: "application/json", "Content-Type": "application/json" }
    : {};
  const api = (path: string) => `${ready?.base ?? ""}/rest/api/3${path}`;

  return createSdkMcpServer({
    name: "jira",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "jira_list_projects",
        "List Jira projects visible to the account. Returns project keys and names.",
        { limit: z.number().int().min(1).max(100).optional().describe("Max projects (default 50).") },
        async (a) => {
          if (credError) return text(credError);
          const params = new URLSearchParams({ maxResults: String(a.limit ?? 50) });
          const res = await fetch(api(`/project/search?${params}`), { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { values?: Array<{ key?: string; name?: string }> };
          const lines = (data.values ?? []).map((p) => `- ${p.key} · ${p.name ?? ""}`);
          return text(lines.join("\n") || "No projects.");
        },
      ),
      tool(
        "jira_search_issues",
        "Search issues with a JQL query (e.g. 'project = ENG AND status = \"In Progress\" ORDER BY updated DESC'). " +
          "Returns issue keys, summaries, status, and assignee.",
        {
          jql: z.string().describe("A Jira Query Language (JQL) string."),
          limit: z.number().int().min(1).max(100).optional().describe("Max issues (default 30)."),
        },
        async (a) => {
          if (credError) return text(credError);
          const params = new URLSearchParams({
            jql: a.jql,
            maxResults: String(a.limit ?? 30),
            fields: "summary,status,assignee,issuetype,priority",
          });
          const res = await fetch(api(`/search?${params}`), { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { issues?: JiraIssue[]; total?: number };
          const lines = (data.issues ?? []).map(
            (i) =>
              `- ${i.key} [${i.fields?.status?.name ?? "?"}] ${i.fields?.summary ?? ""}` +
              `${i.fields?.assignee ? ` · @${i.fields.assignee.displayName}` : " · unassigned"}`,
          );
          const header = data.total != null ? `${data.total} match(es):\n` : "";
          return text(header + (lines.join("\n") || "No matching issues."));
        },
      ),
      tool(
        "jira_get_issue",
        "Read one issue's full detail (summary, status, type, priority, assignee, description).",
        { key: z.string().describe("Issue key, e.g. ENG-123.") },
        async (a) => {
          if (credError) return text(credError);
          const res = await fetch(api(`/issue/${encodeURIComponent(a.key)}`), { headers });
          if (!res.ok) return text(await asError(res));
          const i = (await res.json()) as JiraIssue;
          const f = i.fields ?? {};
          const desc = adfToText(f.description).trim();
          const out = [
            `${i.key}: ${f.summary ?? ""}`,
            `Status: ${f.status?.name ?? "?"} · Type: ${f.issuetype?.name ?? "?"} · Priority: ${f.priority?.name ?? "?"}`,
            `Assignee: ${f.assignee?.displayName ?? "unassigned"}`,
            desc ? `\n${desc.slice(0, 4000)}${desc.length > 4000 ? "\n[truncated]" : ""}` : "",
          ];
          return text(out.filter(Boolean).join("\n"));
        },
      ),
      tool(
        "jira_list_transitions",
        "List the status transitions available for an issue (needed to move it). " +
          "Returns transition ids and target status names to feed jira_transition_issue.",
        { key: z.string().describe("Issue key, e.g. ENG-123.") },
        async (a) => {
          if (credError) return text(credError);
          const res = await fetch(api(`/issue/${encodeURIComponent(a.key)}/transitions`), { headers });
          if (!res.ok) return text(await asError(res));
          const data = (await res.json()) as { transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }> };
          const lines = (data.transitions ?? []).map((tr) => `- ${tr.id} → ${tr.to?.name ?? tr.name ?? "?"}`);
          return text(lines.join("\n") || "No transitions available.");
        },
      ),
      tool(
        "jira_create_issue",
        "Create a new issue. Requires the project key, issue type name, and a summary.",
        {
          project: z.string().describe("Project key, e.g. ENG."),
          summary: z.string(),
          issueType: z.string().optional().describe("Issue type name (default Task)."),
          description: z.string().optional(),
        },
        async (a) => {
          if (credError) return text(credError);
          const body = {
            fields: {
              project: { key: a.project },
              summary: a.summary,
              issuetype: { name: a.issueType ?? "Task" },
              ...(a.description ? { description: textToAdf(a.description) } : {}),
            },
          };
          const res = await fetch(api("/issue"), { method: "POST", headers, body: JSON.stringify(body) });
          if (!res.ok) return text(await asError(res));
          const created = (await res.json()) as { key?: string };
          return text(`Created ${created.key ?? "issue"}${ready ? ` · ${ready.base}/browse/${created.key}` : ""}.`);
        },
      ),
      tool(
        "jira_transition_issue",
        "Move an issue to a new status by transition id (get ids from jira_list_transitions).",
        {
          key: z.string().describe("Issue key, e.g. ENG-123."),
          transitionId: z.string().describe("Transition id from jira_list_transitions."),
        },
        async (a) => {
          if (credError) return text(credError);
          const res = await fetch(api(`/issue/${encodeURIComponent(a.key)}/transitions`), {
            method: "POST",
            headers,
            body: JSON.stringify({ transition: { id: a.transitionId } }),
          });
          if (!res.ok) return text(await asError(res));
          return text(`Transitioned ${a.key}.`);
        },
      ),
      tool(
        "jira_comment_issue",
        "Add a comment to an issue.",
        { key: z.string().describe("Issue key, e.g. ENG-123."), body: z.string() },
        async (a) => {
          if (credError) return text(credError);
          const res = await fetch(api(`/issue/${encodeURIComponent(a.key)}/comment`), {
            method: "POST",
            headers,
            body: JSON.stringify({ body: textToAdf(a.body) }),
          });
          if (!res.ok) return text(await asError(res));
          return text(`Commented on ${a.key}.`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Linear (GraphQL API)
// ---------------------------------------------------------------------------

const LINEAR_BASE = "https://api.linear.app/graphql";

interface LinearGraphQLError {
  message?: string;
}

/**
 * Run a Linear GraphQL query/mutation with the API key. Returns the `data`
 * payload or a compact error string. Linear returns HTTP 200 with an `errors`
 * array on GraphQL-level failures, so we surface those explicitly.
 */
async function linearGql<T>(
  key: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T | { error: string }> {
  let res: Response;
  try {
    res = await fetch(LINEAR_BASE, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { error: await asError(res) };
  const json = (await res.json()) as { data?: T; errors?: LinearGraphQLError[] };
  if (json.errors?.length) {
    return { error: json.errors.map((e) => e.message ?? "GraphQL error").join("; ") };
  }
  return json.data as T;
}

function linearMcp(key: string, scope: ConnectorScope) {
  return createSdkMcpServer({
    name: "linear",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "linear_list_teams",
        "List Linear teams (with their ids and keys) — needed to create issues.",
        {},
        async () => {
          const data = await linearGql<{ teams?: { nodes?: Array<{ id: string; key: string; name: string }> } }>(
            key,
            `query { teams(first: 50) { nodes { id key name } } }`,
          );
          if ("error" in data) return text(data.error);
          const lines = (data.teams?.nodes ?? []).map((t) => `- ${t.key} · ${t.name} (id: ${t.id})`);
          return text(lines.join("\n") || "No teams.");
        },
      ),
      tool(
        "linear_list_projects",
        "List Linear projects with their ids and current state.",
        { limit: z.number().int().min(1).max(100).optional().describe("Max projects (default 50).") },
        async (a) => {
          const data = await linearGql<{ projects?: { nodes?: Array<{ id: string; name: string; state: string }> } }>(
            key,
            `query ($n: Int!) { projects(first: $n) { nodes { id name state } } }`,
            { n: a.limit ?? 50 },
          );
          if ("error" in data) return text(data.error);
          const lines = (data.projects?.nodes ?? []).map((p) => `- ${p.name} [${p.state}] (id: ${p.id})`);
          return text(lines.join("\n") || "No projects.");
        },
      ),
      tool(
        "linear_search_issues",
        "Search issues by a text term (matches title/description). Returns identifiers, " +
          "titles, state, and assignee.",
        {
          term: z.string().describe("Free-text search term."),
          limit: z.number().int().min(1).max(100).optional().describe("Max issues (default 30)."),
        },
        async (a) => {
          const data = await linearGql<{
            issueSearch?: { nodes?: Array<{ identifier: string; title: string; state?: { name?: string }; assignee?: { name?: string } | null }> };
          }>(
            key,
            `query ($q: String!, $n: Int!) {
              issueSearch(query: $q, first: $n) {
                nodes { identifier title state { name } assignee { name } }
              }
            }`,
            { q: a.term, n: a.limit ?? 30 },
          );
          if ("error" in data) return text(data.error);
          const lines = (data.issueSearch?.nodes ?? []).map(
            (i) => `- ${i.identifier} [${i.state?.name ?? "?"}] ${i.title}${i.assignee ? ` · @${i.assignee.name}` : " · unassigned"}`,
          );
          return text(lines.join("\n") || "No matching issues.");
        },
      ),
      tool(
        "linear_get_issue",
        "Read one issue's full detail by its identifier (e.g. ENG-123).",
        { identifier: z.string().describe("Issue identifier, e.g. ENG-123.") },
        async (a) => {
          const data = await linearGql<{
            issue?: { identifier: string; title: string; description?: string; state?: { name?: string }; assignee?: { name?: string } | null; priorityLabel?: string };
          }>(
            key,
            `query ($id: String!) {
              issue(id: $id) { identifier title description state { name } assignee { name } priorityLabel }
            }`,
            { id: a.identifier },
          );
          if ("error" in data) return text(data.error);
          const i = data.issue;
          if (!i) return text("Issue not found.");
          const desc = (i.description ?? "").trim();
          return text(
            [
              `${i.identifier}: ${i.title}`,
              `State: ${i.state?.name ?? "?"} · Priority: ${i.priorityLabel ?? "?"} · Assignee: ${i.assignee?.name ?? "unassigned"}`,
              desc ? `\n${desc.slice(0, 4000)}${desc.length > 4000 ? "\n[truncated]" : ""}` : "",
            ].filter(Boolean).join("\n"),
          );
        },
      ),
      tool(
        "linear_list_states",
        "List the workflow states (with ids) for a team — needed to move an issue's state.",
        { teamId: z.string().describe("Team id from linear_list_teams.") },
        async (a) => {
          const data = await linearGql<{
            team?: { states?: { nodes?: Array<{ id: string; name: string; type: string }> } };
          }>(
            key,
            `query ($id: String!) { team(id: $id) { states { nodes { id name type } } } }`,
            { id: a.teamId },
          );
          if ("error" in data) return text(data.error);
          const lines = (data.team?.states?.nodes ?? []).map((s) => `- ${s.name} [${s.type}] (id: ${s.id})`);
          return text(lines.join("\n") || "No states.");
        },
      ),
      tool(
        "linear_create_issue",
        "Create a new issue in a team. Requires the team id (from linear_list_teams) and a title.",
        {
          teamId: z.string().describe("Team id from linear_list_teams."),
          title: z.string(),
          description: z.string().optional(),
        },
        async (a) => {
          const data = await linearGql<{ issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } } }>(
            key,
            `mutation ($input: IssueCreateInput!) {
              issueCreate(input: $input) { success issue { identifier url } }
            }`,
            { input: { teamId: a.teamId, title: a.title, description: a.description } },
          );
          if ("error" in data) return text(data.error);
          const issue = data.issueCreate?.issue;
          return text(
            data.issueCreate?.success
              ? `Created ${issue?.identifier ?? "issue"}${issue?.url ? ` · ${issue.url}` : ""}.`
              : "Linear reported the create did not succeed.",
          );
        },
      ),
      tool(
        "linear_update_issue_state",
        "Move an issue to a new workflow state by state id (get ids from linear_list_states).",
        {
          issueId: z.string().describe("Issue id or identifier (e.g. ENG-123)."),
          stateId: z.string().describe("Target workflow state id from linear_list_states."),
        },
        async (a) => {
          const data = await linearGql<{ issueUpdate?: { success?: boolean } }>(
            key,
            `mutation ($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) { success }
            }`,
            { id: a.issueId, input: { stateId: a.stateId } },
          );
          if ("error" in data) return text(data.error);
          return text(data.issueUpdate?.success ? `Updated ${a.issueId}.` : "Linear reported the update did not succeed.");
        },
      ),
      tool(
        "linear_comment_issue",
        "Add a comment to an issue.",
        {
          issueId: z.string().describe("Issue id or identifier (e.g. ENG-123)."),
          body: z.string(),
        },
        async (a) => {
          const data = await linearGql<{ commentCreate?: { success?: boolean } }>(
            key,
            `mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
            { input: { issueId: a.issueId, body: a.body } },
          );
          if ("error" in data) return text(data.error);
          return text(data.commentCreate?.success ? `Commented on ${a.issueId}.` : "Linear reported the comment did not succeed.");
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Databases (PostgreSQL + SQLite)
// ---------------------------------------------------------------------------

/** Hard cap on rows rendered back to the agent, to keep tool results compact. */
const DB_MAX_ROWS = 200;
/** Hard cap on the rendered length of a single cell value. */
const DB_MAX_CELL = 500;

/**
 * Reject anything that isn't a single read-only statement. Used by the
 * read-only `query` tools so a connector in `read` scope can't smuggle a
 * mutation through the query tool. We strip leading SQL comments/whitespace and
 * require the statement to start with SELECT or WITH, contain no statement
 * separator that begins a second statement, and not contain a data-changing
 * keyword as its leading verb. This is a guard, not a full SQL parser, so the
 * actual write path stays the separate `execute` tool (gated by WRITE_TOOLS).
 */
function assertReadOnlySql(sql: string): string | undefined {
  // Drop leading line (--) and block (/* */) comments plus whitespace.
  let s = sql.trim();
  // Remove leading comments repeatedly.
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trimStart();
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  if (!s) return "Empty query.";
  const lead = s.slice(0, 6).toLowerCase();
  if (!lead.startsWith("select") && !lead.startsWith("with")) {
    return "Read-only query must start with SELECT or WITH. Use the *_execute tool (write scope) for mutations.";
  }
  // Disallow a trailing second statement (anything non-trivial after a `;`).
  const semi = s.indexOf(";");
  if (semi !== -1 && s.slice(semi + 1).trim().length > 0) {
    return "Only a single statement is allowed in a read-only query.";
  }
  return undefined;
}

/** Format an array of row objects as a compact text table for tool output. */
function formatRows(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "(0 rows)";
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, DB_MAX_ROWS);
  const render = (v: unknown): string => {
    if (v === null || v === undefined) return "NULL";
    let str: string;
    if (v instanceof Date) str = v.toISOString();
    else if (typeof v === "object") str = JSON.stringify(v);
    else if (Buffer.isBuffer(v)) str = `<${v.length} bytes>`;
    else str = String(v);
    return str.length > DB_MAX_CELL ? str.slice(0, DB_MAX_CELL) + "…" : str;
  };
  const lines = [cols.join(" | ")];
  for (const row of shown) lines.push(cols.map((c) => render(row[c])).join(" | "));
  let out = lines.join("\n");
  if (rows.length > DB_MAX_ROWS) out += `\n… ${rows.length - DB_MAX_ROWS} more row(s) truncated`;
  return out;
}

// --- PostgreSQL ------------------------------------------------------------

type PgModule = typeof import("pg");
let pgModule: PgModule | undefined;
let pgLoadAttempted = false;

/** Lazily load the optional `pg` dependency once. Undefined if unavailable. */
async function loadPg(): Promise<PgModule | undefined> {
  if (pgLoadAttempted) return pgModule;
  pgLoadAttempted = true;
  try {
    pgModule = (await import(/* @vite-ignore */ "pg")).default as unknown as PgModule;
  } catch (err) {
    log.warn("[connector] pg not available — PostgreSQL connector disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    pgModule = undefined;
  }
  return pgModule;
}

/**
 * Run a query against a one-shot PostgreSQL client built from the connection
 * string. A fresh client per call keeps the connector stateless (no pool to
 * manage across runs); fine for the inspect/occasional-write workload here.
 */
async function pgRun(
  conn: string,
  sql: string,
  params: unknown[] | undefined,
  readonly = false,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null } | { error: string }> {
  const pg = await loadPg();
  if (!pg) return { error: "PostgreSQL driver (pg) is not installed on the host." };
  const client = new pg.Client({ connectionString: conn });
  try {
    await client.connect();
    if (readonly) {
      // Enforce read-only at the transaction layer rather than by inspecting the
      // SQL text: Postgres rejects ANY write inside a READ ONLY transaction,
      // including data-modifying CTEs (`WITH x AS (DELETE … RETURNING *) SELECT …`)
      // and `SELECT … INTO`, which a leading-keyword check (assertReadOnlySql)
      // lets through. Roll back afterwards — a read query commits nothing anyway.
      await client.query("BEGIN TRANSACTION READ ONLY");
      try {
        const res = await client.query(sql, params);
        return { rows: (res.rows ?? []) as Record<string, unknown>[], rowCount: res.rowCount };
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    }
    const res = await client.query(sql, params);
    return { rows: (res.rows ?? []) as Record<string, unknown>[], rowCount: res.rowCount };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => {});
  }
}

function postgresMcp(conn: string, scope: ConnectorScope) {
  return createSdkMcpServer({
    name: "postgres",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "postgres_list_tables",
        "List tables (and views) in the PostgreSQL database, with their schema. " +
          "Excludes the internal pg_catalog / information_schema namespaces.",
        {
          schema: z.string().optional().describe("Restrict to one schema (default: all user schemas)."),
        },
        async (a) => {
          const where = a.schema
            ? "table_schema = $1"
            : "table_schema NOT IN ('pg_catalog', 'information_schema')";
          const r = await pgRun(
            conn,
            `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE ${where} ORDER BY table_schema, table_name`,
            a.schema ? [a.schema] : undefined,
            true,
          );
          if ("error" in r) return text(`Error: ${r.error}`);
          return text(formatRows(r.rows));
        },
      ),
      tool(
        "postgres_describe_schema",
        "Describe a table's columns: name, type, nullability, and default. Also " +
          "lists primary-key columns.",
        {
          table: z.string().describe("Table name."),
          schema: z.string().optional().describe("Schema name (default: public)."),
        },
        async (a) => {
          const schema = a.schema ?? "public";
          const cols = await pgRun(
            conn,
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, a.table],
            true,
          );
          if ("error" in cols) return text(`Error: ${cols.error}`);
          if (!cols.rows.length) return text(`No such table ${schema}.${a.table}.`);
          const pk = await pgRun(
            conn,
            `SELECT a.attname AS column_name
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = ($1)::regclass AND i.indisprimary`,
            [`${schema}.${a.table}`],
            true,
          );
          let out = `Columns of ${schema}.${a.table}:\n${formatRows(cols.rows)}`;
          if (!("error" in pk) && pk.rows.length) {
            out += `\n\nPrimary key: ${pk.rows.map((r) => r.column_name).join(", ")}`;
          }
          return text(out);
        },
      ),
      tool(
        "postgres_query",
        "Run a read-only SQL query (SELECT / WITH) against the PostgreSQL database " +
          "and return the rows. Use $1, $2, … placeholders with the params array to " +
          "avoid SQL injection. For mutations use postgres_execute (write scope).",
        {
          sql: z.string().describe("A single SELECT/WITH statement."),
          params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Bound parameters for $1, $2, …"),
        },
        async (a) => {
          const bad = assertReadOnlySql(a.sql);
          if (bad) return text(`Rejected: ${bad}`);
          const r = await pgRun(conn, a.sql, a.params, true);
          if ("error" in r) return text(`Error: ${r.error}`);
          return text(formatRows(r.rows));
        },
      ),
      tool(
        "postgres_execute",
        "Run a mutating SQL statement (INSERT / UPDATE / DELETE / DDL) against the " +
          "PostgreSQL database. Use $1, $2, … placeholders with the params array. " +
          "Returns the affected row count. Requires write scope.",
        {
          sql: z.string().describe("A single mutating statement."),
          params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Bound parameters for $1, $2, …"),
        },
        async (a) => {
          const r = await pgRun(conn, a.sql, a.params);
          if ("error" in r) return text(`Error: ${r.error}`);
          const n = r.rowCount ?? 0;
          if (r.rows.length) return text(`OK (${n} row(s)):\n${formatRows(r.rows)}`);
          return text(`OK — ${n} row(s) affected.`);
        },
      ),
    ], scope),
  });
}

// --- SQLite ----------------------------------------------------------------

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: SqliteModule | undefined;
let sqliteLoadAttempted = false;

/**
 * Lazily load Node's built-in `node:sqlite` (stable in Node 22.5+/24). On older
 * runtimes the import throws and the connector degrades to disabled.
 */
async function loadSqlite(): Promise<SqliteModule | undefined> {
  if (sqliteLoadAttempted) return sqliteModule;
  sqliteLoadAttempted = true;
  try {
    sqliteModule = await import(/* @vite-ignore */ "node:sqlite");
  } catch (err) {
    log.warn("[connector] node:sqlite not available — SQLite connector disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    sqliteModule = undefined;
  }
  return sqliteModule;
}

/**
 * Run a statement against a freshly-opened SQLite database file. `readonly`
 * opens the file in read-only mode so even a SELECT that tries to write fails.
 * The handle is closed in `finally`, keeping the connector stateless.
 */
async function sqliteRun(
  path: string,
  sql: string,
  params: unknown[] | undefined,
  readonly: boolean,
): Promise<{ rows: Record<string, unknown>[]; changes: number } | { error: string }> {
  const mod = await loadSqlite();
  if (!mod) return { error: "node:sqlite is not available on this Node runtime (needs Node 22.5+/24)." };
  let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
  try {
    db = new mod.DatabaseSync(path, { readOnly: readonly, open: true });
    const stmt = db.prepare(sql);
    const bound = (params ?? []) as never[];
    if (stmt.all && /^\s*(select|with|pragma)/i.test(sql)) {
      const rows = stmt.all(...bound) as Record<string, unknown>[];
      return { rows, changes: 0 };
    }
    const res = stmt.run(...bound);
    return { rows: [], changes: Number(res.changes ?? 0) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function sqliteMcp(path: string, scope: ConnectorScope) {
  return createSdkMcpServer({
    name: "sqlite",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "sqlite_list_tables",
        "List the tables (and views) in the SQLite database file.",
        {},
        async () => {
          const r = await sqliteRun(
            path,
            "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
            undefined,
            true,
          );
          if ("error" in r) return text(`Error: ${r.error}`);
          return text(formatRows(r.rows));
        },
      ),
      tool(
        "sqlite_describe_schema",
        "Describe a table's columns (name, type, nullability, default, primary key) " +
          "via PRAGMA table_info.",
        {
          table: z.string().describe("Table name."),
        },
        async (a) => {
          // table_info takes an identifier, not a bound param; validate it tightly.
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.table)) {
            return text("Rejected: table name must be a simple identifier.");
          }
          const r = await sqliteRun(path, `PRAGMA table_info(${a.table})`, undefined, true);
          if ("error" in r) return text(`Error: ${r.error}`);
          if (!r.rows.length) return text(`No such table ${a.table}.`);
          return text(formatRows(r.rows));
        },
      ),
      tool(
        "sqlite_query",
        "Run a read-only SQL query (SELECT / WITH) against the SQLite database and " +
          "return the rows. Use ? placeholders with the params array to avoid SQL " +
          "injection. For mutations use sqlite_execute (write scope).",
        {
          sql: z.string().describe("A single SELECT/WITH statement."),
          params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Bound parameters for ? placeholders."),
        },
        async (a) => {
          const bad = assertReadOnlySql(a.sql);
          if (bad) return text(`Rejected: ${bad}`);
          const r = await sqliteRun(path, a.sql, a.params, true);
          if ("error" in r) return text(`Error: ${r.error}`);
          return text(formatRows(r.rows));
        },
      ),
      tool(
        "sqlite_execute",
        "Run a mutating SQL statement (INSERT / UPDATE / DELETE / DDL) against the " +
          "SQLite database. Use ? placeholders with the params array. Returns the " +
          "number of changed rows. Requires write scope.",
        {
          sql: z.string().describe("A single mutating statement."),
          params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Bound parameters for ? placeholders."),
        },
        async (a) => {
          const r = await sqliteRun(path, a.sql, a.params, false);
          if ("error" in r) return text(`Error: ${r.error}`);
          return text(`OK — ${r.changes} row(s) changed.`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Social connectors — shared multi-account plumbing
// ---------------------------------------------------------------------------

/**
 * Social connectors are multi-account: the panel stores a list of named
 * accounts (label + vault secret) per platform, so e.g. one Lead can post as
 * the company account while another drives a side project. Every social tool
 * takes an optional `account` label; with a single configured account it can
 * be omitted.
 */
interface SocialAccount {
  id: string;
  label: string;
  credential: string;
}

/** Resolve the enabled, credentialed accounts for a social connector id. */
function socialAccountsFor(connectorId: string): SocialAccount[] {
  const c = listConnectors().find((x) => x.id === connectorId);
  if (!c || !c.enabled) return [];
  const out: SocialAccount[] = [];
  for (const a of c.accounts) {
    const credential = a.secretId ? resolveSecret(a.secretId) : undefined;
    if (credential) out.push({ id: a.id, label: a.label, credential });
  }
  return out;
}

/**
 * Pick the account a tool call should act as. Returns the account, or an
 * error string ready to hand back to the agent (listing the valid labels).
 */
function pickAccount(accounts: SocialAccount[], label: string | undefined): SocialAccount | string {
  const labels = () => accounts.map((a) => `"${a.label}"`).join(", ");
  if (label !== undefined && label !== "") {
    const hit = accounts.find((a) => a.label.toLowerCase() === label.toLowerCase());
    return hit ?? `Unknown account "${label}". Configured accounts: ${labels()}.`;
  }
  if (accounts.length === 1) return accounts[0];
  return `Multiple accounts are configured — pass account: one of ${labels()}.`;
}

/** Zod schema for the shared `account` parameter, with labels baked into the description. */
function accountParam(accounts: SocialAccount[]) {
  const hint =
    accounts.length > 1
      ? `Required — one of: ${accounts.map((a) => a.label).join(", ")}.`
      : `Optional (single account "${accounts[0]?.label ?? ""}" is used by default).`;
  return z.string().optional().describe(`Account to act as. ${hint}`);
}

// ---------------------------------------------------------------------------
// Bluesky (AT Protocol, bsky.social PDS)
// ---------------------------------------------------------------------------

const BSKY_BASE = "https://bsky.social/xrpc";
/** Access tokens last ~2h; refresh sessions well within that. */
const BSKY_SESSION_TTL_MS = 60 * 60 * 1000;

interface BskySession {
  jwt: string;
  did: string;
  at: number;
  cred: string;
}

/**
 * Session cache keyed by account id, module-level so repeated turns reuse one
 * session instead of re-authenticating — createSession is rate-limited to
 * 300/day per account. Invalidated when the stored credential changes.
 */
const bskySessions = new Map<string, BskySession>();

async function bskySession(acct: SocialAccount): Promise<{ jwt: string; did: string } | { error: string }> {
  const cached = bskySessions.get(acct.id);
  if (cached && cached.cred === acct.credential && Date.now() - cached.at < BSKY_SESSION_TTL_MS) {
    return { jwt: cached.jwt, did: cached.did };
  }
  const sep = acct.credential.indexOf(":");
  if (sep <= 0) return { error: `Account "${acct.label}": credential must be handle:app-password.` };
  const identifier = acct.credential.slice(0, sep).trim();
  const password = acct.credential.slice(sep + 1).trim();
  const res = await fetch(`${BSKY_BASE}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) return { error: `Bluesky login failed for "${acct.label}": ${await asError(res)}` };
  const data = (await res.json()) as { accessJwt?: string; did?: string };
  if (!data.accessJwt || !data.did) return { error: `Bluesky login failed for "${acct.label}": no session returned.` };
  bskySessions.set(acct.id, { jwt: data.accessJwt, did: data.did, at: Date.now(), cred: acct.credential });
  return { jwt: data.accessJwt, did: data.did };
}

async function bskyGet(jwt: string, nsid: string, params: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  return fetch(`${BSKY_BASE}/${nsid}${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${jwt}` } });
}

async function bskyProc(jwt: string, nsid: string, body: unknown): Promise<Response> {
  return fetch(`${BSKY_BASE}/${nsid}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Detect bare URLs and mark them as link facets (byte offsets, per AT proto's
 * richtext spec) so they render as clickable links instead of plain text.
 */
function bskyLinkFacets(postText: string): object[] | undefined {
  const facets: object[] = [];
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(postText))) {
    const byteStart = Buffer.byteLength(postText.slice(0, m.index), "utf-8");
    facets.push({
      index: { byteStart, byteEnd: byteStart + Buffer.byteLength(m[0], "utf-8") },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  return facets.length ? facets : undefined;
}

/**
 * Normalise a post reference — an `at://` URI or a bsky.app profile URL — to
 * the canonical at-URI, resolving the handle to a DID when needed.
 */
async function bskyPostUri(jwt: string, ref: string): Promise<string | { error: string }> {
  if (ref.startsWith("at://")) return ref;
  const m = ref.match(/bsky\.app\/profile\/([^/]+)\/post\/([\w.~-]+)/);
  if (!m) return { error: `Cannot parse post reference "${ref}" — pass an at:// URI or a bsky.app post URL.` };
  let actor = m[1];
  if (!actor.startsWith("did:")) {
    const res = await bskyGet(jwt, "com.atproto.identity.resolveHandle", { handle: actor });
    if (!res.ok) return { error: `Could not resolve handle "${actor}": ${await asError(res)}` };
    actor = ((await res.json()) as { did?: string }).did ?? "";
    if (!actor) return { error: `Could not resolve handle "${m[1]}".` };
  }
  return `at://${actor}/app.bsky.feed.post/${m[2]}`;
}

interface BskyPostView {
  uri?: string;
  cid?: string;
  author?: { handle?: string; displayName?: string };
  record?: { text?: string; reply?: { root?: { uri?: string; cid?: string } } };
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
}

function summarizeBskyPost(p: BskyPostView): string {
  const when = p.indexedAt ? ` · ${p.indexedAt}` : "";
  const stats = ` · ♥${p.likeCount ?? 0} ↻${p.repostCount ?? 0}`;
  return `- @${p.author?.handle ?? "?"}${when}${stats}\n  ${(p.record?.text ?? "").slice(0, 300)}\n  uri: ${p.uri}`;
}

function blueskyMcp(accounts: SocialAccount[], scope: ConnectorScope) {
  /** Resolve account + session in one step; string result = error for the agent. */
  async function session(label: string | undefined): Promise<{ acct: SocialAccount; jwt: string; did: string } | string> {
    const acct = pickAccount(accounts, label);
    if (typeof acct === "string") return acct;
    const s = await bskySession(acct);
    if ("error" in s) return s.error;
    return { acct, jwt: s.jwt, did: s.did };
  }

  return createSdkMcpServer({
    name: "bluesky",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "bluesky_search",
        "Search Bluesky posts. Returns author, text, engagement counts, and the post uri.",
        {
          account: accountParam(accounts),
          query: z.string().describe("Search query."),
          limit: z.number().int().min(1).max(50).optional().describe("Max results (default 15)."),
        },
        async (a) => {
          const s = await session(a.account);
          if (typeof s === "string") return text(s);
          const res = await bskyGet(s.jwt, "app.bsky.feed.searchPosts", { q: a.query, limit: String(a.limit ?? 15) });
          if (!res.ok) return text(`Error: ${await asError(res)}`);
          const posts = ((await res.json()) as { posts?: BskyPostView[] }).posts ?? [];
          return text(posts.map(summarizeBskyPost).join("\n") || "No matches.");
        },
      ),
      tool(
        "bluesky_timeline",
        "Read the account's home timeline (recent posts from followed accounts).",
        {
          account: accountParam(accounts),
          limit: z.number().int().min(1).max(50).optional().describe("Max posts (default 15)."),
        },
        async (a) => {
          const s = await session(a.account);
          if (typeof s === "string") return text(s);
          const res = await bskyGet(s.jwt, "app.bsky.feed.getTimeline", { limit: String(a.limit ?? 15) });
          if (!res.ok) return text(`Error: ${await asError(res)}`);
          const feed = ((await res.json()) as { feed?: { post?: BskyPostView }[] }).feed ?? [];
          return text(feed.map((f) => summarizeBskyPost(f.post ?? {})).join("\n") || "Timeline is empty.");
        },
      ),
      tool(
        "bluesky_notifications",
        "List recent notifications (likes, reposts, replies, follows, mentions) for the account.",
        {
          account: accountParam(accounts),
          limit: z.number().int().min(1).max(50).optional().describe("Max notifications (default 20)."),
        },
        async (a) => {
          const s = await session(a.account);
          if (typeof s === "string") return text(s);
          const res = await bskyGet(s.jwt, "app.bsky.notification.listNotifications", { limit: String(a.limit ?? 20) });
          if (!res.ok) return text(`Error: ${await asError(res)}`);
          const items =
            ((await res.json()) as { notifications?: { reason?: string; author?: { handle?: string }; indexedAt?: string; record?: { text?: string }; uri?: string }[] }).notifications ?? [];
          const lines = items.map(
            (n) => `- ${n.reason ?? "?"} by @${n.author?.handle ?? "?"} · ${n.indexedAt ?? ""}${n.record?.text ? `\n  ${n.record.text.slice(0, 200)}` : ""}`,
          );
          return text(lines.join("\n") || "No notifications.");
        },
      ),
      tool(
        "bluesky_post",
        "Publish a post on Bluesky (max 300 chars). Optionally reply to an existing post " +
          "by its at:// URI or bsky.app URL. URLs in the text become clickable links.",
        {
          account: accountParam(accounts),
          text: z.string().max(300).describe("Post text (300 chars max)."),
          replyTo: z.string().optional().describe("Post to reply to: at:// URI or https://bsky.app/... URL."),
        },
        async (a) => {
          const s = await session(a.account);
          if (typeof s === "string") return text(s);
          const record: Record<string, unknown> = {
            $type: "app.bsky.feed.post",
            text: a.text,
            createdAt: new Date().toISOString(),
          };
          const facets = bskyLinkFacets(a.text);
          if (facets) record.facets = facets;
          if (a.replyTo) {
            const uri = await bskyPostUri(s.jwt, a.replyTo);
            if (typeof uri !== "string") return text(uri.error);
            const parentRes = await bskyGet(s.jwt, "app.bsky.feed.getPosts", { uris: uri });
            if (!parentRes.ok) return text(`Error fetching parent post: ${await asError(parentRes)}`);
            const parent = (((await parentRes.json()) as { posts?: BskyPostView[] }).posts ?? [])[0];
            if (!parent?.uri || !parent.cid) return text("Parent post not found.");
            const parentRef = { uri: parent.uri, cid: parent.cid };
            record.reply = { root: parent.record?.reply?.root ?? parentRef, parent: parentRef };
          }
          const res = await bskyProc(s.jwt, "com.atproto.repo.createRecord", {
            repo: s.did,
            collection: "app.bsky.feed.post",
            record,
          });
          if (!res.ok) return text(`Error: ${await asError(res)}`);
          const out = (await res.json()) as { uri?: string };
          return text(`Posted as ${s.acct.label}. uri: ${out.uri ?? "unknown"}`);
        },
      ),
      tool(
        "bluesky_delete_post",
        "Delete one of the account's own Bluesky posts by at:// URI or bsky.app URL.",
        {
          account: accountParam(accounts),
          uri: z.string().describe("at:// URI or bsky.app URL of the post to delete."),
        },
        async (a) => {
          const s = await session(a.account);
          if (typeof s === "string") return text(s);
          const uri = await bskyPostUri(s.jwt, a.uri);
          if (typeof uri !== "string") return text(uri.error);
          const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
          if (!m) return text(`Cannot parse at-URI "${uri}".`);
          const res = await bskyProc(s.jwt, "com.atproto.repo.deleteRecord", {
            repo: m[1],
            collection: m[2],
            rkey: m[3],
          });
          if (!res.ok) return text(`Error: ${await asError(res)}`);
          return text("Post deleted.");
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Mastodon (any instance; credential is access-token@instance)
// ---------------------------------------------------------------------------

/** Split a `token@instance` credential into a base URL + token, or an error. */
function mastodonCred(acct: SocialAccount): { base: string; token: string } | { error: string } {
  const sep = acct.credential.indexOf("@");
  if (sep <= 0) return { error: `Account "${acct.label}": credential must be access-token@instance.` };
  const token = acct.credential.slice(0, sep).trim();
  let host = acct.credential.slice(sep + 1).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  return { base: host, token };
}

/** Strip the HTML Mastodon wraps status content in, for compact tool output. */
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

interface MastodonStatus {
  id?: string;
  content?: string;
  created_at?: string;
  visibility?: string;
  account?: { acct?: string };
  favourites_count?: number;
  reblogs_count?: number;
  url?: string;
}

function summarizeStatus(st: MastodonStatus): string {
  return `- @${st.account?.acct ?? "?"} · ${st.created_at ?? ""} · ★${st.favourites_count ?? 0} ↻${st.reblogs_count ?? 0}\n  ${stripHtml(st.content ?? "").slice(0, 300)}\n  id: ${st.id} · ${st.url ?? ""}`;
}

function mastodonMcp(accounts: SocialAccount[], scope: ConnectorScope) {
  /**
   * The instance host is user-supplied, so every request goes through the
   * SSRF-guarded safeFetch (same treatment as other user-provided URLs).
   */
  async function mastoFetch(
    label: string | undefined,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ res: Response; acct: SocialAccount } | string> {
    const acct = pickAccount(accounts, label);
    if (typeof acct === "string") return acct;
    const cred = mastodonCred(acct);
    if ("error" in cred) return cred.error;
    try {
      const res = await safeFetch(`${cred.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cred.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { res, acct };
    } catch (e) {
      return `Error reaching instance: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return createSdkMcpServer({
    name: "mastodon",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "mastodon_search",
        "Search the account's Mastodon instance for statuses and accounts.",
        {
          account: accountParam(accounts),
          query: z.string().describe("Search query."),
          limit: z.number().int().min(1).max(40).optional().describe("Max results per type (default 10)."),
        },
        async (a) => {
          const q = new URLSearchParams({ q: a.query, limit: String(a.limit ?? 10) }).toString();
          const r = await mastoFetch(a.account, "GET", `/api/v2/search?${q}`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { statuses?: MastodonStatus[]; accounts?: { acct?: string; display_name?: string; followers_count?: number }[] };
          const parts: string[] = [];
          if (data.accounts?.length) {
            parts.push("Accounts:", ...data.accounts.map((u) => `- @${u.acct} (${u.display_name ?? ""}) · ${u.followers_count ?? 0} followers`));
          }
          if (data.statuses?.length) parts.push("Statuses:", ...data.statuses.map(summarizeStatus));
          return text(parts.join("\n") || "No matches.");
        },
      ),
      tool(
        "mastodon_timeline",
        "Read the account's home timeline (recent statuses from followed accounts).",
        {
          account: accountParam(accounts),
          limit: z.number().int().min(1).max(40).optional().describe("Max statuses (default 15)."),
        },
        async (a) => {
          const r = await mastoFetch(a.account, "GET", `/api/v1/timelines/home?limit=${a.limit ?? 15}`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const statuses = (await r.res.json()) as MastodonStatus[];
          return text(statuses.map(summarizeStatus).join("\n") || "Timeline is empty.");
        },
      ),
      tool(
        "mastodon_notifications",
        "List recent notifications (mentions, favourites, boosts, follows) for the account.",
        {
          account: accountParam(accounts),
          limit: z.number().int().min(1).max(30).optional().describe("Max notifications (default 15)."),
        },
        async (a) => {
          const r = await mastoFetch(a.account, "GET", `/api/v1/notifications?limit=${a.limit ?? 15}`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const items = (await r.res.json()) as { type?: string; created_at?: string; account?: { acct?: string }; status?: MastodonStatus }[];
          const lines = items.map(
            (n) => `- ${n.type ?? "?"} by @${n.account?.acct ?? "?"} · ${n.created_at ?? ""}${n.status?.content ? `\n  ${stripHtml(n.status.content).slice(0, 200)}` : ""}`,
          );
          return text(lines.join("\n") || "No notifications.");
        },
      ),
      tool(
        "mastodon_post",
        "Publish a status (toot) on Mastodon. Supports replies, visibility levels, and a content warning.",
        {
          account: accountParam(accounts),
          text: z.string().max(5000).describe("Status text."),
          visibility: z.enum(["public", "unlisted", "private", "direct"]).optional().describe("Default public."),
          inReplyToId: z.string().optional().describe("Status id to reply to."),
          spoilerText: z.string().optional().describe("Content-warning text; folds the status behind it."),
        },
        async (a) => {
          const body: Record<string, unknown> = { status: a.text };
          if (a.visibility) body.visibility = a.visibility;
          if (a.inReplyToId) body.in_reply_to_id = a.inReplyToId;
          if (a.spoilerText) body.spoiler_text = a.spoilerText;
          const r = await mastoFetch(a.account, "POST", "/api/v1/statuses", body);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const st = (await r.res.json()) as MastodonStatus;
          return text(`Posted as ${r.acct.label}. id: ${st.id ?? "?"} · ${st.url ?? ""}`);
        },
      ),
      tool(
        "mastodon_delete_post",
        "Delete one of the account's own statuses by id.",
        {
          account: accountParam(accounts),
          id: z.string().describe("Status id to delete."),
        },
        async (a) => {
          const r = await mastoFetch(a.account, "DELETE", `/api/v1/statuses/${encodeURIComponent(a.id)}`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          return text("Status deleted.");
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Discord (bot token)
// ---------------------------------------------------------------------------

const DISCORD_BASE = "https://discord.com/api/v10";

function discordMcp(accounts: SocialAccount[], scope: ConnectorScope) {
  async function discordFetch(
    label: string | undefined,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ res: Response; acct: SocialAccount } | string> {
    const acct = pickAccount(accounts, label);
    if (typeof acct === "string") return acct;
    const res = await fetch(`${DISCORD_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${acct.credential}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { res, acct };
  }

  return createSdkMcpServer({
    name: "discord",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "discord_list_channels",
        "List text channels in a Discord server the bot has joined. Without a guildId, " +
          "lists the bot's servers (or the channels directly when it is in exactly one).",
        {
          account: accountParam(accounts),
          guildId: z.string().optional().describe("Server (guild) id; omit to discover."),
        },
        async (a) => {
          let guildId = a.guildId;
          if (!guildId) {
            const r = await discordFetch(a.account, "GET", "/users/@me/guilds");
            if (typeof r === "string") return text(r);
            if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
            const guilds = (await r.res.json()) as { id?: string; name?: string }[];
            if (guilds.length === 0) return text("The bot is not in any server — invite it first.");
            if (guilds.length > 1) {
              return text(`Bot is in ${guilds.length} servers — pass guildId:\n${guilds.map((g) => `- ${g.name} · id ${g.id}`).join("\n")}`);
            }
            guildId = guilds[0].id!;
          }
          const r = await discordFetch(a.account, "GET", `/guilds/${encodeURIComponent(guildId)}/channels`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const channels = (await r.res.json()) as { id?: string; name?: string; type?: number }[];
          // Types 0 (text) and 5 (announcement) are the ones messages go to.
          const lines = channels.filter((c) => c.type === 0 || c.type === 5).map((c) => `- #${c.name} · id ${c.id}${c.type === 5 ? " (announcements)" : ""}`);
          return text(lines.join("\n") || "No text channels visible to the bot.");
        },
      ),
      tool(
        "discord_read_messages",
        "Read recent messages from a Discord channel by id.",
        {
          account: accountParam(accounts),
          channelId: z.string().describe("Channel id (from discord_list_channels)."),
          limit: z.number().int().min(1).max(100).optional().describe("Number of messages (default 20)."),
        },
        async (a) => {
          const r = await discordFetch(a.account, "GET", `/channels/${encodeURIComponent(a.channelId)}/messages?limit=${a.limit ?? 20}`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const msgs = (await r.res.json()) as { id?: string; content?: string; timestamp?: string; author?: { username?: string; bot?: boolean } }[];
          const lines = msgs.map(
            (msg) => `- ${msg.author?.username ?? "?"}${msg.author?.bot ? " [bot]" : ""} · ${msg.timestamp ?? ""} · id ${msg.id}\n  ${(msg.content ?? "").slice(0, 300)}`,
          );
          return text(lines.join("\n") || "No messages.");
        },
      ),
      tool(
        "discord_post",
        "Post a message to a Discord channel as the bot. Markdown supported.",
        {
          account: accountParam(accounts),
          channelId: z.string().describe("Channel id to post into."),
          text: z.string().max(2000).describe("Message content (2000 chars max)."),
          replyToMessageId: z.string().optional().describe("Message id to reply to."),
        },
        async (a) => {
          const body: Record<string, unknown> = { content: a.text };
          if (a.replyToMessageId) body.message_reference = { message_id: a.replyToMessageId };
          const r = await discordFetch(a.account, "POST", `/channels/${encodeURIComponent(a.channelId)}/messages`, body);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const msg = (await r.res.json()) as { id?: string };
          return text(`Posted as ${r.acct.label}. message id: ${msg.id ?? "?"}`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Reddit (script-app password grant)
// ---------------------------------------------------------------------------

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_OAUTH_BASE = "https://oauth.reddit.com";
/** Reddit access tokens last 1h; refresh a little early. */
const REDDIT_TOKEN_TTL_MS = 50 * 60 * 1000;

interface RedditCred {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

/** Parse `client_id:client_secret:username:password` (password may contain colons). */
function redditCred(acct: SocialAccount): RedditCred | { error: string } {
  const parts = acct.credential.split(":");
  if (parts.length < 4) {
    return { error: `Account "${acct.label}": credential must be client_id:client_secret:username:password.` };
  }
  const [clientId, clientSecret, username] = parts;
  return { clientId, clientSecret, username, password: parts.slice(3).join(":") };
}

function redditUserAgent(username: string): string {
  return `myagens:connector:v1 (by /u/${username})`;
}

const redditTokens = new Map<string, { token: string; at: number; cred: string }>();

/** OAuth token via the password grant, cached per account (1h token lifetime). */
async function redditToken(acct: SocialAccount): Promise<{ token: string; ua: string } | { error: string }> {
  const cred = redditCred(acct);
  if ("error" in cred) return cred;
  const ua = redditUserAgent(cred.username);
  const cached = redditTokens.get(acct.id);
  if (cached && cached.cred === acct.credential && Date.now() - cached.at < REDDIT_TOKEN_TTL_MS) {
    return { token: cached.token, ua };
  }
  const res = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": ua,
    },
    body: new URLSearchParams({ grant_type: "password", username: cred.username, password: cred.password }).toString(),
  });
  if (!res.ok) return { error: `Reddit login failed for "${acct.label}": ${await asError(res)}` };
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    return { error: `Reddit login failed for "${acct.label}": ${data.error ?? "no token"} (note: the password grant does not work with 2FA enabled).` };
  }
  redditTokens.set(acct.id, { token: data.access_token, at: Date.now(), cred: acct.credential });
  return { token: data.access_token, ua };
}

interface RedditPost {
  id?: string;
  title?: string;
  subreddit?: string;
  author?: string;
  score?: number;
  num_comments?: number;
  selftext?: string;
  url?: string;
  permalink?: string;
  created_utc?: number;
}

function summarizeRedditPost(p: RedditPost): string {
  return `- [${p.subreddit}] ${p.title} · by u/${p.author} · ↑${p.score ?? 0} · ${p.num_comments ?? 0} comments · id ${p.id}\n  https://reddit.com${p.permalink ?? ""}`;
}

function redditMcp(accounts: SocialAccount[], scope: ConnectorScope) {
  async function redditFetch(
    label: string | undefined,
    method: string,
    path: string,
    form?: Record<string, string>,
  ): Promise<{ res: Response; acct: SocialAccount } | string> {
    const acct = pickAccount(accounts, label);
    if (typeof acct === "string") return acct;
    const t = await redditToken(acct);
    if ("error" in t) return t.error;
    const res = await fetch(`${REDDIT_OAUTH_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t.token}`,
        "User-Agent": t.ua,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    return { res, acct };
  }

  /** Reddit's api_type=json responses bury errors in json.errors tuples. */
  function redditApiErrors(data: { json?: { errors?: unknown[][] } }): string | undefined {
    const errs = data.json?.errors;
    if (errs && errs.length) return errs.map((e) => e.join(": ")).join("; ");
    return undefined;
  }

  return createSdkMcpServer({
    name: "reddit",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "reddit_search",
        "Search Reddit posts, optionally within one subreddit.",
        {
          account: accountParam(accounts),
          query: z.string().describe("Search query."),
          subreddit: z.string().optional().describe("Restrict to this subreddit (name only, no r/)."),
          sort: z.enum(["relevance", "new", "top", "comments"]).optional().describe("Default relevance."),
          limit: z.number().int().min(1).max(50).optional().describe("Max results (default 15)."),
        },
        async (a) => {
          const qs = new URLSearchParams({ q: a.query, limit: String(a.limit ?? 15), sort: a.sort ?? "relevance" });
          let path = `/search?${qs}`;
          if (a.subreddit) path = `/r/${encodeURIComponent(a.subreddit)}/search?${qs}&restrict_sr=1`;
          const r = await redditFetch(a.account, "GET", path);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { data?: { children?: { data?: RedditPost }[] } };
          const posts = (data.data?.children ?? []).map((c) => c.data ?? {});
          return text(posts.map(summarizeRedditPost).join("\n") || "No matches.");
        },
      ),
      tool(
        "reddit_list_subreddit",
        "List recent/hot posts in a subreddit.",
        {
          account: accountParam(accounts),
          subreddit: z.string().describe("Subreddit name (no r/)."),
          sort: z.enum(["hot", "new", "top", "rising"]).optional().describe("Default hot."),
          limit: z.number().int().min(1).max(50).optional().describe("Max posts (default 15)."),
        },
        async (a) => {
          const r = await redditFetch(
            a.account,
            "GET",
            `/r/${encodeURIComponent(a.subreddit)}/${a.sort ?? "hot"}?limit=${a.limit ?? 15}`,
          );
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { data?: { children?: { data?: RedditPost }[] } };
          const posts = (data.data?.children ?? []).map((c) => c.data ?? {});
          return text(posts.map(summarizeRedditPost).join("\n") || "No posts.");
        },
      ),
      tool(
        "reddit_read_post",
        "Read a Reddit post and its top comments by post id.",
        {
          account: accountParam(accounts),
          postId: z.string().describe("Post id (with or without the t3_ prefix)."),
          commentLimit: z.number().int().min(0).max(50).optional().describe("Top-level comments to include (default 10)."),
        },
        async (a) => {
          const id = a.postId.replace(/^t3_/, "");
          const r = await redditFetch(a.account, "GET", `/comments/${encodeURIComponent(id)}?limit=${a.commentLimit ?? 10}&depth=1`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { data?: { children?: { data?: RedditPost & { body?: string } }[] } }[];
          const post = data[0]?.data?.children?.[0]?.data;
          if (!post) return text("Post not found.");
          const comments = (data[1]?.data?.children ?? [])
            .map((c) => c.data)
            .filter((c): c is RedditPost & { body?: string } => !!c?.body);
          const lines = [
            `[${post.subreddit}] ${post.title} · by u/${post.author} · ↑${post.score ?? 0}`,
            post.selftext ? post.selftext.slice(0, 2000) : (post.url ?? ""),
            "",
            ...comments.map((c) => `- u/${c.author} (↑${c.score ?? 0}, id t1_${c.id}): ${(c.body ?? "").slice(0, 400)}`),
          ];
          return text(lines.join("\n"));
        },
      ),
      tool(
        "reddit_submit",
        "Submit a new post to a subreddit — either a text (self) post or a link post.",
        {
          account: accountParam(accounts),
          subreddit: z.string().describe("Subreddit to post in (no r/)."),
          title: z.string().max(300).describe("Post title."),
          text: z.string().optional().describe("Body for a text post (markdown)."),
          url: z.string().optional().describe("URL for a link post (instead of text)."),
        },
        async (a) => {
          if (!a.text && !a.url) return text("Provide either text (self post) or url (link post).");
          const form: Record<string, string> = {
            sr: a.subreddit,
            title: a.title,
            api_type: "json",
            kind: a.url ? "link" : "self",
          };
          if (a.url) form.url = a.url;
          else form.text = a.text ?? "";
          const r = await redditFetch(a.account, "POST", "/api/submit", form);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { json?: { errors?: unknown[][]; data?: { url?: string; id?: string } } };
          const err = redditApiErrors(data);
          if (err) return text(`Reddit error: ${err}`);
          return text(`Submitted as ${r.acct.label}. ${data.json?.data?.url ?? ""}`);
        },
      ),
      tool(
        "reddit_comment",
        "Comment on a post (t3_ id) or reply to a comment (t1_ id).",
        {
          account: accountParam(accounts),
          parentId: z.string().describe("Fullname of the parent: t3_<postId> or t1_<commentId>. A bare id is treated as a post."),
          text: z.string().describe("Comment body (markdown)."),
        },
        async (a) => {
          const parent = /^t[13]_/.test(a.parentId) ? a.parentId : `t3_${a.parentId}`;
          const r = await redditFetch(a.account, "POST", "/api/comment", {
            parent,
            text: a.text,
            api_type: "json",
          });
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { json?: { errors?: unknown[][] } };
          const err = redditApiErrors(data);
          if (err) return text(`Reddit error: ${err}`);
          return text(`Comment posted as ${r.acct.label} under ${parent}.`);
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// X / Twitter (API v2 with OAuth 1.0a user context)
// ---------------------------------------------------------------------------

const X_BASE = "https://api.x.com/2";

interface XCred {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

function xCred(acct: SocialAccount): XCred | { error: string } {
  const parts = acct.credential.split(":");
  if (parts.length !== 4 || parts.some((p) => !p.trim())) {
    return { error: `Account "${acct.label}": credential must be api_key:api_secret:access_token:access_secret.` };
  }
  const [apiKey, apiSecret, accessToken, accessSecret] = parts.map((p) => p.trim());
  return { apiKey, apiSecret, accessToken, accessSecret };
}

/** RFC 3986 percent-encoding (encodeURIComponent leaves !'()* unescaped). */
function pctEnc(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build an OAuth 1.0a Authorization header (HMAC-SHA1) for a request with no
 * query parameters and a JSON body — which covers every X v2 call we make
 * (JSON bodies are excluded from the signature base string by spec).
 */
function oauth1Header(method: string, url: string, c: XCred): string {
  const params: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${pctEnc(k)}=${pctEnc(params[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pctEnc(url)}&${pctEnc(paramStr)}`;
  const key = `${pctEnc(c.apiSecret)}&${pctEnc(c.accessSecret)}`;
  params.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  const header = Object.keys(params)
    .sort()
    .map((k) => `${pctEnc(k)}="${pctEnc(params[k])}"`)
    .join(", ");
  return `OAuth ${header}`;
}

function xMcp(accounts: SocialAccount[], scope: ConnectorScope) {
  async function xFetch(
    label: string | undefined,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ res: Response; acct: SocialAccount } | string> {
    const acct = pickAccount(accounts, label);
    if (typeof acct === "string") return acct;
    const cred = xCred(acct);
    if ("error" in cred) return cred.error;
    const url = `${X_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: oauth1Header(method, url, cred),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { res, acct };
  }

  return createSdkMcpServer({
    name: "x",
    version: "1.0.0",
    tools: scopeTools([
      tool(
        "x_me",
        "Verify the X credentials by fetching the authenticated account's handle. " +
          "Note: heavily rate-limited on the free API tier (~25 calls/day) — use sparingly.",
        {
          account: accountParam(accounts),
        },
        async (a) => {
          const r = await xFetch(a.account, "GET", "/users/me");
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { data?: { username?: string; name?: string; id?: string } };
          return text(`Connected as @${data.data?.username ?? "?"} (${data.data?.name ?? ""}, id ${data.data?.id ?? "?"}).`);
        },
      ),
      tool(
        "x_post",
        "Post a tweet on X, optionally as a reply. Works on the free API tier " +
          "(reading tweets does not — it needs a paid tier).",
        {
          account: accountParam(accounts),
          text: z.string().max(280).describe("Tweet text (280 chars max)."),
          replyToId: z.string().optional().describe("Tweet id to reply to."),
        },
        async (a) => {
          const body: Record<string, unknown> = { text: a.text };
          if (a.replyToId) body.reply = { in_reply_to_tweet_id: a.replyToId };
          const r = await xFetch(a.account, "POST", "/tweets", body);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          const data = (await r.res.json()) as { data?: { id?: string } };
          return text(`Posted as ${r.acct.label}. tweet id: ${data.data?.id ?? "?"}`);
        },
      ),
      tool(
        "x_delete_post",
        "Delete one of the account's own tweets by id.",
        {
          account: accountParam(accounts),
          id: z.string().describe("Tweet id to delete."),
        },
        async (a) => {
          const r = await xFetch(a.account, "DELETE", `/tweets/${encodeURIComponent(a.id)}`);
          if (typeof r === "string") return text(r);
          if (!r.res.ok) return text(`Error: ${await asError(r.res)}`);
          return text("Tweet deleted.");
        },
      ),
    ], scope),
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type McpServer = ReturnType<typeof createSdkMcpServer>;

/** Raw external MCP server config (SSE/HTTP to local process, or stdio subprocess). */
type ExternalMcpServer =
  | { type: "sse" | "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/** Returns true when the connector is toggled on, regardless of whether it has a credential. */
function connectorIsEnabled(id: string): boolean {
  return listConnectors().find((x) => x.id === id)?.enabled ?? false;
}

/**
 * Build the live connector MCP servers that are currently enabled + credentialed.
 * Returns a map keyed by MCP server name, ready to spread into a `runTurn`
 * `mcpServers` object. Empty when nothing is configured.
 */
export function buildConnectorMcps(): Record<string, McpServer | ExternalMcpServer> {
  const out: Record<string, McpServer | ExternalMcpServer> = {};
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
  const slackToken = credentialFor("slack");
  if (slackToken) out.slack = slackMcp(slackToken, connectorScope("slack"));
  const githubToken = credentialFor("github");
  if (githubToken) out.github = githubMcp(githubToken, connectorScope("github"));
  const jiraCred = credentialFor("jira");
  if (jiraCred) out.jira = jiraMcp(jiraCred, connectorScope("jira"));
  const linearKey = credentialFor("linear");
  if (linearKey) out.linear = linearMcp(linearKey, connectorScope("linear"));
  if (connectorIsEnabled("unreal-engine")) {
    // Credential is optional — if set it overrides the default editor URL.
    const urlOverride = credentialFor("unreal-engine");
    const ueUrl = urlOverride ?? "http://127.0.0.1:8000/mcp";
    out["unreal-engine"] = { type: "sse", url: ueUrl };
  }
  const unityScript = credentialFor("unity");
  if (unityScript) {
    // Credential is the absolute path to the mcp-unity Server~/build/index.js script.
    out["unity"] = { type: "stdio", command: "node", args: [unityScript] };
  }
  const pgConn = credentialFor("postgres");
  if (pgConn) out.postgres = postgresMcp(pgConn, connectorScope("postgres"));
  const sqlitePath = credentialFor("sqlite");
  if (sqlitePath) out.sqlite = sqliteMcp(sqlitePath, connectorScope("sqlite"));
  // Social connectors are multi-account: enabled + at least one resolvable account.
  const blueskyAccounts = socialAccountsFor("bluesky");
  if (blueskyAccounts.length) out.bluesky = blueskyMcp(blueskyAccounts, connectorScope("bluesky"));
  const mastodonAccounts = socialAccountsFor("mastodon");
  if (mastodonAccounts.length) out.mastodon = mastodonMcp(mastodonAccounts, connectorScope("mastodon"));
  const discordAccounts = socialAccountsFor("discord");
  if (discordAccounts.length) out.discord = discordMcp(discordAccounts, connectorScope("discord"));
  const redditAccounts = socialAccountsFor("reddit");
  if (redditAccounts.length) out.reddit = redditMcp(redditAccounts, connectorScope("reddit"));
  const xAccounts = socialAccountsFor("x");
  if (xAccounts.length) out.x = xMcp(xAccounts, connectorScope("x"));
  if (Object.keys(out).length) {
    log.debug("Connector MCPs enabled", {
      connectors: Object.keys(out).map((id) => `${id}:${connectorScope(id)}`),
    });
  }
  return out;
}

/** Names of the live connectors that have wired MCP servers (for the panel). */
export const LIVE_CONNECTORS = ["notion", "gcal", "gmail", "gdrive", "apple-calendar", "apple-mail", "slack", "github", "jira", "linear", "unreal-engine", "unity", "postgres", "sqlite", "bluesky", "mastodon", "discord", "reddit", "x"] as const;
