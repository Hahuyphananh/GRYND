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

import { useCallback, useEffect, useRef, useState } from "react";

import PlayingCard from "./PlayingCard";
import { AUTO_FINISH_MAX_MS } from "../../lib/solitaire-duel/autoFinish";
import type { Card } from "../../lib/solitaire-duel/types";

export type FlyingCard = {
  card: Card;
  from: { x: number; y: number; width: number; height: number };
  to: { x: number; y: number; width: number; height: number };
};

/** The virtual milliseconds a full journey takes at 2×. */
const BASE_MS = 3_600;
/** Playback rate per speed. 5× is 2.5× the 2× rate, i.e. the brief's 5× feel. */
const RATE: Record<2 | 5, number> = { 2: 1, 5: 2.5 };
/** Share of the timeline used to stagger the starts. */
const STAGGER = 0.55;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export default function AutoFinishAnimation({
  cards,
  onDone,
}: {
  cards: FlyingCard[];
  onDone: () => void;
}) {
  const [speed, setSpeed] = useState<2 | 5>(2);
  const [progress, setProgress] = useState(0);
  const speedRef = useRef<2 | 5>(2);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
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
      setProgress(next);
      // The deadline is wall-clock, not virtual: a late switch to 2× can slow
      // the remaining cards but can never push the total past five seconds.
      if (next >= 1 || now - startedAt >= AUTO_FINISH_MAX_MS) {
        finish();
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [cards.length, finish]);

  const chooseSpeed = (next: 2 | 5) => {
    speedRef.current = next;
    setSpeed(next);
  };

  const count = Math.max(1, cards.length);

  return (
    <div
      data-testid="solitaire-auto-finish"
      data-speed={speed}
      data-progress={progress.toFixed(2)}
      className="pointer-events-none fixed inset-0 z-[70]"
    >
      {/* The moving cards. Each flies on its own window of the shared timeline,
          so they read as individual moves without ever adding up past the cap. */}
      <div aria-hidden="true">
        {cards.map((entry, index) => {
          const start = (index / count) * STAGGER;
          const end = Math.min(1, start + (1 - STAGGER) + 0.05);
          const t = end <= start ? 1 : easeInOut(clamp01((progress - start) / (end - start)));
          const x = entry.from.x + (entry.to.x - entry.from.x) * t;
          const y = entry.from.y + (entry.to.y - entry.from.y) * t;
          const lift = -Math.sin(Math.PI * t) * 40;
          const scale = 1 + Math.sin(Math.PI * t) * 0.06;
          const settled = t >= 1;
          return (
            <div
              key={`${entry.card.suit}-${entry.card.rank}`}
              className="absolute left-0 top-0 drop-shadow-2xl will-change-transform"
              style={{
                width: entry.from.width,
                height: entry.from.height,
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
          className="flex items-center gap-2 rounded-2xl border border-white/15 bg-slate-950/90 px-3 py-2 text-white shadow-2xl backdrop-blur-sm"
        >
          <span className="px-1 text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-300">
            Finishing
          </span>
          <div className="flex items-center gap-1" role="group" aria-label="Animation speed">
            {([2, 5] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => chooseSpeed(option)}
                aria-pressed={speed === option}
                className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                  speed === option
                    ? "bg-emerald-400 text-slate-950"
                    : "bg-white/10 text-white/70 hover:bg-white/20"
                }`}
              >
                {option}×
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={finish}
            className="rounded-lg border border-white/20 px-3 py-1 text-xs font-bold text-white/85 hover:bg-white/10"
          >
            Skip animation
          </button>
        </div>
      </div>
    </div>
  );
}
