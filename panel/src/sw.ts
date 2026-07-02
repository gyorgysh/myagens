/// <reference lib="webworker" />
// Custom service worker for the MyAgens panel PWA.
//
// vite-plugin-pwa runs in `injectManifest` mode against this file: it injects
// the precache manifest at `self.__WB_MANIFEST` and bundles it to the final
// `sw.js`. On top of the standard offline app-shell caching (via workbox) we add
// Web Push handlers so heartbeat alerts, task outcomes, and approval requests
// reach the device as OS-level notifications when the tab is closed.

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst, CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// --- Precache + runtime caching (mirrors the previous generateSW config) ---

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation falls back to the cached shell, but never the API or WS.
const handler = new NetworkFirst({ cacheName: "pages" });
registerRoute(
  new NavigationRoute(handler, {
    denylist: [/^\/api/, /^\/ws/],
  }),
);

// Responses that carry plaintext secrets must NEVER be written to the disk-backed
// Cache Storage: a cached entry outlives the panel token (clearToken can't reach
// what it doesn't know about) and is readable via DevTools. These paths fall
// through to a plain (uncached) network fetch below.
const SENSITIVE_API = /\/(reveal|password|secret|export|backup)(\/|$)/i;

// API: network-first so data stays fresh, cached fallback only when offline.
registerRoute(
  ({ url }) => url.pathname.startsWith("/api") && !SENSITIVE_API.test(url.pathname),
  new NetworkFirst({
    cacheName: "api-cache",
    networkTimeoutSeconds: 10,
    plugins: [
      new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// Static assets: cache-first.
registerRoute(
  ({ url, request }) =>
    !url.pathname.startsWith("/api") &&
    !url.pathname.startsWith("/ws") &&
    request.method === "GET",
  new CacheFirst({
    cacheName: "static-cache",
    plugins: [
      new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 60 * 60 * 24 * 30 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// autoUpdate: take over as soon as the new SW is installed/activated.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// --- Web Push ---

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  kind?: string;
  url?: string;
}

self.addEventListener("push", (event: PushEvent) => {
  let data: PushPayload = {};
  try {
    data = event.data ? (event.data.json() as PushPayload) : {};
  } catch {
    // Some push services send no/invalid JSON; fall back to plain text.
    data = { body: event.data?.text() };
  }
  const title = data.title || "MyAgens";
  // `renotify` is a real Notification option (re-alert on a same-tag notification)
  // but is missing from the DOM lib types in use, so widen the type locally.
  const options: NotificationOptions & { renotify?: boolean } = {
    body: data.body || "",
    tag: data.tag,
    renotify: Boolean(data.tag),
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    data: { url: data.url || "/", kind: data.kind },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a notification focuses an existing panel tab (navigating it to the
// deep-link) or opens a new one.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const target = (event.notification.data?.url as string) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        // Reuse any open panel window.
        if ("focus" in client) {
          try {
            await (client as WindowClient).navigate(new URL(target, self.location.origin).href);
          } catch {
            /* cross-origin or detached — fall through to focus */
          }
          return (client as WindowClient).focus();
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(target);
      }
    })(),
  );
});

export {};
