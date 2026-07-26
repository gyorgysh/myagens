import type { WebClient } from "@slack/web-api";
import { markdownToSlackMrkdwn, splitForSlack } from "./formatting.js";
import { log } from "../logger.js";

const SLACK_EDIT_INTERVAL_MS = 1500;
const SLACK_MAX_CHARS = 3800;

export class SlackStreamer {
  private content = "";
  private status = "";
  private footer = "";
  private ts?: string;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private dirty = false;
  private lastRendered = "";

  constructor(
    private web: WebClient,
    private channel: string,
  ) {}

  async start(initialText?: string): Promise<void> {
    try {
      const res = await this.web.chat.postMessage({
        channel: this.channel,
        text: initialText ?? "_Working on it..._",
      });
      if (res.ts) {
        this.ts = res.ts;
      }
    } catch (err) {
      log.error("SlackStreamer start failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  appendText(delta: string): void {
    if (!delta) return;
    this.content += delta;
    this.status = "";
    this.scheduleFlush();
  }

  setStatus(line: string): void {
    this.status = line;
    this.scheduleFlush();
  }

  messageTs(): string | undefined {
    return this.ts;
  }

  /**
   * Seal the current message so it stops receiving edits, and arm the
   * streamer to open a fresh message for whatever comes next. Call this right
   * before posting a permission or AskUserQuestion prompt: without it, that
   * prompt appears once and then sits there while the *original* message
   * keeps getting edited underneath it (or above it, depending on scroll),
   * making it hard to tell where the turn actually is. Breaking the segment
   * here means the channel reads top-to-bottom: streamed content so far,
   * then the prompt, then a new bubble for whatever comes after it's answered.
   */
  async breakForInterrupt(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.status = "";
    if (this.ts && this.dirty) {
      const text = this.render(true);
      if (text !== this.lastRendered) {
        await this.web.chat.update({ channel: this.channel, ts: this.ts, text }).catch(() => {});
      }
    }
    this.dirty = false;
    this.ts = undefined;
    this.content = "";
    this.lastRendered = "";
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((err) => {
        log.debug("SlackStreamer timer flush failed", { error: String(err) });
      });
    }, SLACK_EDIT_INTERVAL_MS);
  }

  private render(truncate: boolean): string {
    let text = this.content;
    
    // Slack max characters per message is usually 40,000, but we want to split 
    // logically. During streaming, if it gets too long, we just truncate.
    if (truncate && text.length > SLACK_MAX_CHARS) {
      text = text.slice(0, SLACK_MAX_CHARS) + "\n\n...(streaming)...";
    }

    let out = markdownToSlackMrkdwn(text);

    if (this.status) {
      out += (out ? "\n\n" : "") + this.status;
    }
    if (this.footer) {
      out += (out ? "\n\n" : "") + `_${this.footer}_`;
    }

    return out.trim() || "_..._";
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.scheduleFlush();
      return;
    }
    if (!this.dirty) return;

    this.flushing = true;
    this.dirty = false;

    const text = this.render(true);

    try {
      if (this.ts === undefined) {
        // breakForInterrupt() sealed the previous message — open a new one.
        const res = await this.web.chat.postMessage({ channel: this.channel, text });
        if (res.ts) {
          this.ts = res.ts;
          this.lastRendered = text;
        }
      } else if (text !== this.lastRendered) {
        await this.web.chat.update({
          channel: this.channel,
          ts: this.ts,
          text,
        });
        this.lastRendered = text;
      }
    } catch (err) {
      // Ignore identical content error or transient rate limits during streaming
    } finally {
      this.flushing = false;
    }
  }

  async finalize(footer?: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.status = "";
    if (footer) {
      this.footer = footer;
    }
    this.dirty = true;

    // Full render, no truncation
    const fullText = this.content;
    const chunks = splitForSlack(markdownToSlackMrkdwn(fullText));
    
    // Append footer to the last chunk
    if (this.footer) {
      chunks[chunks.length - 1] += (chunks[chunks.length - 1] ? "\n\n" : "") + `_${this.footer}_`;
    }

    // If fits in one message, update the open one — or, if breakForInterrupt()
    // sealed the last segment and nothing reopened it, post a fresh one so the
    // final content/footer isn't silently dropped.
    if (chunks.length === 1) {
      const text = chunks[0] || "_..._";
      try {
        if (this.ts) {
          await this.web.chat.update({ channel: this.channel, ts: this.ts, text });
        } else {
          await this.web.chat.postMessage({ channel: this.channel, text });
        }
      } catch (err) {
        log.error("SlackStreamer finalize update failed", { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // If multiple messages, delete the streaming placeholder and post chunks
    if (this.ts) {
      try {
        await this.web.chat.delete({
          channel: this.channel,
          ts: this.ts,
        });
      } catch (err) {
        log.error("SlackStreamer delete original failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const chunk of chunks) {
      try {
        await this.web.chat.postMessage({
          channel: this.channel,
          text: chunk,
        });
        // We could store these ts values if needed for persistency
      } catch (err) {
        log.error("SlackStreamer final chunk post failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
