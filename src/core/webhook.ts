import { config } from "../config.js";
import { log } from "../logger.js";
import { assertSafeUrl, BlockedUrlError } from "./safeUrl.js";

/**
 * Outbound completion webhooks. When a schedule or a worker/task run that has a
 * `webhookUrl` finishes, we POST a small JSON outcome payload to that URL, so an
 * outcome can be pushed to n8n / Zapier / a Slack incoming webhook / a personal
 * dashboard. Best-effort and fire-and-forget: a failure is logged, never thrown.
 *
 * Every URL is run through {@link assertSafeUrl} (SSRF guard, SEC-5) before the
 * request, so a webhook can't be pointed at the cloud-metadata IP or other
 * blocked ranges. We deliberately keep loopback/LAN allowed (a self-hosted
 * dashboard on the same box is a valid target).
 */

/** What fired the webhook, so the receiver can route on it. */
export type WebhookSource = "schedule" | "worker" | "task";

export interface WebhookPayload {
  /** "schedule" | "worker" | "task" — what produced this outcome. */
  source: WebhookSource;
  /** Short title of the job (schedule prompt, worker name, or card title). */
  title: string;
  /** "ok" | "error" | "stopped". */
  status: "ok" | "error" | "stopped";
  /** The agent's final summary text, when present. */
  summary?: string;
  /** Run cost in USD, when reported by the SDK. */
  costUsd?: number;
  /** Wall-clock duration of the run in ms, when reported. */
  durationMs?: number;
  /** Error message when status is "error". */
  error?: string;
  /** Id of the originating schedule/worker/task. */
  id?: string;
  /** ISO timestamp of completion. */
  completedAt: string;
}

/**
 * POST `payload` as JSON to `rawUrl`. Validates the URL first, applies the
 * WEBHOOK_TIMEOUT_MS timeout, and swallows every error (logging it). Returns
 * true if the receiver answered with a 2xx, false otherwise.
 */
export async function sendWebhook(rawUrl: string, payload: WebhookPayload): Promise<boolean> {
  const target = rawUrl.trim();
  if (!target) return false;

  let url: URL;
  try {
    url = await assertSafeUrl(target);
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      log.warn("Webhook URL blocked by SSRF guard", { source: payload.source, error: err.message });
    } else {
      log.warn("Webhook URL rejected", { source: payload.source, error: errText(err) });
    }
    return false;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `${config.BRAND_NAME}-webhook` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log.warn("Webhook returned non-2xx", { source: payload.source, status: res.status });
      return false;
    }
    log.info("Webhook delivered", { source: payload.source, status: payload.status });
    return true;
  } catch (err) {
    log.warn("Webhook delivery failed", { source: payload.source, error: errText(err) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire a webhook without awaiting it. No-ops when `rawUrl` is empty. Use this
 * from a run's completion path so webhook latency never blocks the run.
 */
export function fireWebhook(rawUrl: string | undefined, payload: WebhookPayload): void {
  if (!rawUrl?.trim()) return;
  void sendWebhook(rawUrl, payload);
}

/**
 * Validate a webhook URL the way {@link sendWebhook} will (http(s) + SSRF guard)
 * without sending anything. Used by the panel routes to reject a bad URL up
 * front. Returns false for empty/invalid/blocked URLs.
 */
export async function isValidWebhookUrl(rawUrl: string): Promise<boolean> {
  if (!rawUrl.trim()) return false;
  try {
    await assertSafeUrl(rawUrl.trim());
    return true;
  } catch {
    return false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
