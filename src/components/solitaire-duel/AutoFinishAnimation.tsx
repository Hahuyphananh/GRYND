"use client";

// src/components/solitaire-duel/AutoFinishAnimation.tsx
//
// The cosmetic half of auto-finish: the player's remaining cards fly from where
// they sat to the foundations, one after another, with a lift and a natural
// ease. It is driven by a list of COSMETIC steps the engine already produced
// (`autoFinishPlan`), and it owns no game state at all — the board is already
// complete underneath, the result is already recorded, and `onDone` only
// releases the victory panel. Skipping, finishing, or failing therefore cannot
// change a time, a move count or a result.
//
// TIMING CONTRACT
//   * 2× is the default pace (~3.6s for any board).
//   * 5× plays it at 2.5× the rate (~1.4s).
//   * A hard 5s deadline from mount ALWAYS wins, however late the speed changes.
//   * Reduced motion skips straight to the completed board.
//
// AIM CONTRACT. The finished board is already painted underneath, and it is a
// shorter board than the one the flight was measured on (the tableau collapses),
// which can also move the page. So the flight is never drawn against the frozen
// snapshot: every frame re-reads the board's origin and the four foundations,
// and each card is aimed at the pile exactly as it is on screen now. That is
// what makes the cards land ON the finished pile instead of above it.
//
// THEME CONTRACT. The overlay reads the same active table theme as the board
// (`useSolitaireBoardTheme`), so its panel is a miniature of the felt the player
// just finished on and the controls use that theme's ink. The CARDS are never
// themed — `PlayingCard` owns their palette — because a table theme must not
// restyle a card face.

import { useCallback, useEffect, useRef, useState } from "react";

import PlayingCard from "./PlayingCard";
import {
  flightFrame,
  flightWindows,
  measureBoardOrigin,
  measureFoundationTargets,
  type FinishRect,
  type FlyingCard,
} from "./measureFinishCards";
import { AUTO_FINISH_MAX_MS } from "../../lib/solitaire-duel/autoFinish";
import { SUITS } from "../../lib/solitaire-duel/constants";
import type { Suit } from "../../lib/solitaire-duel/types";
import { useSolitaireBoardTheme } from "../../hooks/useSolitaireBoardTheme";




