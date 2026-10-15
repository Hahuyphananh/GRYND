"use client";

// src/components/RouteTransition.jsx
//
// The page wrapper for every route (mounted once, in src/app/providers.tsx).
//
// It is plain CSS on purpose: a page's visibility must never depend on a
// JavaScript animation hand-off. This component used to render
// `<AnimatePresence mode="wait"><motion.div key={pathname} initial={{ opacity: 0 }}
// animate={{ opacity: 1 }} exit={{ opacity: 0 }}>`. `mode="wait"` only mounts
// the incoming page once the outgoing one has finished exiting, and Next's
// navigation — a streamed RSC payload plus a `loading.tsx` fallback, and for
// /casino/* a 308 to the canonical /games/* route — interleaves with that
// hand-off. When it does, the wrapper was left on its `initial` opacity for
// good: Pool Masters, Precision and the Chess "created, waiting for opponent"
// page rendered a complete waiting room in the DOM that painted nothing until
// the player refreshed. See docs/route-transition-blank-page.md.
//
// The keyframe cannot fail that way: `.route-fade-in` (globals.css) has no
// opacity-0 resting state, so an animation that is skipped, cancelled or
// interrupted falls back to the element's natural opacity of 1. The wipe veil
// is the mirror image — `.route-wipe` rests at opacity 0, so it can never
// cover the page either. Reduced-motion is handled by the global
// `prefers-reduced-motion` block, which collapses both to their end state.
//
// Two details are load-bearing:
//   * The veil sits INSIDE the keyed element rather than beside it — two
//     siblings cannot share one `key`, and a veil React reuses instead of
//     remounting never replays its one-shot animation.
//   * `.route-wipe` (the transparent resting state) is unconditional and only
//     the flash is conditional. Dropping the resting class would leave the veil
//     at its natural opacity of 1: an opaque sheet over the page.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

export default function RouteTransition({ children }) {
  // Re-keying on the pathname remounts the wrapper on every navigation, which
  // is what replays both one-shot animations (the keyed motion.div did the
  // same).
  const pathname = usePathname();

  // The transition belongs to navigations, not to the first paint. The old
  // `AnimatePresence initial={false}` skipped the first mount, and that still
  // matters: a hard load — a first visit, or the refresh a player reaches for —
  // must paint its content immediately instead of starting at opacity 0, which
  // also keeps the wrapper off the LCP path.
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  const navigating = !firstMount.current;

  return (
    <div className="relative min-h-screen bg-[#030817]">
      <div key={pathname} className={navigating ? "route-fade-in min-h-screen" : "min-h-screen"}>
        <div
          aria-hidden="true"
          className={`route-wipe pointer-events-none fixed inset-0 z-[60] bg-[#030817]${
            navigating ? " route-wipe-flash" : ""
          }`}
        />
        {children}
      </div>
    </div>
  );
}
