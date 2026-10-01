"use client";

// src/components/sudoku-duel/SudokuNumberPad.tsx
//
// The 1..9 keypad for Sudoku Duel.
//
// There is deliberately NO Submit button: a number is the move. Tapping a key
// sends `{ kind: "place", index, value }` for the selected cell straight to the
// server, and this component waits for the authoritative answer before the board
// changes. Nothing here decides whether the value was right.
//
// The small counter under each key is the number of that digit STILL MISSING
// from the viewer's own visible board (9 minus what is already placed). It is
// derived from the givens and the viewer's own verified entries only — never from
// the solution — so it cannot shortcut the puzzle.

import { VALUES } from "../../lib/sudoku-duel/constants";

export type SudokuNumberPadProps = {
  onValue: (value: number) => void;
  onErase: () => void;
  /** True only while the server is accepting this seat's actions. */
  disabled?: boolean;
  /** An erase is legal for the selected cell (non-clue, non-empty). */
  canErase?: boolean;
  /** How many of each digit are already visible on the viewer's board. */
  placed?: Record<number, number> | null;
  /** Shown under the pad when nothing is selected. */
  hint?: string | null;
};

export default function SudokuNumberPad({
  onValue,
  onErase,
  disabled = false,
  canErase = false,
  placed = null,
  hint = null,
}: SudokuNumberPadProps) {
  return (
    <div
      data-testid="sudoku-number-pad"
      data-disabled={disabled ? "true" : "false"}
      className="rounded-2xl border border-amber-500/25 bg-black/40 p-2.5 sm:p-3"
    >
      <div className="grid grid-cols-3 gap-2">
        {VALUES.map((value) => {
          const count = Math.max(0, Math.trunc(Number(placed?.[value]) || 0));
          const remaining = Math.max(0, 9 - count);
          const complete = placed != null && remaining === 0;
          return (
            <button
              key={value}
              type="button"
              data-testid={`sudoku-key-${value}`}
              onClick={() => onValue(value)}
              disabled={disabled || complete}
              className={`relative flex h-12 items-center justify-center rounded-xl border-b-4 text-xl font-black transition active:translate-y-[2px] disabled:active:translate-y-0 sm:h-14 sm:text-2xl ${
                complete
                  ? "border-white/10 bg-white/[0.06] text-white/30"
                  : "border-amber-700 bg-amber-500 text-black shadow-[0_0_18px_rgba(251,191,36,0.25)] hover:brightness-110"
              } disabled:opacity-40 disabled:shadow-none`}
            >
              {value}
              {placed != null && !complete && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-1 right-2 text-[9px] font-bold text-black/45"
                >
                  {remaining}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        data-testid="sudoku-key-erase"
        onClick={onErase}
        disabled={disabled || !canErase}
        className="mt-2 h-11 w-full rounded-xl border border-white/15 bg-white/5 text-xs font-bold uppercase tracking-widest text-white/70 transition hover:bg-white/10 disabled:opacity-35 disabled:hover:bg-white/5"
      >
        Erase
      </button>

      <p
        data-testid="sudoku-pad-hint"
        className="mt-2 min-h-[1rem] text-center text-[11px] leading-relaxed text-white/40"
      >
        {hint || "Select a cell, then tap a number."}
      </p>
    </div>
  );
}
