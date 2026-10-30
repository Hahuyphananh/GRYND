"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeToNetworkStatusChange } from "../lib/native/appLifecycle";
import { resolveOnline } from "../lib/native/connectivity";

/**
 * Dispatched on `window` every time the device comes back online. Screens
 * that don't go through SWR (which has its own `revalidateOnReconnect`) can
 * listen for this to re-run their loader automatically.
 */
export const RECONNECT_EVENT = "grynd:reconnected";

/**
 * Tracks the browser's connectivity state.
 *
 * `online` mirrors `navigator.onLine` — plus, on the native app, the much more
 * reliable `@capacitor/network` status published by NativeLifecycleBridge. The
 * two are merged by `resolveOnline` so the whole app still has exactly ONE
 * connectivity signal and ONE banner. It remains only a hint (a captive portal
 * still reports online) — so this is used to pick the right *message*, never
 * to block a request. The real signal is the fetch itself failing; screens
 * combine both via `<AsyncState>`.
 *
 * `reconnectAt` bumps every time the connection comes back, so a screen can
 * keep it in an effect dependency array and retry automatically.
 *
 * Nothing here reloads the page or replays an action: coming back online
 * revalidates and dispatches RECONNECT_EVENT, which is the pre-existing
 * contract. In particular a foreground/network restoration must not reload a
 * live match (Phase 8) — the socket recovery in Phase 3B owns reconnection.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState(true);
  const [reconnectAt, setReconnectAt] = useState(0);
  const onlineRef = useRef(true);

  useEffect(() => {
    // Both signals are kept in a closure object rather than state: they change
    // together and only the RESOLVED value is rendered.
    const signals: {
      browserOnline: boolean | null;
      nativeConnected: boolean | null;
    } = {
      browserOnline:
        typeof navigator === "undefined" ? null : navigator.onLine !== false,
      nativeConnected: null,
    };

    const apply = () => {
      const next = resolveOnline(signals);
      if (next === onlineRef.current) return;
      onlineRef.current = next;
      setOnline(next);
      if (!next) return;

      setReconnectAt(Date.now());
      try {
        window.dispatchEvent(new Event(RECONNECT_EVENT));
      } catch {
        // Non-browser environment — nothing to notify.
      }
    };

    // Initial read, so an app that boots without a network shows the banner
    // immediately instead of after the first transition.
    apply();

    const handleOnline = () => {
      signals.browserOnline = true;
      apply();
    };
    const handleOffline = () => {
      signals.browserOnline = false;
      apply();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Native signal (Capacitor only — the event never fires in a browser, so
    // browser behaviour is exactly what it was). This is the Phase 3A contract,
    // not a second plugin listener.
    const unsubscribeNative = subscribeToNetworkStatusChange(
      ({ connected }) => {
        signals.nativeConnected = connected;
        apply();
      },
    );

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      unsubscribeNative();
    };
  }, []);

  return { online, reconnectAt };
}

/**
 * True when a thrown error looks like a connectivity problem rather than a
 * server response. Screens use this to choose between the offline copy (with
 * cached content) and the generic error copy (with retry).
 */
export function isOfflineError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : String((error as any)?.message ?? error);
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet_disconnected|err_network/i.test(
    message,
  );
}
