/**
 * Drop any cached SPA assets before a reload so the browser refetches the
 * freshly built panel from the server instead of serving a stale bundle. Used
 * after an update/restart, where the panel assets on disk have changed but a
 * plain location.reload() may still hit the HTTP/service-worker cache.
 *
 * Clears the Cache Storage API entries (PWA / service-worker caches), then
 * navigates to the same URL with a cache-busting query param so even a
 * disk-cached index.html is bypassed. Best-effort: always reloads, even if the
 * cache purge fails.
 */
export async function reloadFresh(): Promise<void> {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best effort — reload regardless */
  }
  const url = new URL(location.href);
  url.searchParams.set("_v", String(Date.now()));
  location.replace(url.toString());
}
