import { normalizeAgentText as _normalize, summarizeArg } from "../telegram/formatting.js";

const SLACK_SAFE_CHUNK_LEN = 3800;

/** A short mrkdwn status fragment for a tool call, for the streaming status line. */
export function summarizeInputMrkdwn(input: unknown): string {
  const s = summarizeArg(input);
  return s ? `\`${s.slice(0, 80)}\`` : "";
}

/** Escape characters that are special in Slack mrkdwn. */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToSlackMrkdwn(input: string): string {
  // Normalize weird spacing first
  let text = _normalize(input);

  // We want to avoid modifying inside code blocks.
  const segments: string[] = [];
  const fenceRe = /```[^\n]*\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > last) {
      segments.push(formatNonCode(text.slice(last, m.index)));
    }
    // Keep fenced code as-is
    segments.push(m[0]);
    last = fenceRe.lastIndex;
  }
  if (last < text.length) {
    segments.push(formatNonCode(text.slice(last)));
  }

  return segments.join("");
}

function formatNonCode(text: string): string {
  // Protect inline code spans
  const codeSpans: string[] = [];
  let working = text.replace(/`([^`\n]+)`/g, (_full, code: string) => {
    codeSpans.push(`\`${code}\``);
    return ` __CODE_${codeSpans.length - 1}__ `;
  });

  // Strip HTML
  working = working.replace(/<[^>]+>/g, "");

  // Headings -> *Heading*\n
  working = working.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "*$1*");

  // Horizontal rules
  working = working.replace(/^[ \t]*---+[ \t]*$/gm, "");

  // Links [text](url) -> <url|text>
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold **bold** -> *bold*
  working = working.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");

  // Italic *italic* -> _italic_
  // We only match single stars that aren't adjacent to another star
  working = working.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1_$2_");

  // Blockquotes are native to slack, leave alone (already not doing anything to >)

  // Restore code spans
  working = working.replace(/ __CODE_(\d+)__ /g, (_f, i: string) => codeSpans[Number(i)] ?? _f);

  return working;
}

/**
 * Split rendered text into pieces without cutting inside an open ``` block.
 */
export function splitForSlack(text: string, maxLen = SLACK_SAFE_CHUNK_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    let head = remaining.slice(0, cut);
    let tail = remaining.slice(cut);

    // If we split inside an open ``` block, close it here and reopen next.
    const backticks = (head.match(/```/g) || []).length;
    if (backticks % 2 !== 0) {
      head += "\n```";
      tail = "```\n" + tail;
    }
    chunks.push(head);
    remaining = tail;
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

// Re-export normalizeAgentText so it can be used directly if needed.
export const normalizeAgentText = _normalize;
