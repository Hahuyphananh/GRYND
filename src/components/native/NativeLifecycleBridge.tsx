"use client";

// src/components/native/NativeLifecycleBridge.tsx
//
// Mounts ONCE, in the root layout, and is the only place that talks to
// `@capacitor/app` and `@capacitor/network`.
//
// It publishes two typed events on `window` (see `src/lib/native/appLifecycle.ts`):
//
//   grynd:app-state-change        { isActive }
//   grynd:network-status-change   { connected, connectionType }
//
// ── Why this is native-only ───────────────────────────────────────────────
//
// The web app already owns tab visibility and connectivity:
//   * `hooks/useVisiblePoll` pauses every game/lobby poll while the tab is
//     hidden and catches up on return;
//   * `components/PresenceHeartbeat` relaxes its cadence when
//     `navigator.onLine` is false;
//   * `components/SWRProvider` revalidates when the browser fires `online`.
//
// Adding a second, Capacitor-shaped signal in a browser would duplicate those
// mechanisms and could fire `isActive` differently from `visibilityState`
// (a background tab is not a background app). So on any non-native platform
// this component does nothing at all, and the existing web behaviour stands.
//
// The plugins are imported dynamically INSIDE the effect: a browser never
// downloads them, and server rendering never evaluates them.

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import {
  emitAppStateChange,
  emitNetworkStatusChange,
  startNativeLifecycleWatch,
} from "../../lib/native/appLifecycle";

export default function NativeLifecycleBridge() {
  useEffect(() => {
    // Both guards matter: `window` is absent during SSR, and `isNativePlatform`
    // keeps ordinary browsers on their existing visibility/online handling.
    if (typeof window === "undefined" || !Capacitor.isNativePlatform()) {
      return undefined;
    }

    let stopped = false;
    let stopWatch: (() => void) | null = null;

    void (async () => {
      try {
        const [{ App }, { Network }] = await Promise.all([
          import("@capacitor/app"),
          import("@capacitor/network"),
        ]);

        // Unmounted while the plugin chunks were loading: attach nothing. (The
        // watch itself also refuses to register listeners once stopped, which
        // covers an unmount that lands mid-initialisation.)
        if (stopped) return;

        stopWatch = startNativeLifecycleWatch({
          app: App,
          network: Network,
          emitAppState: emitAppStateChange,
          emitNetworkStatus: emitNetworkStatusChange,
          onError: () => {
            if (process.env.NODE_ENV !== "production") {
              // Deliberately just a label: no plugin state, credentials or
              // device identifiers are logged.
              console.warn("[native] lifecycle listener unavailable");
            }
          },
        });
      } catch {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[native] lifecycle plugins unavailable");
        }
      }
    })();

    return () => {
      stopped = true;
      stopWatch?.();
      stopWatch = null;
    };
  }, []);

  return null;
}
