"use client";

// src/components/native/NativeBackButton.tsx
//
// Phase 4 — Android hardware back button.
//
// Mounted ONCE in the root layout, next to NativeLifecycleBridge. It is the
// only place that answers the system back button, and the decision itself lives
// in `lib/native/backButton` (so the four outcomes are testable without a
// device).
//
// ── Native only ───────────────────────────────────────────────────────────
//
// The guard is `Capacitor.isNativePlatform()`, and the plugin is imported
// dynamically INSIDE the effect, so a browser downloads nothing, the server
// evaluates nothing, and — the point of this phase — browser Back is untouched:
// this component registers no `popstate`, no `keydown` and no history listener,
// and renders nothing. On the web the History API remains the only back
// behaviour, exactly as before.
//
// ── What counts as "there is somewhere to go back to" ─────────────────────
//
// Not the plugin's `canGoBack`. That is the WebView's history, which is already
// non-empty after a server redirect (apex → www), a Clerk hop or a deep link,
// where `router.back()` would leave GRYND on a page it cannot render or cannot
// return from. Instead this component captures `history.length` at the first
// render of the document and treats only entries ADDED BY THE APP since then as
// navigable. A deep link has a baseline equal to its own entry, so Back there
// minimizes the app instead of walking out of it. `history.pushState` (what
// Next's client router uses) raises the length, `history.back()` lowers it, so
// the check stays correct without a counter to drift.

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import {
  attachAndroidBackButton,
  handleAndroidBack,
} from "../../lib/native/backButton";

/**
 * The topmost open overlay.
 *
 * `[role="dialog"]` is the marker this app already uses for every modal, sheet
 * and overlay — and already treats as "an overlay is open" (see the keno-pvp
 * keyboard claim, which refuses to run while one is present). Node order is DOM
 * order, so the last match is the one painted on top.
 */
function findTopmostOverlay(): Element | null {
  const overlays = document.querySelectorAll('[role="dialog"]');
  return overlays.length ? overlays[overlays.length - 1] : null;
}

/**
 * Close the overlay the way the app already closes it from a keyboard: an
 * `Escape` keydown dispatched at the dialog, bubbling to the document-level
 * handlers of the components that support it (the mobile menu, the rewards
 * board, quest/reward popups, the pro modal, the hex troop popup, the odds
 * wheel, the forfeit confirmation).
 *
 * Synthetic, because the back button is not a key press: `isTrusted` is false
 * and there is no keyboard. Overlays that do not implement Escape simply stay
 * open — the press is consumed, and the player is left exactly where they were
 * rather than being navigated out from under a modal.
 */
function dismissOverlay(overlay: Element): void {
  overlay.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

export default function NativeBackButton() {
  const router = useRouter();

  // `history.length` at the first render of this document. `null` until the
  // effect runs, so nothing is ever compared against an unset baseline.
  const baselineRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !Capacitor.isNativePlatform()) {
      return undefined;
    }

    if (baselineRef.current === null) {
      const length = window.history?.length;
      baselineRef.current = typeof length === "number" ? length : 0;
    }

    let stopped = false;
    let stopWatch: (() => void) | null = null;

    void (async () => {
      try {
        // Both plugins are already registered in the APK; importing them
        // together keeps this the ONLY dynamic import in the component.
        const [{ App }, { Keyboard }] = await Promise.all([
          import("@capacitor/app"),
          import("@capacitor/keyboard"),
        ]);
        if (stopped) return;

        stopWatch = attachAndroidBackButton({
          app: App,
          onBack: () => {
            if (stopped) return;

            void handleAndroidBack({
              // Phase 5B publishes this contract from NativeKeyboard; reading it
              // here keeps ONE source of keyboard state and adds no second
              // keyboard listener.
              isKeyboardOpen: () =>
                document.documentElement.dataset.keyboard === "open",
              hideKeyboard: () => Keyboard.hide(),
              findOverlay: findTopmostOverlay,
              dismissOverlay,
              canGoBack: () => {
                const baseline = baselineRef.current ?? 0;
                const length = window.history?.length ?? 0;
                return length > baseline;
              },
              goBack: () => router.back(),
              minimize: () => App.minimizeApp(),
              onError: () => {
                if (process.env.NODE_ENV !== "production") {
                  // Label only — no URL, token or state is logged.
                  console.warn("[native] back press could not be handled");
                }
              },
            });
          },
        });
      } catch {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[native] back button plugin unavailable");
        }
      }
    })();

    return () => {
      stopped = true;
      stopWatch?.();
      stopWatch = null;
    };
  }, [router]);

  return null;
}
