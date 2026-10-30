"use client";

// src/components/native/NativeSystemBars.tsx
//
// Phase 5A — native status-bar appearance.
//
// Mounted ONCE in the root layout, beside the other render-nothing native
// components. Native-only: on the web it does nothing at all, so browser chrome
// keeps whatever colour and contrast it already had.
//
// ── What Android 15+ means for this file ──────────────────────────────────
//
// GRYND targets SDK 36, and from API 35 Android draws every app edge-to-edge
// whether it asks for it or not. Consequences that shaped this:
//
//   * the status bar sits OVER the WebView, so the app paints the colour
//     behind it. `setBackgroundColor` is a no-op on 15+ (the plugin says so
//     outright) and is therefore only a best-effort for Android 7–14, where
//     the bar is still opaque and would otherwise flash light on launch;
//   * the thing that still matters everywhere is the ICON STYLE. `Style.Dark`
//     in Capacitor means "light text for a dark background", which is what a
//     device in light mode would otherwise NOT pick — leaving dark icons on
//     GRYND's near-black header, i.e. invisible.
//
// It is re-applied on every resume because an activity returning from the
// background can re-derive the bar from the system appearance. The resume
// signal is the Phase 3A event (`grynd:app-state-change`), not a second
// plugin listener — one owner per native event.

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { subscribeToAppStateChange } from "../../lib/native/appLifecycle";

/**
 * GRYND's page background (`body` / the navigation bar's own tint). Used only
 * where the platform still honours a status-bar colour.
 */
const STATUS_BAR_BACKGROUND = "#030817";

export default function NativeSystemBars() {
  useEffect(() => {
    // `window` is absent during SSR; `isNativePlatform` keeps browsers — and
    // therefore the browser's own status-bar / theme-colour behaviour — out of
    // this entirely.
    if (typeof window === "undefined" || !Capacitor.isNativePlatform()) {
      return undefined;
    }

    let stopped = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      try {
        const { StatusBar, Style } = await import("@capacitor/status-bar");
        if (stopped) return;

        const apply = async () => {
          if (stopped) return;
          try {
            // Light icons on the dark app chrome. Supported on every Android
            // version this app ships to.
            await StatusBar.setStyle({ style: Style.Dark });
          } catch {
            // A bar that cannot be restyled is not worth failing over.
          }
          try {
            // Honoured on Android 7–14; a documented no-op on 15+, where the
            // app's own background is what shows through.
            await StatusBar.setBackgroundColor({ color: STATUS_BAR_BACKGROUND });
          } catch {
            // Same.
          }
        };

        await apply();
        if (stopped) return;

        unsubscribe = subscribeToAppStateChange(({ isActive }) => {
          if (isActive) void apply();
        });
      } catch {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[native] status bar plugin unavailable");
        }
      }
    })();

    return () => {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
    };
  }, []);

  return null;
}
