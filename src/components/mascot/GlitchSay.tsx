"use client";

// src/components/mascot/GlitchSay.tsx
//
// GLITCH with something to say: the image plus an optional speech bubble, in
// either an inline slot or one of three screen corners.
//
// THIS IS NOT THE GLOBAL MASCOT SYSTEM. There is no provider, no queue, no
// cadence and no cross-app trigger here — that is the next stage. This is the
// presentational composition a screen can place directly, which is also what
// keeps every appearance deliberate: nothing renders unless a component
// explicitly renders it.
//
// MOTION. One short fade-and-rise, gated through the shared
// `withReducedMotion` helper (the same one OfflineBanner and PvpResultScreen
// use), so `prefers-reduced-motion` gets the content in place with no movement.
// There is no idle bob, pulse or loop, and no sound.
//
// INTERACTION. Never a dialog: no focus trap, no scroll lock, no `aria-modal`,
// and focus is never moved. In a corner the wrapper is `pointer-events-none`
// and only the dismiss button is interactive — so the mascot can sit over the
// page without swallowing a tap meant for the board.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { withReducedMotion } from "../../lib/animations";
import Glitch, { type GlitchSizePreset } from "./Glitch";
import GlitchBubble from "./GlitchBubble";
import {
  GLITCH_DEFAULT_EXPRESSION,
  type GlitchExpression,
} from "../../lib/mascot/glitchAssets";

/**
 * `inline` sits in the flow (a tutorial step, a result panel).
 * The corners are `position: fixed`, so they are only for the rare screen that
 * genuinely wants GLITCH floating — the tutorial, not gameplay.
 */
export type GlitchPlacement = "inline" | "bottom-left" | "bottom-right" | "top-left";

export type GlitchSaySize = GlitchSizePreset | number;

/**
 * Reserved for the upcoming provider: a hint (1), a milestone (2), a step in
 * the onboarding flow (3). Recorded on the element now so call sites do not
 * have to change when the provider starts reading it. Nothing in this
 * component schedules or suppresses appearances — that would be the global
 * system, which is explicitly out of scope.
 */
export type GlitchPriority = 0 | 1 | 2 | 3;

export type GlitchSayProps = {
  expression?: GlitchExpression;
  /** The line GLITCH says. Omit for a silent mascot. */
  message?: ReactNode;
  placement?: GlitchPlacement;
  size?: GlitchSaySize;
  /** Show the close control. Defaults to off — most appearances are momentary. */
  dismissible?: boolean;
  /** Hide after this many milliseconds. Omit to stay until the parent unmounts it. */
  autoHideMs?: number | null;
  priority?: GlitchPriority;
  /** Stable id for one event, so the future provider can show it only once. */
  eventId?: string;
  /**
   * Defaults to `true` when there is a message (the bubble already says it) and
   * `false` when GLITCH stands alone with no copy.
   */
  decorative?: boolean;
  /** Called when the player dismisses GLITCH, or when `autoHideMs` elapses. */
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
};

const FIXED_ALIGNMENT: Record<Exclude<GlitchPlacement, "inline">, string> = {
  // Centred children so the bubble's bottom pointer lands on the mascot
  // underneath it, whichever corner the pair is pinned to.
  "bottom-left": "left-3 items-center",
  "bottom-right": "right-3 items-center",
  "top-left": "left-3 items-center",
};

export default function GlitchSay({
  expression = GLITCH_DEFAULT_EXPRESSION,
  message,
  placement = "inline",
  size = "md",
  dismissible = false,
  autoHideMs = null,
  priority = 1,
  eventId,
  decorative,
  onDismiss,
  dismissLabel = "Dismiss",
  className = "",
}: GlitchSayProps) {
  const shouldReduce = useReducedMotion();
  const [visible, setVisible] = useState(true);

  const dismiss = useCallback(() => {
    setVisible(false);
    onDismiss?.();
  }, [onDismiss]);

  // Auto-hide is opt-in and never applied to something the player must read:
  // it is a hint that fades, not a notice that disappears mid-sentence.
  useEffect(() => {
    if (!autoHideMs || autoHideMs <= 0) return;
    const timer = setTimeout(dismiss, autoHideMs);
    return () => clearTimeout(timer);
  }, [autoHideMs, dismiss]);

  const hasMessage = message !== undefined && message !== null && message !== "";
  const isDecorative = decorative ?? hasMessage;
  const isFixed = placement !== "inline";
  // Narrowed explicitly rather than indexing FIXED_ALIGNMENT with the full
  // union: `inline` has no entry, and this makes that visible to the compiler.
  const fixedAlignment = placement === "inline" ? "" : FIXED_ALIGNMENT[placement];

  const wrapperClass = isFixed
    ? `pointer-events-none fixed z-[80] flex flex-col gap-2 ${fixedAlignment} ${className}`
    : `flex items-center gap-3 ${className}`;

  // Clears the fixed navbar (68px + the notch inset) at the top, and the home
  // indicator at the bottom. `--safe-*` are the app's own safe-area variables.
  const wrapperStyle = isFixed
    ? placement === "top-left"
      ? { top: "calc(var(--safe-top, 0px) + 4.75rem)" }
      : { bottom: "calc(var(--safe-bottom, 0px) + 0.75rem)" }
    : undefined;

  const bubble = hasMessage ? (
    // Only the dismiss button needs to be tappable; the rest of the bubble
    // stays click-through so it can never eat a game input.
    <div className={dismissible ? "pointer-events-auto" : undefined}>
      <GlitchBubble
        tail={isFixed ? "bottom" : "left"}
        dismissible={dismissible}
        dismissLabel={dismissLabel}
        onDismiss={dismiss}
      >
        {message}
      </GlitchBubble>
    </div>
  ) : null;

  const mascot = (
    <Glitch expression={expression} size={size} decorative={isDecorative} />
  );

  const motionProps = withReducedMotion(shouldReduce, {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 4 },
    transition: { duration: 0.22, ease: "easeOut" as const },
  });

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="glitch"
          {...motionProps}
          data-glitch-event={eventId}
          data-glitch-priority={priority}
          className={wrapperClass}
          style={wrapperStyle}
        >
          {isFixed ? (
            <>
              {bubble}
              {mascot}
            </>
          ) : (
            <>
              {mascot}
              {bubble}
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
