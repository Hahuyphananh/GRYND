"use client";

// src/components/sudoku-duel/SudokuBoard.tsx
//
// The Sudoku Duel board: ONE large 9x9 grid that fills the play area.
//
// ── WHAT THIS COMPONENT DOES AND DOES NOT DO ─────────────────────────────
//
// It renders the view the SERVER projected, cell for cell. There is no local
// solving: it cannot mark a value correct, cannot detect a win, cannot reveal an
// answer. The server's seat board only ever holds clues and CORRECTLY placed
// values (a wrong value is never written — it is counted as a mistake), so a
// number this board displays is a number the server has already verified.
//
// That is why "invalid input" reads as a brief red flash on the cell and a
// quiet penalty line, never as a wrong digit sitting on the board: showing the
// wrong digit would tell the player what to change, and showing the right one
// would hand them the answer.
//
// Interaction is SELECT A CELL, then ENTER A NUMBER from the pad (or the
// keyboard). Cells stay selectable while a race is live so the row, column and
// box can be highlighted; whether an entry is ACCEPTED is entirely the parent's
// and the server's call.

import { useMemo } from "react";

import { BOX, CELL_COUNT, EMPTY, SIZE } from "../../lib/sudoku-duel/constants";
import { peersOf } from "../../lib/sudoku-duel/rules";
import type { SudokuView } from "../../lib/sudoku-duel/types";

export type SudokuBoardProps = {
  /** The server's projection of the viewer's own board. */
  view: SudokuView | null;
  /** True only while the server is accepting this seat's actions. */
  interactive: boolean;
  /** A move is in flight — the pad and the pending cell show it. */
  pending?: boolean;
  /** The cell whose move is in flight (a subtle pulse, never a value). */
  pendingIndex?: number | null;
  /** The selected cell. */
  selectedIndex?: number | null;
  /** A cell the server just judged INCORRECT — flashes, reveals nothing. */
  invalidIndex?: number | null;
  onSelect?: (index: number) => void;
};

/** The nine cell indices of each 3x3 box, in reading order. */
const BOXES: number[][] = (() => {
  const boxes: number[][] = [];
  for (let boxRow = 0; boxRow < SIZE / BOX; boxRow += 1) {
    for (let boxCol = 0; boxCol < SIZE / BOX; boxCol += 1) {
      const cells: number[] = [];
      for (let r = 0; r < BOX; r += 1) {
        for (let c = 0; c < BOX; c += 1) {
          cells.push((boxRow * BOX + r) * SIZE + boxCol * BOX + c);
        }
      }
      boxes.push(cells);
    }
  }
  return boxes;
})();

export default function SudokuBoard({
  view,
  interactive,
  pending = false,
  pendingIndex = null,
  selectedIndex = null,
  invalidIndex = null,
  onSelect,
}: SudokuBoardProps) {
  const puzzle = view?.puzzle ?? null;
  const entries = view?.entries ?? null;
  const completed = Boolean(view?.completed);

  const conflicts = useMemo(
    () => new Set<number>(Array.isArray(view?.conflicts) ? view.conflicts : []),
    [view?.conflicts],
  );

  // The highlight sets, all derived from the VISIBLE board only — no solution is
  // involved, so they can never leak an answer.
  const peers = useMemo(
    () =>
      selectedIndex == null || selectedIndex < 0
        ? new Set<number>()
        : new Set<number>(peersOf(selectedIndex)),
    [selectedIndex],
  );
  const selectedValue =
    selectedIndex != null && entries ? Number(entries[selectedIndex]) || EMPTY : EMPTY;

  const sameValue = useMemo(() => {
    if (!entries || selectedValue === EMPTY) return new Set<number>();
    const out = new Set<number>();
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (entries[i] === selectedValue) out.add(i);
    }
    return out;
  }, [entries, selectedValue]);

  return (
    <div
      role="group"
      aria-label="Sudoku board"
      data-testid="sudoku-board"
      data-completed={completed ? "true" : "false"}
      data-interactive={interactive ? "true" : "false"}
      className={`mx-auto aspect-square w-full max-w-[560px] select-none rounded-2xl border-2 p-[3px] transition-shadow ${
        completed
          ? "border-emerald-400/60 bg-[#05130c] shadow-[0_0_44px_rgba(52,211,153,0.30)]"
          : "border-white/25 bg-[#080807] shadow-[0_0_40px_rgba(251,191,36,0.12)]"
      }`}
    >
      {/* The heavy 3x3 section separators come from this grid's light gaps
          between boxes; the thin cell lines come from each box's own dark gaps. */}
      <div className="grid h-full w-full grid-cols-3 grid-rows-3 gap-[3px] rounded-xl bg-white/20">
        {BOXES.map((cells, boxIndex) => (
          <div
            key={boxIndex}
            className="grid min-h-0 min-w-0 grid-cols-3 grid-rows-3 gap-px bg-black/60"
          >
            {cells.map((index) => {
              const value = entries ? Number(entries[index]) || EMPTY : EMPTY;
              const isGiven = Boolean(puzzle && puzzle[index] !== EMPTY);
              const isSelected = selectedIndex === index;
              const isInvalid = invalidIndex === index;
              const isPending = pending && pendingIndex === index;
              const isConflict = conflicts.has(index);
              const isPeer = !isSelected && peers.has(index);
              const isSame =
                !isSelected && !isPeer && value !== EMPTY && sameValue.has(index);

              const surface = isSelected
                ? "bg-amber-400/30 ring-2 ring-inset ring-amber-300"
                : isInvalid
                  ? "bg-red-500/45 ring-2 ring-inset ring-red-400"
                  : isPending
                    ? "animate-pulse bg-white/10 ring-1 ring-inset ring-white/25"
                    : isConflict
                      ? "bg-red-500/20 ring-1 ring-inset ring-red-500/50"
                      : isSame
                        ? "bg-[#00e5ff]/20"
                        : isPeer
                          ? "bg-white/[0.07]"
                          : completed
                            ? "bg-emerald-400/10"
                            : interactive
                              ? "hover:bg-white/[0.09]"
                              : "";

              const ink = isInvalid
                ? "text-red-100"
                : isGiven
                  ? "text-white"
                  : value !== EMPTY
                    ? completed
                      ? "text-emerald-200"
                      : "text-amber-300"
                    : "text-transparent";

              const label = `${`Row ${Math.floor(index / SIZE) + 1} column ${
                (index % SIZE) + 1
              }`}${isGiven ? `, clue ${value}` : value !== EMPTY ? `, ${value}` : ", empty"}`;

              return (
                <button
                  key={index}
                  type="button"
                  aria-label={label}
                  aria-current={isSelected ? "true" : undefined}
                  data-index={index}
                  data-given={isGiven ? "true" : "false"}
                  data-value={value || ""}
                  tabIndex={interactive ? 0 : -1}
                  onClick={() => onSelect?.(index)}
                  className={`relative flex min-h-0 min-w-0 items-center justify-center font-mono text-[clamp(1rem,4.1vw,1.9rem)] leading-none tabular-nums transition-colors duration-100 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-amber-300 ${
                    interactive ? "cursor-pointer" : "cursor-default"
                  } ${surface} ${isGiven ? "font-bold" : "font-semibold"} ${ink}`}
                >
                  {value !== EMPTY ? String(value) : ""}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
