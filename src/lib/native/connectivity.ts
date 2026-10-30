// src/lib/native/connectivity.ts
//
// Phase 8 — one place that decides whether GRYND should consider itself online.
//
// GRYND already had a browser signal (`navigator.onLine` + the `online`/`offline`
// events) driving the single global <OfflineBanner>. Phase 3A added a more
// authoritative native signal (`@capacitor/network` via
// `grynd:network-status-change`). This module merges the two so there is still
// exactly ONE banner and ONE decision, instead of a second native offline
// indicator competing with the web one.
//
// Deliberately not a store, a context or a hook: a pure function, so the rules
// are testable without a DOM, a device or a Capacitor runtime.

export type ConnectivitySignals = {
  /**
   * `navigator.onLine` — a HINT, and a stale one on some Android WebViews.
   * `null` means "not known yet" (SSR, tests, a platform without it).
   */
  browserOnline?: boolean | null;
  /**
   * `@capacitor/network` `connected` — the device's network interface, reported
   * by the native bridge. `null` until the first native event arrives, which is
   * always the case in a browser.
   */
  nativeConnected?: boolean | null;
};

/**
 * Resolve the two signals into the single value the banner renders.
 *
 * Rules, in order:
 *  1. A signal that says OFFLINE wins. The banner is an advisory ("your data may
 *     be stale") and never blocks a request, so a false alarm is far cheaper than
 *     silently showing "you're online" while an interface is down.
 *  2. Otherwise the app is online — `true` also covers "no signal has arrived
 *     yet", which keeps the first paint and every browser session exactly as
 *     they behaved before this module existed.
 *
 * Note what this does NOT mean: `true` is not proof that the GRYND server is
 * reachable (hotel Wi-Fi, a captive portal, or nginx returning 502 all report a
 * connected interface). Server reachability stays with the fetch, the Socket.IO
 * connection, and the Capacitor `errorPath` page.
 */
export function resolveOnline(signals: ConnectivitySignals = {}): boolean {
  const { browserOnline = null, nativeConnected = null } = signals;
  if (nativeConnected === false) return false;
  if (browserOnline === false) return false;
  return true;
}
