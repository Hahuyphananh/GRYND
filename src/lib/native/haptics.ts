// src/lib/native/haptics.ts
//
// Phase 6 — restrained haptic feedback for the native Android app.
//
// ── The rules this module exists to enforce ───────────────────────────────
//
// Haptics are a CONFIRMATION channel, not a gameplay channel. They are fired
// only from discrete, user-initiated moments (a toast that reports a completed
// action, a menu toggle) and never from anything continuous, timed or
// server-driven — no frame loops, no timers, no keystrokes, no socket events,
// no reconnect attempts, no matchmaking updates, no bet/move feedback. Nothing
// here reads or reports game state, so it can never leak timing information
// into a competitive match.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
//   * SSR-safe: the module has NO top-level imports. Both Capacitor packages
//     are imported lazily, after a `typeof window` guard, so rendering this on
//     the server evaluates nothing from them.
//   * Browser-safe: `Capacitor.isNativePlatform()` must be true before the
//     Haptics plugin is even loaded, so a web session never downloads it.
//   * Failure-proof: every entry point resolves to a boolean and NEVER
//     rejects. A platform without a vibrator, a denied permission or a missing
//     plugin must not break the interaction that asked for feedback.
//
// ── The API surface ───────────────────────────────────────────────────────
//
// Three categories, mapped onto real plugin methods (nothing invented):
//
//   "selection" → Haptics.selectionChanged()             (light tick)
//   "success"   → Haptics.notification({ type: Success })
//   "warning"   → Haptics.notification({ type: Warning })
//
// `Haptics.vibrate()` is deliberately unused: it is a raw buzz with no
// semantic meaning, which is exactly the kind of feedback that trains people to
// ignore haptics.

/** The feedback categories call sites may ask for. */
export type HapticFeedback = "selection" | "success" | "warning";

/** The subset of `@capacitor/haptics` this module uses. */
type HapticsPlugin = {
  selectionChanged(): Promise<void>;
  notification(options: { type: string }): Promise<void>;
};

/** The module shape `import("@capacitor/haptics")` resolves to. */
export type HapticsSdk = {
  Haptics: HapticsPlugin;
  NotificationType: { Success: string; Warning: string };
};

/**
 * Perform one category's feedback against an already-loaded plugin.
 *
 * Exported so the mapping (and the containment around it) is testable without a
 * DOM, a device or a Capacitor runtime. It THROWS on plugin failure; use
 * `safeHaptic` or `hapticFeedback` from application code.
 */
export async function applyHaptic(
  kind: HapticFeedback,
  sdk: HapticsSdk,
): Promise<void> {
  if (kind === "selection") {
    await sdk.Haptics.selectionChanged();
    return;
  }
  if (kind === "success") {
    await sdk.Haptics.notification({ type: sdk.NotificationType.Success });
    return;
  }
  if (kind === "warning") {
    await sdk.Haptics.notification({ type: sdk.NotificationType.Warning });
  }
  // An unknown category is a programming error, not feedback: do nothing.
}

/**
 * `applyHaptic` with failure contained. Resolves `true` when the feedback was
 * delivered, `false` for any failure — it never rejects.
 */
export async function safeHaptic(
  kind: HapticFeedback,
  sdk: HapticsSdk,
): Promise<boolean> {
  try {
    await applyHaptic(kind, sdk);
    return true;
  } catch {
    // A device without a vibrator, a denied permission or a broken bridge.
    return false;
  }
}

/**
 * Ask the native app for one piece of feedback.
 *
 * Order matters: the `window` guard keeps server rendering free of any
 * Capacitor work, and `isNativePlatform()` runs BEFORE the Haptics plugin is
 * imported, so a browser never loads it at all.
 */
export async function hapticFeedback(kind: HapticFeedback): Promise<boolean> {
  if (typeof window === "undefined") return false;

  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return false;

    const sdk = (await import("@capacitor/haptics")) as unknown as HapticsSdk;
    return await safeHaptic(kind, sdk);
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget form for UI call sites, so no event handler has to await a
 * vibration (or handle a promise that can never reject meaningfully).
 */
export function triggerHaptic(kind: HapticFeedback): void {
  void hapticFeedback(kind);
}
