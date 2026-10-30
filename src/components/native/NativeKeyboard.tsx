"use client";

// src/components/native/NativeKeyboard.tsx
//
// Phase 5B — mounts ONCE in the root layout and publishes the native keyboard's
// state to the document:
//
//   <html data-keyboard="open">      while the IME is up
//   --keyboard-height                the plugin's reported height, in px
//
// ── What this deliberately does NOT do ────────────────────────────────────
//
//   * no `scrollIntoView()` — with the WebView resized by the OS, the browser
//     already keeps the focused field visible; a second scroll engine produces
//     the jumps this phase is meant to remove;
//   * no `.focus()` — never opens the keyboard on load, never steals focus from
//     Speed Typing's textarea or from a dialog's first field;
//   * no layout shift — nothing consumes `--keyboard-height` today. A fixed
//     element that lifted itself by the keyboard height while the viewport is
//     already shorter would be double-shifted, which is why the variable is a
//     contract for later, not a transform now;
//   * no keydown listener of any kind, so keyboard show/hide can never reach a
//     game's controls.
//
// ── Browser behaviour ─────────────────────────────────────────────────────
//
// Guarded by `Capacitor.isNativePlatform()` and imported dynamically inside the
// effect: a browser never loads the plugin, the server never evaluates it, and
// the browser's own keyboard/viewport handling is untouched.

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import {
  KEYBOARD_CLOSED,
  startNativeKeyboardWatch,
  type KeyboardState,
} from "../../lib/native/keyboard";

export default function NativeKeyboard() {
  useEffect(() => {
    if (typeof window === "undefined" || !Capacitor.isNativePlatform()) {
      return undefined;
    }

    const root = document.documentElement;

    const apply = (state: KeyboardState) => {
      if (state.open) {
        root.dataset.keyboard = "open";
        root.style.setProperty("--keyboard-height", `${state.height}px`);
      } else {
        delete root.dataset.keyboard;
        root.style.setProperty("--keyboard-height", `${KEYBOARD_CLOSED.height}px`);
      }
    };

    let stopped = false;
    let stopWatch: (() => void) | null = null;

    void (async () => {
      try {
        const { Keyboard } = await import("@capacitor/keyboard");
        // Unmounted while the plugin chunk was loading: attach nothing.
        if (stopped) return;

        stopWatch = startNativeKeyboardWatch({
          keyboard: Keyboard,
          onState: apply,
          onError: () => {
            if (process.env.NODE_ENV !== "production") {
              // Label only — no input, focus target or keyboard state.
              console.warn("[native] keyboard listener unavailable");
            }
          },
        });
      } catch {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[native] keyboard plugin unavailable");
        }
      }
    })();

    return () => {
      stopped = true;
      stopWatch?.();
      stopWatch = null;
      // Never leave a remount starting from a stale "open" state.
      delete root.dataset.keyboard;
      root.style.setProperty("--keyboard-height", `${KEYBOARD_CLOSED.height}px`);
    };
  }, []);

  return null;
}
