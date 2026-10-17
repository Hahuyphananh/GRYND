"use client";

// src/components/tic-tac-toe/TicTacToeBoard.tsx
//
// ONE mini-board of the nine in the Ultimate lattice: a 3x3 grid of cells.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// This component DRAWS a board and OFFERS empty cells; it never decides
// anything. The nine cells come from the server's authoritative snapshot
// (`board`), the win highlight comes from the server's `winningLine`, the
// server's `control` locks a resolved board, and a cell only becomes clickable
// when the parent passes `viewerCanMove` for a board the server actually offers.
// There is no local turn tracking, no local occupancy rule that could disagree
// with the server, and no client-side winner detection: a click that slipped
// through would still be rejected by the store's `validateMove`.
//
// Interaction rules, enforced here by construction:
//   • empty + offered by the server → a live button, in the "you may play here"
//     style (stronger amber when this board is the required destination)
//   • occupied                      → inert; the mark is always drawn in full
//   • not offered / resolved        → inert; a click does nothing at all
//
// Keyboard: every cell is a real <button>, so Tab/Shift+Tab moves focus and
// Enter or Space places the mark. The grid/row/gridcell roles describe the
// layout to a screen reader, and each cell is labelled with its coordinates and
// state ("Row 2, column 3 — empty. Press to place X.") so a player who cannot
// see the grid can still play it.
//
// Motion: a mark scales in when the SERVER confirms it, and the pending ghost
// pulses until it is confirmed or dropped. Both are dropped entirely under
// `prefers-reduced-motion`.

import { memo } from "react";
import { motion, useReducedMotion } from "framer-motion";

import {
  isBoardIndex,
  isCellPlayable,
  lastMoveCellIndex,
  markForSeat,
  normaliseBoard,
  seatColor,
  seatForMark,
  winningCellSet,
  boardIsResolved,
  type BoardVisualState,
} from "../../lib/tic-tac-toe/ui";
import { withReducedMotion } from "../../lib/animations";
import { BOARD_SIZE } from "../../lib/tic-tac-toe/constants";
import type { BoardControl, Cell, Mark, Seat } from "../../lib/tic-tac-toe/types";

/**
 * The mark glyph.
 *
 * Drawn as strokes rather than a text character so X and O stay unmistakable at
 * any size and inherit the seat's colour: a crossed pair of lines versus a
 * single ring. Shape AND colour both distinguish the players, so the board is
 * still readable for a colour-blind player.
 */
