"use client";

// src/components/UiSounds.tsx
//
// One global listener layer for interface sounds. It renders nothing.
//
// ── Event-driven only ───────────────────────────────────────────────────────
//
// Nothing plays on mount, on navigation, or on scroll. A click is scored when
// the browser reports a real activation, and the hover tick is armed only after
// the first pointer press, so a page can never greet a visitor with sound.
//
// ── Opt-in hover ────────────────────────────────────────────────────────────
//
// "Main buttons only" is enforced with `[data-sound-hover]`: the shared primary
// Button and the PRO CTA carry it, ordinary nav links do not. Hover is skipped
// for touch input and rate-limited in lib/uiSounds.
//
// ── Toggles get their own sound ─────────────────────────────────────────────
//
// Checkboxes, switches and `aria-pressed` controls play the on/off pair instead
// of the plain click. The state is read on the next animation frame so React
// has committed the new `aria-pressed`/`aria-checked` value.
//
// The existing SoundToggle writes `grynd_audio_muted`; because every helper
// goes through the shared context, muting here silences UI and game audio
// together. `data-sound="off"` opts an individual control out entirely.

import { useEffect } from "react";
import { playUiClick, playUiHover, playUiToggle } from "../lib/uiSounds";

const INTERACTIVE =
  'button, a[href], [role="button"], [role="menuitem"], [role="switch"], input[type="checkbox"], summary';
const TOGGLE = 'input[type="checkbox"], [role="switch"], [aria-pressed]';
const OPT_OUT = '[data-sound="off"], [aria-disabled="true"], [disabled]';
const HOVER = "[data-sound-hover]";

function readToggleState(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "checkbox") return el.checked;
  const pressed = el.getAttribute("aria-pressed");
  if (pressed !== null) return pressed === "true";
  return el.getAttribute("aria-checked") === "true";
}

export default function UiSounds() {
  useEffect(() => {
    // Hover stays silent until the visitor has pressed something. Browsers do
    // not treat a hover as an activation gesture, so creating an AudioContext
    // from one would only produce a suspended, silent context anyway.
    let armed = false;

    const onPointerDown = () => {
      armed = true;
    };

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      const el = target.closest(INTERACTIVE);
      if (!el || el.closest(OPT_OUT)) return;

      const toggle = el.closest(TOGGLE);
      if (toggle) {
        // Read after React has written the new state to the DOM.
        requestAnimationFrame(() => playUiToggle(readToggleState(toggle)));
        return;
      }

      playUiClick();
    };

    const onPointerOver = (event: PointerEvent) => {
      if (!armed || event.pointerType !== "mouse") return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      const el = target.closest(HOVER);
      if (!el || el.closest(OPT_OUT)) return;

      // Moving between children of the same button is not a new hover.
      const related = event.relatedTarget;
      if (related instanceof Node && el.contains(related)) return;

      playUiHover();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick);
    document.addEventListener("pointerover", onPointerOver);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick);
      document.removeEventListener("pointerover", onPointerOver);
    };
  }, []);

  return null;
}
