// src/lib/native/backButton.ts
//
// Phase 4 — Android hardware/system back button.
//
// ── What the plugin actually does ─────────────────────────────────────────
//
// `@capacitor/app` documents it plainly: registering a `backButton` listener
// DISABLES the plugin's default Android behaviour, so from that moment every
// press is ours to answer. `exitApp()`/`minimizeApp()` exist for the case where
// there is nothing left to navigate.
//
// The payload is `{ canGoBack: boolean }` — the WEBVIEW's history, which is not
// the same question as "is there an in-app page to return to". After a server
// redirect (apex → www), a Clerk navigation, or an external hop, `canGoBack`
// can be true while the previous entry is outside GRYND; answering it with
// `router.back()` would leave the player on a dead page. So this module does
// not trust it and uses the caller's `canGoBack` instead, which is derived from
// history the app itself added (see NativeBackButton: `history.length` above
// the value captured at first render).
//
// ── Priority (fixed by the phase contract) ───────────────────────────────
//
//   1. the keyboard is up  → dismiss it (`Keyboard.hide()`). Nothing else:
//                            Android's own contract is that Back hides the
//                            IME first, and a dialog may hold the focused
//                            field, so this outranks even an overlay (5B.1);
//   2. an overlay is open  → dispatch the app's existing Escape dismissal at
//                            the TOPMOST `[role="dialog"]`; never navigate;
//   3. an active match     → NOT handled here; see the note at the bottom;
//   4. there is history    → `router.back()` (the app's own back convention);
//   5. nothing to go back  → `minimizeApp()`, the Android "put the task in the
//                            background" behaviour. Never `exitApp()`: killing
//                            the activity from a game screen is worse than
//                            leaving it in Recents.
//
// Nothing here navigates, closes, joins, leaves a room, emits a socket event or
// touches match state. It only chooses ONE of the four outcomes above.

/** The `remove()` handle Capacitor returns from `addListener`. */
export type BackListenerHandle = {
  remove(): Promise<void> | void;
};

/** The subset of `@capacitor/app` this phase depends on. */
export type BackButtonPlugin = {
  addListener(
    eventName: "backButton",
    listener: (event: { canGoBack: boolean }) => void,
  ): Promise<BackListenerHandle>;
  minimizeApp(): Promise<void>;
};

/** What one back press resulted in. */
export type BackOutcome =
  /** The keyboard was up; it was dismissed and the press was consumed. */
  | "keyboard"
  /** An overlay was open; Escape was dispatched and the press was consumed. */
  | "overlay"
  /** There was an in-app page to return to; `goBack()` was called. */
  | "history"
  /** Nothing to go back to; the app was put in the background. */
  | "minimized"
  /** A press that arrived inside the cooldown window of the previous one. */
  | "ignored"
  /** No DOM (server rendering) — nothing to do. */
  | "unavailable";

export type AndroidBackOptions = {
  /**
   * True while the native keyboard is up. Phase 5B publishes exactly this as
   * `<html data-keyboard="open">`; the caller reads it, so this module never
   * touches the DOM or keeps a second copy of the keyboard state. Optional:
   * without it the keyboard step is simply not taken.
   */
  isKeyboardOpen?(): boolean;
  /** Dismiss the native keyboard (`Keyboard.hide()`). */
  hideKeyboard?(): Promise<void> | void;
  /** Topmost open overlay (`[role="dialog"]`), or null when none is open. */
  findOverlay(): Element | null;
  /** Deliver the app's Escape dismissal to that overlay. */
  dismissOverlay(overlay: Element): void;
  /** True when THIS document added a history entry the app can return to. */
  canGoBack(): boolean;
  /** The app's established back navigation (`router.back()`). */
  goBack(): void;
  /** Android: move the task to the background (`App.minimizeApp()`). */
  minimize(): Promise<void>;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
  /**
   * Minimum gap between two handled presses. Android can deliver repeated
   * key events while the button is held, and `router.back()` is asynchronous,
   * so without this gate a burst would queue several pops and could skip past
   * the first in-app page into a blank document.
   */
  cooldownMs?: number;
  /** Diagnostics. Receives the error only — never tokens or state. */
  onError?: (error: unknown) => void;
};

export const BACK_COOLDOWN_MS = 400;

/**
 * Resolve one back press. Synchronous by design: the answer must be decided
 * before the WebView can deliver the next event.
 */