function MarkGlyph({ mark, className = "" }: { mark: Mark; className?: string }) {
  if (mark === "X") {
    return (
      <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
        <line x1="20" y1="20" x2="80" y2="80" stroke="currentColor" strokeWidth="14" strokeLinecap="round" />
        <line x1="80" y1="20" x2="20" y2="80" stroke="currentColor" strokeWidth="14" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r="33" fill="none" stroke="currentColor" strokeWidth="14" strokeLinecap="round" />
    </svg>
  );
}

/** "Row 2, column 3" — for the cell's accessible name. */
function cellCoords(index: number): string {
  const row = Math.floor(index / BOARD_SIZE) + 1;
  const col = (index % BOARD_SIZE) + 1;
  return `Row ${row}, column ${col}`;
}

export type TicTacToeBoardProps = {
  /** The server's board: nine cells of "X" | "O" | null. */
  board: unknown;
  /** The server's winning line, when this board was claimed. */
  winningLine?: unknown;
  /** The server's last accepted move, for the "just played" marker. */
  lastMove?: unknown;
  /** The seat the server says the viewer occupies, or null. */
  viewerSeat?: Seat | null;
  /**
   * The server's offer for THIS board — the destination/playable set AND
   * `viewerCanMove`, already folded together by the parent. This is the only
   * thing that unlocks a cell.
   */
  viewerCanMove?: boolean;
  /**
   * True while a move request is in flight. It blocks SUBMISSION without
   * changing how the board looks — the pending ghost is already the feedback.
   */
  busy?: boolean;
  /**
   * The cell the viewer has just clicked, while the server has not yet
   * confirmed it. Rendered as a translucent "pending" mark — optimistic
   * FEEDBACK only, never authoritative state: the real mark is the one the next
   * snapshot carries.
   */
  pendingCell?: number | null;
  /**
   * The SERVER's control for this board. A locked board ("X" / "O" / "draw")
   * still renders every mark it holds — it merely stops offering moves.
   */
  control?: BoardControl | null;
  /** The lattice slot this board sits in (0..8), or null for a standalone one. */
  boardIndex?: number | null;
  /** True when this board is part of the winning lattice line. */
  megaLine?: boolean;
  /** The presentation state the parent derived from the server's values. */
  state?: BoardVisualState;
  /** Tighter gaps / rounding, for the lattice where boards sit side by side. */
  compact?: boolean;
  /** Accessible name for the grid, so each lattice board is distinguishable. */
  label?: string;
  /** Called with a cell index that the server is expected to accept. */
  onPlay: (cellIndex: number) => void;
  className?: string;
};

function TicTacToeBoard({
  board,
  winningLine,
  lastMove,
  viewerSeat = null,
  viewerCanMove = false,
  busy = false,
  pendingCell = null,
  control = "active",
  boardIndex = null,
  megaLine = false,
  state = "open",
  compact = false,
  label,
  onPlay,
  className = "",
}: TicTacToeBoardProps) {
  const cells = normaliseBoard(board);
  const winning = winningCellSet(winningLine);
  const lastIndex = lastMoveCellIndex(lastMove);
  const viewerMark = markForSeat(viewerSeat);
  const pending = isBoardIndex(pendingCell) ? (pendingCell as number) : -1;
  const reduce = useReducedMotion();
  // A resolved board (won or drawn) is LOCKED: the server will refuse a move on
  // it, so the board never offers one — while still drawing every mark it holds.
  const locked = boardIsResolved(control);
  const offers = viewerCanMove && !locked;
  const required = state === "required";

  const markMotion = withReducedMotion(reduce, {
    initial: { opacity: 0, scale: 0.55 },
    animate: { opacity: 1, scale: 1 },
    transition: { type: "spring" as const, stiffness: 420, damping: 26 },
  });

  return (
    <div
      role="grid"
      aria-label={label ?? "Tic-tac-toe board, 3 by 3"}
      aria-rowcount={BOARD_SIZE}
      aria-colcount={BOARD_SIZE}
      data-testid="tic-tac-toe-board"
      data-board-index={boardIndex ?? ""}
      data-control={control ?? "active"}
      data-board-state={state}
      data-locked={locked ? "true" : "false"}
      data-mega-line={megaLine ? "true" : "false"}
      data-viewer-mark={viewerMark ?? ""}
      data-viewer-can-move={offers ? "true" : "false"}
      className={`grid grid-cols-3 ${compact ? "gap-[3px] sm:gap-1" : "gap-1.5 sm:gap-2.5"} ${
        megaLine ? "rounded-xl ring-2 ring-emerald-300/60 ring-offset-2 ring-offset-[#070b16]" : ""
      } ${className}`}
    >
      {Array.from({ length: BOARD_SIZE }, (_, row) => (
        <div key={row} role="row" className="contents">
          {Array.from({ length: BOARD_SIZE }, (_, col) => {
            const index = row * BOARD_SIZE + col;
            const cell: Cell = cells[index];
            // A placed mark is coloured by its OWNER; the hover hint and the
            // optimistic ghost on an empty cell belong to the viewer, so they
            // take the viewer's seat colour. Either way `currentColor` is set
            // once on the button and the SVG marks inherit it.
            const markSeat = cell ? seatForMark(cell) : viewerSeat;
            const colour = seatColor(markSeat);
            const isWinning = winning.has(index);
            const isLast = index === lastIndex;
            const isPendingGhost = index === pending && cell === null;
            // `playable` is purely what the SNAPSHOT allows; `actionable` adds
            // the one local condition — an in-flight request — so a fast
            // double-click cannot send two moves for the same snapshot version.
            const playable = isCellPlayable({ board: cells, cellIndex: index, viewerCanMove: offers });
            const actionable = playable && !busy;

            const stateLabel = cell
              ? `taken by ${cell}`
              : actionable && viewerMark
                ? `empty. Press to place ${viewerMark}${required ? " here" : ""}`
                : "empty";

            const base = `group relative flex aspect-square w-full items-center justify-center border outline-none transition focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-[#070b16] ${
              compact ? "rounded-[5px] sm:rounded-md" : "rounded-lg sm:rounded-xl"
            }`;
            // Four looks, in priority order: a real mark, a cell the server
            // offers (amber, stronger when this board is the required one), and
            // an inert cell that still reads as part of the grid.
            const look = cell
              ? "border-white/10 bg-white/[0.05]"
              : playable
                ? required
                  ? "cursor-pointer border-amber-300/70 bg-amber-400/[0.13] hover:border-amber-200 hover:bg-amber-400/25 focus-visible:ring-amber-200 active:scale-95"
                  : "cursor-pointer border-dashed border-amber-300/45 bg-amber-400/[0.06] hover:scale-[1.04] hover:border-amber-300 hover:bg-amber-400/15 focus-visible:ring-amber-300 active:scale-95"
                : "cursor-default border-white/[0.07] bg-black/25";

            return (
              <button
                key={index}
                type="button"
                role="gridcell"
                aria-rowindex={row + 1}
                aria-colindex={col + 1}
                aria-label={`${cellCoords(index)} — ${stateLabel}`}
                aria-disabled={actionable ? undefined : true}
                data-testid={`tic-tac-toe-cell-${index}`}
                data-state={cell ?? "empty"}
                data-playable={actionable ? "true" : "false"}
                data-winning={isWinning ? "true" : "false"}
                data-last-move={isLast && Boolean(cell) ? "true" : "false"}
                // Deliberately NOT the native `disabled` attribute: a locked cell
                // stays focusable so a keyboard or screen-reader player can tab
                // across all nine cells and hear every one of them.
                onClick={() => {
                  // Belt and braces: a click on an occupied / locked / unoffered
                  // cell does nothing at all — it must not even reach the server.
                  if (!actionable) return;
                  onPlay(index);
                }}
                style={
                  isWinning
                    ? {
                        color: colour,
                        borderColor: colour,
                        boxShadow: `0 0 0 1px ${colour}, 0 0 22px ${colour}55`,
                        background: `${colour}1f`,
                      }
                    : { color: colour }
                }
                className={`${base} ${look} ${
                  isWinning ? "focus-visible:ring-emerald-300" : "focus-visible:ring-white/40"
                }`}
              >
                {/* A real, server-confirmed mark. It animates in ONCE, when the
                    snapshot first carries it. */}
                {cell && (
                  <motion.span {...markMotion} className="flex h-[58%] w-[58%] items-center justify-center">
                    <MarkGlyph mark={cell} className="h-full w-full drop-shadow-[0_0_8px_currentColor]" />
                  </motion.span>
                )}

                {/* Optimistic feedback only: the viewer's own pending mark. */}
                {isPendingGhost && viewerMark && (
                  <span
                    className={`flex h-[58%] w-[58%] items-center justify-center opacity-45 ${
                      reduce ? "" : "animate-pulse"
                    }`}
                  >
                    <MarkGlyph mark={viewerMark} className="h-full w-full" />
                  </span>
                )}

                {/* Which mark a click would place — a hover affordance on the
                    empty cells that are actually playable. */}
                {!cell && actionable && viewerMark && (
                  <span className="pointer-events-none flex h-[58%] w-[58%] items-center justify-center opacity-0 transition group-hover:opacity-30">
                    <MarkGlyph mark={viewerMark} className="h-full w-full" />
                  </span>
                )}

                {/* Just played: a soft ring in the mover's colour, so the last
                    mark is findable on a nine-board lattice. */}
                {isLast && cell && (
                  <motion.span
                    aria-hidden="true"
                    {...withReducedMotion(reduce, {
                      initial: { opacity: 0.9, scale: 1.35 },
                      animate: { opacity: 0, scale: 1 },
                      transition: { duration: 0.6, ease: "easeOut" as const },
                    })}
                    className="pointer-events-none absolute inset-0 rounded-[inherit] border-2"
                    style={{ borderColor: colour }}
                  />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// The board is a pure function of its props, and the match page re-renders on
// every poll tick; memoising keeps the nine SVG cells from reconciling when
// nothing about the board changed.
export default memo(TicTacToeBoard);
