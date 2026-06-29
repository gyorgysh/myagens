import { Fragment, type ReactNode } from "react";

// A tiny, dependency-free Markdown renderer for chat messages. It supports the
// same subset the agent actually emits (and that Telegram renders): bold,
// italic, inline code, fenced code blocks, bullet/numbered lists, blockquotes,
// headings, and bare links. It builds React nodes directly — no
// dangerouslySetInnerHTML — so there's no XSS surface.

interface Block {
  type: "p" | "code" | "ul" | "ol" | "quote" | "h";
  // For paragraphs/headings/quotes: raw text lines joined with "\n".
  // For lists: one entry per item. For code: the raw body.
  lines: string[];
  lang?: string;
  level?: number;
}

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
  const isOrdered = (l: string) => /^\s*\d+[.)]\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run off the end)
      blocks.push({ type: "code", lines: [body.join("\n")], lang });
      continue;
    }

    // Blank line — separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "h", level: heading[1].length, lines: [heading[2]] });
      i++;
      continue;
    }

    // Blockquote (consume consecutive "> " lines).
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: quote });
      continue;
    }

    // Bullet list.
    if (isBullet(line)) {
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", lines: items });
      continue;
    }

    // Numbered list.
    if (isOrdered(line)) {
      const items: string[] = [];
      while (i < lines.length && isOrdered(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", lines: items });
      continue;
    }

    // Paragraph — gather until a blank line or a block-starting line.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !isBullet(lines[i]) &&
      !isOrdered(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", lines: para });
  }

  return blocks;
}

// Inline parsing: `code`, **bold**, *italic*/_italic_, and bare URLs.
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on inline code first so markup inside backticks is left literal.
  const segments = text.split(/(`[^`]+`)/g);
  segments.forEach((seg, si) => {
    if (seg.startsWith("`") && seg.endsWith("`") && seg.length >= 2) {
      out.push(
        <code
          key={`${keyBase}-c${si}`}
          className="mono rounded bg-surface-2 px-1 py-0.5 text-[0.85em] text-accent"
        >
          {seg.slice(1, -1)}
        </code>,
      );
      return;
    }
    out.push(...renderEmphasis(seg, `${keyBase}-${si}`));
  });
  return out;
}

function renderEmphasis(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Bold (**x** / __x__), italic (*x* / _x_), [text](url) links, then bare links.
  // The [text](url) alternative is ordered before the bare-URL one so the
  // overlapping `https://...` inside the parentheses doesn't get matched on its
  // own and split the link apart.
  const re =
    /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[([^\]]+)\]\((https?:\/\/[^)]+)\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-e${n++}`;
    if ((tok.startsWith("**") && tok.endsWith("**")) || (tok.startsWith("__") && tok.endsWith("__"))) {
      out.push(<strong key={key} className="font-semibold text-fg">{tok.slice(2, -2)}</strong>);
    } else if (m[2] !== undefined && m[3] !== undefined) {
      // [text](url) — m[2] is the link text, m[3] is the href.
      out.push(
        <a
          key={key}
          href={m[3]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline underline-offset-2 hover:opacity-80"
        >
          {m[2]}
        </a>,
      );
    } else if (tok.startsWith("http")) {
      out.push(
        <a
          key={key}
          href={tok}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline underline-offset-2 hover:opacity-80"
        >
          {tok}
        </a>,
      );
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2">
      {blocks.map((b, bi) => {
        const key = `b${bi}`;
        switch (b.type) {
          case "code":
            return (
              <pre
                key={key}
                className="mono overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-[0.82em] leading-relaxed text-fg"
              >
                <code>{b.lines[0]}</code>
              </pre>
            );
          case "h": {
            // In compact mode (e.g. changelog cards), sub-headings (h2/h3+) are
            // downsized to small uppercase labels so the CHANGELOG's
            // ###-section headers don't render oversized inside a card. The top
            // heading (h1) stays a normal bold line.
            if (compact && (b.level ?? 1) >= 2) {
              return (
                <p
                  key={key}
                  className="mt-1 text-xs font-semibold uppercase tracking-wide text-fg-dim"
                >
                  {renderInline(b.lines[0], key)}
                </p>
              );
            }
            const size =
              b.level === 1 ? "text-base" : b.level === 2 ? "text-sm" : "text-sm";
            return (
              <p key={key} className={`font-semibold text-fg ${size}`}>
                {renderInline(b.lines[0], key)}
              </p>
            );
          }
          case "quote":
            return (
              <blockquote
                key={key}
                className="border-l-2 border-accent/40 pl-3 text-fg-muted"
              >
                {b.lines.map((l, li) => (
                  <Fragment key={li}>
                    {renderInline(l, `${key}-${li}`)}
                    {li < b.lines.length - 1 && <br />}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={key} className="list-disc space-y-1 pl-5 marker:text-fg-dim">
                {b.lines.map((l, li) => (
                  <li key={li}>{renderInline(l, `${key}-${li}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="list-decimal space-y-1 pl-5 marker:text-fg-dim">
                {b.lines.map((l, li) => (
                  <li key={li}>{renderInline(l, `${key}-${li}`)}</li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={key} className="whitespace-pre-wrap break-words">
                {b.lines.map((l, li) => (
                  <Fragment key={li}>
                    {renderInline(l, `${key}-${li}`)}
                    {li < b.lines.length - 1 && <br />}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