export function handleAndroidBack(options: AndroidBackOptions): BackOutcome {
  const {
    isKeyboardOpen,
    hideKeyboard,
    findOverlay,
    dismissOverlay,
    canGoBack,
    goBack,
    minimize,
    now = Date.now,
    cooldownMs = BACK_COOLDOWN_MS,
    onError,
  } = options;

  if (typeof window === "undefined" || typeof document === "undefined") {
    return "unavailable";
  }

  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A broken diagnostic must never break Back.
    }
  };

  // 1 — The keyboard: hide it and consume the press. This branch never
  //     navigates, never minimizes and never closes a dialog — a dialog is
  //     exactly where a focused text field lives.
  //
  //     It is evaluated BEFORE the navigation cooldown, and keeps its own
  //     dedupe stamp, for two reasons: a press spent hiding the keyboard must
  //     not swallow the next, legitimate press, and a held button must not
  //     call `hide()` repeatedly.
  let keyboardOpen = false;
  try {
    keyboardOpen = isKeyboardOpen?.() === true;
  } catch (error) {
    report(error);
  }

  if (keyboardOpen) {
    const lastHideAt =
      observed.lastKeyboardHideAt ?? Number.NEGATIVE_INFINITY;
    if (now() - lastHideAt < cooldownMs) return "keyboard";
    observed.lastKeyboardHideAt = now();

    try {
      const hidden = hideKeyboard?.();
      // A rejected hide is reported and NOT escalated: a failed dismissal must
      // leave the player where they are, never navigate them away.
      if (hidden && typeof (hidden as Promise<void>).catch === "function") {
        (hidden as Promise<void>).catch(report);
      }
    } catch (error) {
      report(error);
    }
    return "keyboard";
  }

  const lastHandledAt =
    observed.lastHandledAt ?? Number.NEGATIVE_INFINITY;
  if (now() - lastHandledAt < cooldownMs) {
    return "ignored";
  }

  // 2 — An overlay: close it with its own mechanism and stay put. This is
  //     deliberately unconditional once a dialog is on screen: navigating away
  //     underneath a modal (a resign confirmation, a result screen, a paused
  //     practice match) is exactly the accident Back must not cause.
  let overlay: Element | null = null;
  try {
    overlay = findOverlay();
  } catch (error) {
    report(error);
  }

  if (overlay) {
    observed.lastHandledAt = now();
    try {
      dismissOverlay(overlay);
    } catch (error) {
      report(error);
    }
    return "overlay";
  }

  // 3 — Active-match protection: see the note at the bottom of this file.
  //     There is intentionally no branch here.

  // 4 — A page of this app precedes the current one.
  let hasHistory = false;
  try {
    hasHistory = canGoBack() === true;
  } catch (error) {
    report(error);
  }

  if (hasHistory) {
    observed.lastHandledAt = now();
    try {
      goBack();
    } catch (error) {
      report(error);
    }
    return "history";
  }

  // 5 — Nothing left: hand the press to Android rather than to an arbitrary
  //     route. A failed minimize is reported, never escalated to exitApp().
  observed.lastHandledAt = now();
  void Promise.resolve()
    .then(minimize)
    .catch(report);
  return "minimized";
}

/**
 * Last-handled stamp shared by every press in this document.
 *
 * Module scope, not component scope: a Strict Mode remount (or the listener
 * being re-attached) must not reset the gate, or two mounts would each let the
 * first press through.
 */
const observed: {
  lastHandledAt: number | null;
  /** Separate stamp: hiding the keyboard must not consume a navigation press. */
  lastKeyboardHideAt: number | null;
} = { lastHandledAt: null, lastKeyboardHideAt: null };

/** Test seam: forget both cooldown stamps. */
export function resetBackCooldown(): void {
  observed.lastHandledAt = null;
  observed.lastKeyboardHideAt = null;
}

export type AttachAndroidBackOptions = {
  app: BackButtonPlugin;
  /** Called for every press, with the plugin's `canGoBack` (ignored by us). */
  onBack(event: { canGoBack: boolean }): void;
  onError?: (error: unknown) => void;
};

/**
 * Attach the hardware-back listener ONCE and return a `stop()` that detaches
 * it.
 *
 * Same rules as the Phase 3A lifecycle watch:
 *  - only one native listener is ever registered, whatever the caller does;
 *  - a `stop()` that lands while `addListener` is still resolving removes the
 *    handle as soon as it arrives, so unmounting mid-registration cannot leak;
 *  - after `stop()` no press is forwarded;
 *  - `stop()` is idempotent, and a second `start` after `stop` is a no-op
 *    (each mount owns its own attachment).
 */
export function attachAndroidBackButton(
  options: AttachAndroidBackOptions,
): () => void {
  const { app, onBack, onError } = options;

  let stopped = false;
  let handle: BackListenerHandle | null = null;

  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // Ignore a broken diagnostic.
    }
  };

  void (async () => {
    try {
      const attached = await app.addListener("backButton", (event) => {
        if (stopped) return;
        try {
          onBack({ canGoBack: event?.canGoBack === true });
        } catch (error) {
          report(error);
        }
      });

      if (stopped) {
        // Unmounted while the plugin was answering: detach immediately.
        try {
          void attached?.remove();
        } catch {
          // Already gone.
        }
        return;
      }

      handle = attached ?? null;
    } catch (error) {
      report(error);
    }
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    const attached = handle;
    handle = null;
    if (!attached) return;
    try {
      void attached.remove();
    } catch {
      // Already gone.
    }
  };
}

// ── Active-match protection (requirement 2) — not implemented ─────────────
//
// This repository has no global signal for "a PvP match is live": each game
// page owns its own match state (`match.status`, `match.winner`, its own poll
// and socket room) and nothing publishes it app-wide. The only global signals
// are the URL segment (`/casino/<game>/[matchId]`), which the phase contract
// forbids treating as proof of an active match — a finished match, a waiting
// room and a result screen all keep it — and `lib/matchNavigation`'s
// `isMatchHref`, which classifies ROUTES, not match state.
//
// Intercepting Back on a route guess would block a player from leaving a
// finished match, and an opt-in registry that no page registers would be an
// invented API with no caller. Both are worse than not answering step 2, so
// this module deliberately has no branch for it: with no overlay, Back performs
// normal in-app navigation, and the games keep their existing leave/forfeit
// contracts (`beforeunload`/`pagehide` cleanup, their own resign confirmation).
// See the Phase 4 report for what a per-game registration would take.
