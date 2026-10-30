// src/lib/native/keyboard.ts
//
// Phase 5B — what GRYND does with the native keyboard's lifecycle events.
//
// Short answer: it OBSERVES them. It does not resize, scroll, focus or lift
// anything, because the WebView is already resized for us (see the Android
// manifest's `windowSoftInputMode="adjustResize"` and the Keyboard plugin's
// `resizeOnFullScreen` workaround in capacitor.config.ts). Shifting a fixed
// element by `--keyboard-height` on top of a viewport the OS already shrank
// would double the offset and push chat composers and game controls off screen
// — the exact bug this phase is meant to avoid.
//
// So this module produces one small, typed state and nothing else:
//
//   { open: boolean, height: number }
//
// The component that binds it mirrors it onto `<html data-keyboard>` and
// `--keyboard-height`, which is the reusable contract a fixed element can opt
// into LATER (only if the platform ever stops resizing for us). Nothing in the
// app reads it today.
//
// It emits no gameplay event, listens to no keystroke, calls no `.focus()` and
// performs no scrolling — all of which are asserted in the tests, because the
// dangerous version of this file is the one that touches the DOM's focus.

/** The `remove()` handle Capacitor returns from `addListener`. */
export type KeyboardListenerHandle = {
  remove(): Promise<void> | void;
};

/** The four lifecycle events this phase consumes (Android fires Will/Did nearly together). */
export const KEYBOARD_EVENTS = [
  "keyboardWillShow",
  "keyboardDidShow",
  "keyboardWillHide",
  "keyboardDidHide",
] as const;

export type KeyboardEventName = (typeof KEYBOARD_EVENTS)[number];

/** The subset of `@capacitor/keyboard` this phase depends on. */
export type KeyboardPluginLike = {
  addListener(
    eventName: KeyboardEventName,
    listener: (info?: { keyboardHeight?: number }) => void,
  ): Promise<KeyboardListenerHandle>;
};

/** Observed keyboard state. `height` is the plugin's report, in CSS pixels. */
export type KeyboardState = {
  open: boolean;
  height: number;
};

export const KEYBOARD_CLOSED: KeyboardState = { open: false, height: 0 };

/**
 * Coerce a plugin-reported height.
 *
 * The value crosses the native bridge, so it is treated as untrusted: anything
 * that is not a finite, non-negative number becomes 0, which makes the state
 * "open but not measurable" rather than NaN in a CSS string.
 */
export function normalizeKeyboardHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

export type NativeKeyboardWatchOptions = {
  keyboard: KeyboardPluginLike;
  /** Called once per REAL transition — never twice for the same state. */
  onState: (state: KeyboardState) => void;
  /** Optional diagnostics. Receives the error only — never input or state. */
  onError?: (error: unknown) => void;
};

/**
 * Attach the keyboard listeners and return a `stop()` that detaches them.
 *
 * Guarantees (the same rules as the Phase 3A lifecycle watch):
 *  - every listener is registered at most once per watch;
 *  - `stop()` detaches each handle it is given, is idempotent, and a handle
 *    that resolves AFTER `stop()` is removed immediately (the unmount race);
 *  - no state is published after `stop()`;
 *  - `keyboardWillShow` and `keyboardDidShow` (which Android fires almost
 *    together) collapse into ONE state, because identical states are dropped;
 *  - `keyboardWillHide` and `keyboardDidHide` collapse the same way;
 *  - a broken `onState`/`onError` cannot break the other listeners.
 */
export function startNativeKeyboardWatch(
  options: NativeKeyboardWatchOptions,
): () => void {
  const { keyboard, onState, onError } = options;

  let stopped = false;
  let current: KeyboardState = KEYBOARD_CLOSED;
  const handles: KeyboardListenerHandle[] = [];

  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A broken diagnostic must never break the watch.
    }
  };

  const publish = (next: KeyboardState) => {
    if (stopped) return;
    // Dedupe: Android's Will*/Did* pairs carry the same information.
    if (next.open === current.open && next.height === current.height) return;
    current = next;
    try {
      onState(next);
    } catch (error) {
      report(error);
    }
  };

  const track = (handle: KeyboardListenerHandle | null | undefined) => {
    if (!handle) return;
    if (stopped) {
      try {
        void handle.remove();
      } catch {
        // Already detached.
      }
      return;
    }
    handles.push(handle);
  };

  const attach = async (
    eventName: KeyboardEventName,
    listener: (info?: { keyboardHeight?: number }) => void,
  ) => {
    if (stopped) return;
    try {
      const handle = await keyboard.addListener(eventName, listener);
      track(handle);
    } catch (error) {
      report(error);
    }
  };

  const onShow = (info?: { keyboardHeight?: number }) => {
    publish({ open: true, height: normalizeKeyboardHeight(info?.keyboardHeight) });
  };
  const onHide = () => {
    publish(KEYBOARD_CLOSED);
  };

  // Deliberately sequential so a `stop()` between registrations cannot leak a
  // half-attached watch.
  void (async () => {
    await attach("keyboardWillShow", onShow);
    await attach("keyboardDidShow", onShow);
    await attach("keyboardWillHide", onHide);
    await attach("keyboardDidHide", onHide);
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    for (const handle of handles.splice(0)) {
      try {
        void handle.remove();
      } catch {
        // Already detached.
      }
    }
  };
}
