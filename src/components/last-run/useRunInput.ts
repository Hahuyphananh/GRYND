"use client";

// src/components/last-run/useRunInput.ts
//
// The ONLY input surface for LAST RUN.
//
// Emits a held CONTROL STATE (`{ jump, duck }`) on transitions, never per frame
// and never a position. The page posts each transition; the server stamps the
// tick and replays the engine, so nothing here can influence the outcome.
//
// ── WHAT THIS HOOK GUARANTEES ─────────────────────────────────────────────
//
//   * Space / ArrowUp jump, ArrowDown ducks — only while `enabled`, and only
//     outside text fields (a username box keeps its own Space).
//   * Space and the arrows are preventDefault-ed while the game owns the
//     keyboard, so the page does not scroll mid-jump.
//   * Inputs are released on blur, tab hide, pagehide, pointer cancel and
//     lost pointer capture, so a stuck key can never follow a player into the
//     result screen or a reconnect.
//   * Touch pads use pointer capture + `touch-action: none`: a finger that
//     slides off a button still releases cleanly, and the arena never
//     double-tap-zooms or scrolls under the thumb.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  NEUTRAL_INPUT,
  controlForKey,
  isEditableTarget,
  releasedState,
  setHeld,
  type RunControl,
  type RunInputState,
} from "./inputKeys";

export type { RunControl, RunInputState } from "./inputKeys";

export type ControlHandlers = {
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
  "aria-pressed": boolean;
  style: React.CSSProperties;
};

export type RunInput = {
  /** Programmatic press (used by the pointer handlers below). */
  press: (control: RunControl) => void;
  /** Programmatic release. */
  release: (control: RunControl) => void;
  /** The currently held controls, for pressed/active visuals. */
  held: RunInputState;
  /** Props for a touch control button. */
  controlProps: (control: RunControl) => ControlHandlers;
};

export function useRunInput({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (input: RunInputState) => void;
}): RunInput {
  const heldRef = useRef<RunInputState>({ ...NEUTRAL_INPUT });
  const [held, setHeldState] = useState<RunInputState>({ ...NEUTRAL_INPUT });
  const onChangeRef = useRef(onChange);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const apply = useCallback((control: RunControl, pressed: boolean, notify: boolean) => {
    const result = setHeld(heldRef.current, control, pressed);
    if (!result.changed) return;
    heldRef.current = result.state;
    setHeldState(result.state);
    if (notify) onChangeRef.current(result.state);
  }, []);

  const press = useCallback(
    (control: RunControl) => {
      if (!enabledRef.current) return;
      apply(control, true, true);
    },
    [apply],
  );

  const release = useCallback(
    (control: RunControl) => {
      apply(control, false, true);
    },
    [apply],
  );

  /** Release every held control. `notify` sends one final neutral transition. */
  const releaseAll = useCallback(
    (notify: boolean) => {
      const hadInput = heldRef.current.jump || heldRef.current.duck;
      heldRef.current = releasedState();
      setHeldState(releasedState());
      if (notify && hadInput) onChangeRef.current(releasedState());
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      // Silent reset: disabling input is not a player transition.
      heldRef.current = releasedState();
      setHeldState(releasedState());
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && isEditableTarget(target.tagName, Boolean(target.isContentEditable))) return;

      const control = controlForKey(event.code);
      if (!control) return;

      // The game owns these keys while it is live: no page scroll, no button
      // activation. A repeated keydown is already held, so it is swallowed
      // without emitting again.
      event.preventDefault();
      if (event.repeat) return;
      apply(control, true, true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const control = controlForKey(event.code);
      if (!control) return;
      // preventDefault here too: a key released over a focused button must not
      // fire that button.
      event.preventDefault();
      apply(control, false, true);
    };

    const onBlur = () => releaseAll(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseAll(false);
    };
    const onPageHide = () => releaseAll(false);

    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [apply, enabled, releaseAll]);

  const controlProps = useCallback(
    (control: RunControl): ControlHandlers => ({
      onPointerDown: (event) => {
        event.preventDefault();
        // Capture the pointer: sliding off the button still delivers the up.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Capture is best-effort; pointerup on the element still works.
        }
        press(control);
      },
      onPointerUp: (event) => {
        event.preventDefault();
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        release(control);
      },
      onPointerCancel: () => release(control),
      onPointerLeave: () => {
        // Only relevant without capture (mouse). Releasing here is harmless
        // when the pointer is captured, because leave cannot fire mid-capture.
        release(control);
      },
      onLostPointerCapture: () => release(control),
      onContextMenu: (event) => event.preventDefault(),
      "aria-pressed": held[control],
      // `touch-action: none` stops the arena scrolling/zooming under a thumb;
      // it applies to these buttons only, so the rest of the page still pans.
      style: { touchAction: "none", WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none" },
    }),
    [held, press, release],
  );

  return { press, release, held, controlProps };
}

export default useRunInput;
