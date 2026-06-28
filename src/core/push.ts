import { randomBytes } from "node:crypto";
import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import { loadJson, saveJson } from "./jsonStore.js";
import { vault, resolveSecret, secretRef, isSecretRef } from "./vault.js";
import { audit } from "./audit.js";
import { log } from "../logger.js";

/** Options for a push notification. */
export interface PushOptions {
  title: string;
  body: string;
  /** Collapse key: a later notification with the same tag replaces the earlier. */
  tag?: string;
  /** Event category, surfaced to the SW so a click can deep-link the right view. */
  kind?: "task" | "heartbeat" | "approval" | "test" | string;
  /** Path the SW should focus/open when the notification is clicked (default "/"). */
  url?: string;
}

/** A browser Web Push subscription, as produced by PushManager.subscribe(). */
export interface PushSubscriptionRecord {
  /** Stable id we mint, so the panel can show/remove a device. */
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Best-effort device label (User-Agent derived) for the panel list. */
  label?: string;
  createdAt: number;
}

interface PushFile {
  version: 1;
  /** vault:<id> reference to the VAPID private key (kept out of the JSON at rest). */
  vapidPrivateRef?: string;
  /** Public VAPID key (safe to expose; the browser needs it to subscribe). */
  vapidPublicKey?: string;
  subscriptions: PushSubscriptionRecord[];
}

const FILE = "push.json";

/** Panel-safe view: never leaks the VAPID private key. */
export interface PushView {
  /** True once a VAPID keypair exists (push is provisioned). */
  configured: boolean;
  /** The public application-server key the browser subscribes with. */
  publicKey?: string;
  subscriptions: Array<{ id: string; label?: string; createdAt: number }>;
}

/**
 * Web Push notification client. Owns a VAPID keypair (private half stored in the
 * vault, public half in push.json), a store of browser subscriptions, and a
 * fan-out send path. notify() never throws — callers fire-and-forget — and dead
 * subscriptions (410/404) are pruned automatically.
 */
class PushClient {
  private file = loadJson<PushFile>(FILE, { version: 1, subscriptions: [] });

  /** True when a VAPID keypair has been generated. */
  isConfigured(): boolean {
    return Boolean(this.file.vapidPublicKey && this.file.vapidPrivateRef);
  }

  /** How many browser subscriptions are registered. */
  subscriberCount(): number {
    return this.file.subscriptions.length;
  }

  /**
   * Ensure a VAPID keypair exists, generating + persisting one on first call.
   * The private key is stored in the vault (vault:<id>); only the public key is
   * kept in push.json. Returns the public key the browser needs to subscribe.
   */
  ensureVapid(): string {
    if (this.file.vapidPublicKey && this.file.vapidPrivateRef) {
      return this.file.vapidPublicKey;
    }
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    const sec = vault.create({
      name: "web-push:vapid",
      value: privateKey,
      description: "VAPID private key for panel Web Push notifications",
    });
    this.file.vapidPublicKey = publicKey;
    this.file.vapidPrivateRef = secretRef(sec.id);
    this.persist();
    audit("push.vapid-generated", {});
    log.info("Web Push: generated VAPID keypair");
    return publicKey;
  }

  /** The public VAPID key, generating the keypair if needed. */
  publicKey(): string {
    return this.ensureVapid();
  }

  /** Resolve the VAPID private key from the vault (empty string if missing). */
  private privateKey(): string {
    const ref = this.file.vapidPrivateRef;
    if (!ref) return "";
    return isSecretRef(ref) ? resolveSecret(ref) : ref;
  }

  /**
   * Register (or refresh) a browser subscription. Keyed by endpoint so the same
   * device re-subscribing updates in place rather than duplicating. Returns the
   * stored record's id.
   */
  subscribe(sub: WebPushSubscription, label?: string): { id: string } {
    this.ensureVapid();
    const endpoint = sub.endpoint;
    const keys = sub.keys;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new Error("invalid subscription");
    }
    const existing = this.file.subscriptions.find((s) => s.endpoint === endpoint);
    if (existing) {
      existing.keys = { p256dh: keys.p256dh, auth: keys.auth };
      if (label) existing.label = label;
      this.persist();
      return { id: existing.id };
    }
    const record: PushSubscriptionRecord = {
      id: randomBytes(4).toString("hex"),
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      label: label?.slice(0, 120),
      createdAt: Date.now(),
    };
    this.file.subscriptions.push(record);
    this.persist();
    audit("push.subscribe", { id: record.id });
    return { id: record.id };
  }

  /** Remove one subscription by id (panel "remove device"). */
  unsubscribe(id: string): boolean {
    const next = this.file.subscriptions.filter((s) => s.id !== id);
    if (next.length === this.file.subscriptions.length) return false;
    this.file.subscriptions = next;
    this.persist();
    audit("push.unsubscribe", { id });
    return true;
  }

  /** Remove a subscription by its endpoint (used when the push service rejects it). */
  private removeByEndpoint(endpoint: string): void {
    const next = this.file.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (next.length !== this.file.subscriptions.length) {
      this.file.subscriptions = next;
      this.persist();
    }
  }

  /** Panel-safe snapshot (never includes the VAPID private key). */
  view(): PushView {
    return {
      configured: this.isConfigured(),
      publicKey: this.file.vapidPublicKey,
      subscriptions: this.file.subscriptions
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => ({ id: s.id, label: s.label, createdAt: s.createdAt })),
    };
  }

  /**
   * Fan a notification out to every registered browser subscription. Fire and
   * forget: never throws, and subscriptions the push service reports as gone
   * (HTTP 404/410) are pruned so the store self-heals. A no-op when push isn't
   * configured or there are no subscribers.
   */
  async notify(options: PushOptions): Promise<void> {
    const subs = this.file.subscriptions;
    if (subs.length === 0 || !this.isConfigured()) return;
    const priv = this.privateKey();
    if (!priv) {
      log.warn("Web Push: VAPID private key unavailable, skipping notify");
      return;
    }
    const payload = JSON.stringify({
      title: options.title,
      body: options.body,
      tag: options.tag,
      kind: options.kind,
      url: options.url ?? "/",
    });
    const vapid = {
      subject: "mailto:push@myhq.local",
      publicKey: this.file.vapidPublicKey!,
      privateKey: priv,
    };
    // Snapshot the list so concurrent mutation during the await doesn't skip any.
    await Promise.all(
      subs.slice().map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: s.keys },
            payload,
            { vapidDetails: vapid, TTL: 60 },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Subscription is permanently gone — prune it.
            this.removeByEndpoint(s.endpoint);
            log.info("Web Push: pruned expired subscription", { id: s.id });
          } else {
            log.warn("Web Push: send failed", {
              id: s.id,
              status,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }),
    );
  }

  private persist(): void {
    saveJson<PushFile>(FILE, this.file);
  }
}

export const push = new PushClient();
