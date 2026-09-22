"use client";

import { useEffect, useState } from "react";

/**
 * Dispatched on `window` every time the device comes back online. Screens
 * that don't go through SWR (which has its own `revalidateOnReconnect`) can
 * listen for this to re-run their loader automatically.
 */
export const RECONNECT_EVENT = "grynd:reconnected";

/**
 * Tracks the browser's connectivity state.
 *
 * `online` mirrors `navigator.onLine`, which is only a hint (a captive portal
 * still reports online) — so this is used to pick the right *message*, never
 * to block a request. The real signal is the fetch itself failing; screens
 * combine both via `<AsyncState>`.
 *
 * `reconnectAt` bumps every time the connection comes back, so a screen can
 * keep it in an effect dependency array and retry automatically.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState(true);
  const [reconnectAt, setReconnectAt] = useState(0);

  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setOnline(false);
    }

    const handleOnline = () => {
      setOnline(true);
      setReconnectAt(Date.now());
      try {
        window.dispatchEvent(new Event(RECONNECT_EVENT));
      } catch {
        // Non-browser environment — nothing to notify.
      }
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
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
