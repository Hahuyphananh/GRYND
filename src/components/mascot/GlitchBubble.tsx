"use client";

// src/components/mascot/GlitchBubble.tsx
//
// GLITCH's speech bubble: the one LIGHT surface in GRYND's dark interface.
//
// COLOUR. Ivory card, dark ink — both are tokens (`bg-mascot-bubble` /
// `text-mascot-ink`, declared in the "Mascot (GLITCH)" section of the token
// block in globals.css). No hex is written here, so the pair is defined once
// and can be checked for contrast in one place. It needs no light-mode
// override: light mode lifts the grounds to a deep blue, not to white, so ivory
// with dark ink still clears AA there.
//
// ACCESSIBILITY. The message is the live region — `role="status"` with
// `aria-live="polite"`, so a screen reader announces GLITCH's line when it
// appears and never steals focus. The dismiss control is a real <button> with
// a 44 × 44 px hit area (the visual icon stays small; the padding is what
// makes the target), and the bubble is never a dialog: no focus trap, no
// scroll lock, no aria-modal.

import type { ReactNode } from "react";
import { IconX } from "@tabler/icons-react";

/**
 * Where the pointer sits. `left` = the mascot is to the bubble's left (inline
 * layout); `bottom` = the mascot is underneath it (stacked/floating layout).
 */
export type GlitchBubbleTail = "left" | "right" | "bottom" | "none";

export type GlitchBubbleProps = {
  /** The message. Rendered as the live region. */
  children: ReactNode;
  tail?: GlitchBubbleTail;
  dismissible?: boolean;
  /** Accessible name for the dismiss button. */
  dismissLabel?: string;
  onDismiss?: () => void;
  className?: string;
};

const TAIL_CLASSES: Record<Exclude<GlitchBubbleTail, "none">, string> = {
  // Half of the 10 px square sits outside the bubble, so the pointer reads as
  // part of the card rather than a bead stuck to its edge.
  left: "-left-[5px] top-1/2 -translate-y-1/2",
  right: "-right-[5px] top-1/2 -translate-y-1/2",
  bottom: "-bottom-[5px] left-1/2 -translate-x-1/2",
};

export default function GlitchBubble({
  children,
  tail = "left",
  dismissible = false,
  dismissLabel = "Dismiss",
  onDismiss,
  className = "",
}: GlitchBubbleProps) {
  return (
    <div
      className={`relative rounded-2xl bg-mascot-bubble px-3.5 py-2.5 text-mascot-ink shadow-[0_6px_18px_rgba(3,8,23,0.45)] ${className}`}
    >
      {tail !== "none" && (
        // Decorative: it is the bubble's shape, not information.
        <span
          aria-hidden="true"
          className={`absolute h-2.5 w-2.5 rotate-45 rounded-[2px] bg-mascot-bubble ${TAIL_CLASSES[tail]}`}
        />
      )}

      <div className="flex items-start gap-1">
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          // Wraps instead of overflowing: never wider than the viewport, and
          // long unbroken strings break rather than push the card off-screen.
          className="max-w-[min(76vw,20rem)] break-words text-[13px] font-semibold leading-snug sm:text-sm"
        >
          {children}
        </div>

        {dismissible && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            // 44 × 44 hit area kept compact by the negative margins, so the
            // controls comply without inflating the bubble.
            className="-my-2 -mr-2 -ml-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mascot-ink/55 transition hover:bg-mascot-ink/10 hover:text-mascot-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mascot-ink/60"
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
