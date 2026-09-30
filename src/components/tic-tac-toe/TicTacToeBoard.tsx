"use client";

// src/components/tic-tac-toe/TicTacToeBoard.tsx
//
// The 3x3 Tic-Tac-Toe board.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// This component DRAWS a board and OFFERS empty cells; it never decides
// anything. The nine cells come from the server's authoritative snapshot
// (`board`), the win highlight comes from the server's `winningLine`, and a
// cell only becomes clickable when the snapshot's own `viewerCanMove` flag says
// so. There is no local turn tracking, no local occupancy check that could
// disagree with the server, and no client-side winner detection: a click that
// slipped through would still be rejected by the store's `validateMove`.
//
// Interaction rules, enforced here by construction:
//   • empty + your turn + match live → the cell is a live button
//   • occupied                       → `disabled`; a click does nothing
//   • not your turn / match over     → `disabled`; a click does nothing
//
// Keyboard: every cell is a real <button>, so Tab/Shift+Tab moves focus and
// Enter or Space places the mark. The grid/row/gridcell roles describe the
// layout to a screen reader, and each cell is labelled with its coordinates and
// state ("Row 2, column 3 — empty. Press to place X.") so a player who cannot
// see the grid can still play it.

import { memo } from "react";
import {
  isBoardIndex,
  isCellPlayable,
  lastMoveCellIndex,
  markForSeat,
  normaliseBoard,
  seatColor,
  seatForMark,
  winningCellSet,
} from "../../lib/tic-tac-toe/ui";
import { BOARD_SIZE } from "../../lib/tic-tac-toe/constants";
import type { Cell, Mark, Seat } from "../../lib/tic-tac-toe/types";

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
        <line
          x1="20"
          y1="20"
          x2="80"
          y2="80"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinecap="round"
        />
        <line
          x1="80"
          y1="20"
          x2="20"
          y2="80"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <circle
        cx="50"
        cy="50"
        r="32"
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
      />
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
  /** The server's winning line, when the match is won. */
  winningLine?: unknown;
  /** The server's last accepted move, for the "just played" marker. */
  lastMove?: unknown;
  /** The seat the server says the viewer occupies, or null. */
  viewerSeat?: Seat | null;
  /** The server's `viewerCanMove` flag — the only thing that unlocks a cell. */
  viewerCanMove?: boolean;
  /**
   * True while a move request is in flight. It blocks SUBMISSION without
   * changing how the board looks — the pending ghost is already the feedback.
   */
  busy?: boolean;
  /**
   * The cell the viewer has just clicked, while the server has not yet
   * confirmed it. Rendered as a translucent "pending" mark — optimistic
   * FEEDBACK only, never authoritative state: the real mark is the one the
   * next snapshot carries.
   */
  pendingCell?: number | null;
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
  onPlay,
  className = "",
}: TicTacToeBoardProps) {
  const cells = normaliseBoard(board);
  const winning = winningCellSet(winningLine);
  const lastIndex = lastMoveCellIndex(lastMove);
  const viewerMark = markForSeat(viewerSeat);
  const pending = isBoardIndex(pendingCell) ? (pendingCell as number) : -1;

  return (
    <div
      role="grid"
      aria-label="Tic-tac-toe board, 3 by 3"
      aria-rowcount={BOARD_SIZE}
      aria-colcount={BOARD_SIZE}
      data-testid="tic-tac-toe-board"
      data-viewer-mark={viewerMark ?? ""}
      data-viewer-can-move={viewerCanMove ? "true" : "false"}
      className={`grid grid-cols-3 gap-2 sm:gap-3 ${className}`}
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
            const playable = isCellPlayable({ board: cells, cellIndex: index, viewerCanMove });
            const actionable = playable && !busy;

            const stateLabel = cell
              ? `taken by ${cell}`
              : actionable && viewerMark
                ? `empty. Press to place ${viewerMark}`
                : "empty";

            const base =
              "group relative flex aspect-square w-full items-center justify-center rounded-xl border-2 outline-none transition sm:rounded-2xl focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#070b16]";
            const look = cell
              ? "border-white/15 bg-white/[0.06]"
              : playable
                ? "cursor-pointer border-dashed border-amber-300/45 bg-amber-400/[0.06] hover:scale-[1.03] hover:border-amber-300 hover:bg-amber-400/15 focus-visible:ring-amber-300 active:scale-95"
                : "cursor-default border-white/10 bg-black/30";

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
                // Deliberately NOT the native `disabled` attribute: a locked cell
                // stays focusable so a keyboard or screen-reader player can tab
                // across all nine cells and hear every one of them.
                onClick={() => {
                  // Belt and braces: a click on an occupied / locked cell does
                  // nothing at all — it must not even reach the server.
                  if (!actionable) return;
                  onPlay(index);
                }}
                style={
                  isWinning
                    ? {
                        color: colour,
                        borderColor: colour,
                        boxShadow: `0 0 0 1px ${colour}, 0 0 28px ${colour}66`,
                        background: `${colour}1f`,
                      }
                    : { color: colour }
                }
                className={`${base} ${look} ${
                  isWinning ? "focus-visible:ring-emerald-300" : "focus-visible:ring-white/40"
                }`}
              >
                {/* A real, server-confirmed mark. */}
                {cell && (
                  <MarkGlyph
                    mark={cell}
                    className="h-[58%] w-[58%] drop-shadow-[0_0_10px_currentColor]"
                  />
                )}

                {/* Optimistic feedback only: the viewer's own pending mark. */}
                {isPendingGhost && viewerMark && (
                  <MarkGlyph
                    mark={viewerMark}
                    className="h-[58%] w-[58%] animate-pulse opacity-45"
                  />
                )}

                {/* Which mark a click would place — a hover affordance on the
                    empty cells that are actually playable. */}
                {!cell && actionable && viewerMark && (
                  <MarkGlyph
                    mark={viewerMark}
                    className="pointer-events-none h-[58%] w-[58%] opacity-0 transition group-hover:opacity-25"
                  />
                )}

                {/* Just played: a small corner dot in the mover's colour. */}
                {isLast && !isWinning && cell && (
                  <span
                    aria-hidden="true"
                    className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full sm:right-2 sm:top-2 sm:h-2 sm:w-2"
                    style={{ background: colour }}
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