/** The virtual milliseconds a full journey takes at 2×. */
const BASE_MS = 3_600;
/** Playback rate per speed. 5× is 2.5× the 2× rate, i.e. the brief's 5× feel. */
const RATE: Record<2 | 5, number> = { 2: 1, 5: 2.5 };
/** How long the landed frame is held before the victory panel takes over. */
const SETTLE_MS = 160;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export default function AutoFinishAnimation({
  cards,
  onDone,
}: {
  cards: FlyingCard[];
  onDone: () => void;
}) {
  const { theme } = useSolitaireBoardTheme();
  const [speed, setSpeed] = useState<2 | 5>(2);
  const [progress, setProgress] = useState(0);
  const speedRef = useRef<2 | 5>(2);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  /** The foundations as they are NOW, refreshed with the flight. */
  const targetsRef = useRef<Partial<Record<Suit, FinishRect>>>({});
  /** The board's origin as it is NOW: the frame the whole flight is drawn in. */
  const boardOriginRef = useRef<{ x: number; y: number } | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  }, []);

  /**
   * Re-read the table the overlay is covering.
   *
   * The board underneath has already switched to the FINISHED layout, and that
   * layout can keep moving while the flight is in the air (the page scroll is
   * clamped as the tableau collapses, a phone's viewport settles). Re-reading is
   * what keeps the cards pointed at the pile the player can actually see.
   */
  const syncGeometry = useCallback(() => {
    const live = measureFoundationTargets();
    for (const suit of SUITS) {
      const rect = live[suit];
      if (rect) targetsRef.current[suit] = rect;
    }
    const origin = measureBoardOrigin();
    if (origin) boardOriginRef.current = origin;
  }, []);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || cards.length === 0) {
      setProgress(1);
      finish();
      return undefined;
    }

    const startedAt = performance.now();
    let virtual = 0;
    let last = startedAt;
    let raf = 0;

    const tick = (now: number) => {
      virtual += Math.max(0, now - last) * RATE[speedRef.current];
      last = now;
      const next = clamp01(virtual / BASE_MS);
      syncGeometry();
      setProgress(next);
      if (next >= 1) {
        // Hold the landed frame for a beat so the last card is seen to settle on
        // its pile before the panel takes over — never past the 5s ceiling.
        const budget = Math.max(0, AUTO_FINISH_MAX_MS - (now - startedAt));
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          finish();
        }, Math.min(SETTLE_MS, budget));
        return;
      }
      // The deadline is wall-clock, not virtual: a late switch to 2× can slow
      // the remaining cards but can never push the total past five seconds.
      if (now - startedAt >= AUTO_FINISH_MAX_MS) {
        finish();
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [cards.length, finish, syncGeometry]);

  const chooseSpeed = (next: 2 | 5) => {
    speedRef.current = next;
    setSpeed(next);
  };

  // One queue per foundation: a suit's cards leave in order and land as a
  // single tidy stack, while the four piles fill in parallel.
  const windows = flightWindows(cards);

  return (
    <div
      data-testid="solitaire-auto-finish"
      data-solitaire-theme={theme.key}
      data-speed={speed}
      data-progress={progress.toFixed(2)}
      className="pointer-events-none fixed inset-0 z-[70]"
    >
      {/* The moving cards. Each flies on its own window of the shared timeline —
          one queue per foundation — so they read as individual moves that stack
          onto the right pile without ever adding up past the cap. */}
      <div aria-hidden="true">
        {cards.map((entry, index) => {
          const { start, end } = windows[index];
          const t = end <= start ? 1 : easeInOut(clamp01((progress - start) / (end - start)));
          // The pile as it is on screen right now, and the board's own drift
          // since the flight was measured. The source moves with the board, the
          // destination is the live pile — so the last frame sits exactly on it.
          const to = targetsRef.current[entry.card.suit] ?? entry.to;
          const frame = flightFrame(entry, to, boardOriginRef.current, t);
          const x = frame.x;
          const y = frame.y;
          const width = frame.width;
          const height = frame.height;
          const lift = -Math.sin(Math.PI * t) * 40;
          const scale = 1 + Math.sin(Math.PI * t) * 0.06;
          const settled = t >= 1;
          return (
            <div
              key={`${entry.card.suit}-${entry.card.rank}`}
              className="absolute left-0 top-0 drop-shadow-2xl will-change-transform"
              style={{
                width,
                height,
                transform: `translate3d(${x}px, ${y + lift}px, 0) scale(${scale})`,
                zIndex: Math.round(t * 40),
                opacity: settled ? 1 : 0.98,
              }}
            >
              <PlayingCard card={entry.card} faceUp interactive={false} />
            </div>
          );
        })}
      </div>

      {/* Controls stay clickable while the rest of the board is inert. */}
      <div className="pointer-events-auto fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[71] -translate-x-1/2">
        <div
          role="status"
          aria-live="polite"
          style={{
            // The same felt the finished board is painted with, on the little
            // panel: the finish is part of the table, not a detached dialog.
            backgroundImage: theme.felt,
            backgroundColor: theme.base,
            boxShadow: `inset 0 0 0 1px ${theme.frame}, 0 18px 40px rgba(0, 0, 0, 0.45)`,
          }}
          className="flex items-center gap-2 rounded-2xl px-3 py-2 text-white backdrop-blur-sm"
        >
          <span
            className="px-1 text-[11px] font-bold uppercase tracking-[0.16em]"
            style={{ color: theme.legal.ink }}
          >
            Finishing
          </span>
          <div className="flex items-center gap-1" role="group" aria-label="Animation speed">
            {([2, 5] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => chooseSpeed(option)}
                aria-pressed={speed === option}
                className="rounded-lg px-2.5 py-1 text-xs font-bold transition hover:brightness-125"
                style={
                  speed === option
                    ? { backgroundColor: theme.legal.ink, color: theme.base }
                    : { backgroundColor: theme.slot.activeFill, color: theme.legend }
                }
              >
                {option}×
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={finish}
            className="rounded-lg border px-3 py-1 text-xs font-bold transition hover:brightness-125"
            style={{ borderColor: theme.slot.border, color: theme.legend }}
          >
            Skip animation
          </button>
        </div>
      </div>
    </div>
  );
}
