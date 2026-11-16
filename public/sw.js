/*
 * Self-destructing service worker.
 *
 * next-pwa used to write this file with a precache of the build's chunks, but
 * it is a webpack-only plugin and the app now builds with Turbopack, so the
 * file sat frozen at an old build: hundreds of `/_next/static/...` URLs that
 * no longer exist. A browser that still has it installed keeps serving those
 * dead chunks — and the stale page code that came with them, which is how a
 * removed symbol such as `selectTab` kept throwing long after it was fixed.
 *
 * This replacement clears every cache and unregisters itself on activation, so
 * a returning browser drops the old precache the first time it checks for an
 * update. Nothing registers a service worker any more (the current build emits
 * no registration), so no new client installs this.
 *
 * It stays in place until installed clients have had time to take the update.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();

      // Take control away immediately: reload the windows this worker was
      // serving so they load from the network rather than a dead cache.
      const windows = await self.clients.matchAll({ type: "window" });
      for (const windowClient of windows) {
        windowClient.navigate(windowClient.url);
      }
    })(),
  );
});
