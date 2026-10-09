"use client";

// src/components/tic-tac-toe/MegaBoard.tsx
//
// The Mega Tic-Tac-Toe lattice: one, four or nine small 3x3 boards laid out as
// a clean grid (1x1 → 2x2 → 3x3).
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// This component DRAWS the server snapshot and OFFERS cells; it never decides
// anything. Every board's cells, its control ("active" / "draw" / "X" / "O"),
// its winning line, the round (stage), the slots in play and the Mega winning
// line all arrive in the DTO. There is no client-side winner detection and no
// client-side control inference: a click that slipped through would still be
// rejected by the store's `validateMove`.
//
// ── WHAT IT COMMUNICATES ──────────────────────────────────────────────────
//
//   • the current round (1 → 4 → 9 boards) as a three-step tracker
//   • a live legend of how many boards X controls, O controls, are drawn and
//     are still open
//   • each board's own control badge, so a locked board is unmistakable while
//     still showing its complete X/O state
//   • the winning small-board line (via the board component) and the winning
//     three-board Mega line (a drawn overlay + a ring on each board)
//   • which board the player is interacting with (a focus ring, set on hover,
//     tap or keyboard focus)
//
// Expansion is animated with framer-motion `layout`: the original Round-1 board
// keeps its identity (stable slot key) and visually shrinks into its quadrant
// as the three new boards mount around it.

import { memo } from "react";
import { motion } from "framer-motion";

import TicTacToeBoard from "./TicTacToeBoard";
import { SUDDEN_DEATH_BOARD_INDEX } from "../../lib/tic-tac-toe/constants";
import {
  boardControlLabel,
  boardControlShort,
  boardIsResolved,
  boardOwnerSeat,
  megaControlCounts,
  megaWinningSlotSet,
  normaliseLattice,
  normaliseSlotList,
  normaliseStage,
  normaliseSuddenDeath,
  roundBlurb,
  roundLabel,
  roundName,
  seatColor,
  slotGridPosition,
  stageColumns,
  stageSlots,
} from "../../lib/tic-tac-toe/ui";
import type { Seat } from "../../lib/tic-tac-toe/types";

export type MegaBoardProps = {
  /** The server's lattice, length 9 (`null` slots are not in play yet). */
  boards: unknown;
  /** The server's round (stage): 1 | 2 | 3. */
  stage: unknown;
  /** The server's slots in play at this stage (authoritative). */
  slots?: unknown;
  /** The server's winning Mega slots, or null. */
  winningBoards?: unknown;
  /** The server's last accepted move, for the "just played" marker. */
  lastMove?: unknown;
  /** The server's sudden-death state, or null. */
  suddenDeath?: unknown;
  /** The seat the server says the viewer occupies. */
  viewerSeat: Seat | null;
  /** The server's `viewerCanMove` flag — the only thing that unlocks a cell. */
  viewerCanMove: boolean;
  /** True while a move request is in flight. */
  busy?: boolean;
  /** The optimistic ghost: the board + cell just clicked, until confirmed. */
  pending?: { boardIndex: number; cellIndex: number } | null;
  /** The board the viewer is interacting with, for the focus ring. */
  focusedBoard?: number | null;
  /**
   * The board that just resolved (won or drawn) on the latest snapshot, for a
   * brief highlight. Purely a reaction to the server's control change.
   */
  highlightSlot?: number | null;
  /** Called when the viewer hovers / focuses a board, and on a click. */
  onFocusBoard?: (boardIndex: number) => void;
  /** Called with the board slot and the cell the viewer played. */
  onPlay: (boardIndex: number, cellIndex: number) => void;
  className?: string;
};

/** One small board inside the lattice, with its header, badge and focus ring. */
function BoardCard({
  board,
  slot,
  round,
  megaLine,
  focused,
  highlight,
  viewerSeat,
  viewerCanMove,
  busy,
  pendingCell,
  lastMove,
  onFocusBoard,
  onPlay,
}: {
  board: ReturnType<typeof normaliseLattice>[number];
  slot: number;
  round: 1 | 2 | 3;
  megaLine: boolean;
  focused: boolean;
  highlight: boolean;
  viewerSeat: Seat | null;
  viewerCanMove: boolean;
  busy: boolean;
  pendingCell: number | null;
  lastMove: unknown;
  onFocusBoard?: (boardIndex: number) => void;
  onPlay: (boardIndex: number, cellIndex: number) => void;
}) {
  // A `null` slot is not in play at this round: the server has not materialised
  // it yet, so there is nothing to draw and nothing to offer.
  if (!board) return null;

  const resolved = boardIsResolved(board.control);
  const owner = boardOwnerSeat(board.control);
  const accent = seatColor(owner);
  const playable = viewerCanMove && board.control === "active";
  const compact = round > 1;

  const frame = megaLine
    ? "border-emerald-300/70 bg-emerald-400/[0.07] shadow-[0_0_30px_rgba(52,211,153,0.28)]"
    : resolved
      ? "border-white/10 bg-black/30"
      : playable
        ? "border-amber-400/30 bg-black/40"
        : "border-white/10 bg-black/35";

  const badge = megaLine
    ? "border-emerald-300/60 bg-emerald-400/15 text-emerald-200"
    : board.control === "X" || board.control === "O"
      ? "border-transparent text-[#0b0f1c]"
      : board.control === "draw"
        ? "border-white/20 bg-white/10 text-white/70"
        : playable
          ? "border-amber-400/50 bg-amber-500/15 text-amber-200"
          : "border-white/10 bg-white/5 text-white/50";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 240, damping: 26 }}
      data-testid={`tic-tac-toe-lattice-board-${slot}`}
      data-control={board.control}
      data-resolved={resolved ? "true" : "false"}
      data-focused={focused ? "true" : "false"}
      onMouseEnter={onFocusBoard ? () => onFocusBoard(slot) : undefined}
      onFocus={onFocusBoard ? () => onFocusBoard(slot) : undefined}
      // `min-w-0`: a grid item defaults to `min-width: auto`, i.e. it refuses to
      // shrink below its own min-content width (the "Board 1" label plus the
      // control badge). Without this the nine cards would push the lattice past
      // the viewport on a phone; with it the cards and their `aspect-square`
      // cells shrink to whatever the track gives them.
      className={`min-w-0 rounded-2xl border p-1.5 transition sm:p-2 ${frame} ${
        highlight
          ? "ring-2 ring-amber-300/90 shadow-[0_0_36px_rgba(251,191,36,0.45)]"
          : focused
            ? "ring-2 ring-amber-300/70"
            : ""
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-1">
        <span className="truncate text-[10px] font-bold uppercase tracking-wider text-white/55 sm:text-[11px]">
          Board {slot + 1}
        </span>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider sm:text-[10px] ${badge}`}
          style={
            board.control === "X" || board.control === "O"
              ? { background: accent }
              : undefined
          }
        >
          {megaLine ? "Mega line" : boardControlShort(board.control)}
        </span>
      </div>

      <TicTacToeBoard
        board={board.cells}
        winningLine={board.winningLine}
        control={board.control}
        boardIndex={slot}
        megaLine={megaLine}
        compact={compact}
        label={`Board ${slot + 1} — ${boardControlLabel(board.control)}`}
        lastMove={
          (lastMove as { boardIndex?: unknown } | null)?.boardIndex === slot ? lastMove : null
        }
        viewerSeat={viewerSeat}
        viewerCanMove={playable}
        busy={busy}
        pendingCell={pendingCell}
        onPlay={(cellIndex) => onPlay(slot, cellIndex)}
      />
    </motion.div>
  );
}

function MegaBoard({
  boards,
  stage,
  slots: slotsProp,
  winningBoards,
  lastMove,
  suddenDeath,
  viewerSeat,
  viewerCanMove,
  busy = false,
  pending = null,
  focusedBoard = null,
  highlightSlot = null,
  onFocusBoard,
  onPlay,
  className = "",
}: MegaBoardProps) {
  const round = normaliseStage(stage);
  const lattice = normaliseLattice(boards);
  const serverSlots = normaliseSlotList(slotsProp);
  const slots = serverSlots.length ? serverSlots : stageSlots(round);
  const cols = stageColumns(round);
  const winningSet = megaWinningSlotSet(winningBoards);
  const counts = megaControlCounts(lattice, slots);
  const suddenDeathBoards = normaliseSuddenDeath(suddenDeath);
  const owned = [...winningSet];
  const winningMark = owned.length ? lattice[owned[0]]?.control ?? null : null;

  // Responsive sizing.
  //
  // The lattice must FIT its column at every width, so the whole Round-3 3×3
  // (nine boards) stays on screen on a phone with no sideways scroll. The old
  // always-on inline `min-width: cols * 10.5rem` was 504px at Round 3 — wider
  // than any phone's content width — so the 9-board round became a
  // horizontally-scrolling strip, while on a wide column the `minmax(0, 1fr)`
  // tracks already stretched well past it. There is no floor now: the tracks
  // are `minmax(0, 1fr)` and each card carries `min-w-0`, so the boards and
  // their `aspect-square` cells simply shrink to fit. `data-cols` names the
  // round's column count for the CSS hook and the layout audits.
  //
  // Round 1's lone board would otherwise stretch to the full width of its
  // column, so it keeps a ceiling: a 3x3 that stays comfortably playable and is
  // close to the size each board shrinks to once the lattice expands.
  const maxWidth = cols === 1 ? "20rem" : undefined;

  // The Mega win overlay: a single line between the first and last winning
  // board's centres, drawn in the winner's colour. Only a genuine three-slot
  // line is drawn.
  const lineSlots = owned;
  let overlay: { x1: number; y1: number; x2: number; y2: number; color: string } | null = null;
  if (lineSlots.length === 3 && !suddenDeathBoards.length) {
    const first = slotGridPosition(lineSlots[0], round);
    const last = slotGridPosition(lineSlots[2], round);
    overlay = {
      x1: ((first.col + 0.5) / first.cols) * 100,
      y1: ((first.row + 0.5) / first.rows) * 100,
      x2: ((last.col + 0.5) / last.cols) * 100,
      y2: ((last.row + 0.5) / last.rows) * 100,
      color: seatColor(boardOwnerSeat(lattice[lineSlots[0]]?.control)),
    };
  }

  const focused = focusedBoard !== null && slots.includes(focusedBoard) ? focusedBoard : null;

  return (
    <div data-testid="tic-tac-toe-mega" data-stage={round} className={className}>
      {/* ── Round tracker + control legend ─────────────────────────────── */}
      <div className="mb-3 space-y-2">
        <div
          data-testid="mega-round"
          data-round={round}
          className="flex flex-wrap items-center gap-1.5"
        >
          {([1, 2, 3] as const).map((step) => {
            const isCurrent = step === round;
            const done = step < round;
            const count = [1, 4, 9][step - 1];
            return (
              <span
                key={step}
                data-step={step}
                data-active={isCurrent ? "true" : "false"}
                className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition sm:text-[11px] ${
                  isCurrent
                    ? "border-amber-400/60 bg-amber-500/15 text-amber-200"
                    : done
                      ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200/80"
                      : "border-white/10 bg-white/5 text-white/35"
                }`}
              >
                Round {step} · {count} {count === 1 ? "board" : "boards"}
              </span>
            );
          })}
        </div>

        <div
          data-testid="mega-legend"
          className="flex flex-wrap items-center gap-2 text-[11px] font-semibold"
        >
          <LegendChip color={seatColor("player1")} label={`X controls`} value={counts.x} />
          <LegendChip color={seatColor("player2")} label={`O controls`} value={counts.o} />
          <LegendChip color="#94a3b8" label="Draws" value={counts.draw} />
          <LegendChip color="#fbbf24" label="Open" value={counts.active} />
          <span className="text-white/45">
            {counts.resolved} of {slots.length} boards locked
          </span>
        </div>

        <p data-testid="mega-round-blurb" className="text-[11px] text-white/45">
          <span className="font-bold text-amber-200/80">{roundLabel(round)}</span>{" "}
          <span className="uppercase tracking-wider text-white/35">· {roundName(round)} ·</span>{" "}
          {roundBlurb(round)}
        </p>

        {winningSet.size === 3 && (
          <motion.p
            data-testid="mega-win-line"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 320, damping: 24 }}
            className="rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-2.5 py-1.5 text-center text-xs font-black uppercase tracking-[0.2em] text-emerald-100"
          >
            Mega line — {winningMark ?? "X"} wins the match
            <span className="mt-0.5 block text-[10px] font-semibold tracking-normal text-emerald-200/80">
              {[...winningSet].map((slot) => `Board ${slot + 1}`).join(" · ")}
            </span>
          </motion.p>
        )}
      </div>

      {/* ── Sudden death ───────────────────────────────────────────────── */}
      {suddenDeathBoards.length > 0 && (
        <section
          data-testid="tic-tac-toe-sudden-death"
          className="mb-3 rounded-2xl border border-emerald-400/40 bg-emerald-500/[0.06] p-3"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-200">
              Sudden death
            </h3>
            <span className="text-[11px] text-white/60">
              Board {suddenDeathBoards.length} of the sudden-death sequence — a win ends the match.
            </span>
          </div>
          <div className="mx-auto grid max-w-sm grid-cols-1 gap-2">
            {suddenDeathBoards.map((board, index) => {
              const isCurrent = index === suddenDeathBoards.length - 1 && !boardIsResolved(board.control);
              return (
                <motion.div
                  key={index}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={`rounded-2xl border p-2 ${
                    isCurrent ? "border-emerald-300/60 bg-black/40" : "border-white/10 bg-black/30"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/55">
                      {isCurrent ? "Live board" : `Board ${index + 1}`}
                    </span>
                    <span className="rounded-full border border-white/15 bg-white/5 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-white/60">
                      {boardControlShort(board.control)}
                    </span>
                  </div>
                  <TicTacToeBoard
                    board={board.cells}
                    winningLine={board.winningLine}
                    control={board.control}
                    boardIndex={SUDDEN_DEATH_BOARD_INDEX}
                    label={`Sudden death board ${index + 1} — ${boardControlLabel(board.control)}`}
                    lastMove={
                      (lastMove as { boardIndex?: unknown } | null)?.boardIndex ===
                      SUDDEN_DEATH_BOARD_INDEX
                        ? lastMove
                        : null
                    }
                    viewerSeat={viewerSeat}
                    viewerCanMove={viewerCanMove && isCurrent}
                    busy={busy}
                    pendingCell={
                      pending && pending.boardIndex === SUDDEN_DEATH_BOARD_INDEX
                        ? pending.cellIndex
                        : null
                    }
                    onPlay={(cellIndex) => onPlay(SUDDEN_DEATH_BOARD_INDEX, cellIndex)}
                  />
                </motion.div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── The lattice ────────────────────────────────────────────────── */}
      {/* The lattice always fits its column (see `.mega-lattice` below), so a
          phone never scrolls sideways and the whole 3×3 stays visible.
          `overflow-x-auto` is only a safety net for a pathological viewport. */}
      <div className="overflow-x-auto pb-1">
        <div
          className="mega-lattice relative mx-auto w-full"
          data-cols={cols}
          style={{ maxWidth }}
        >
          <div
            className="grid gap-2 sm:gap-3"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            aria-label={`Mega board — ${slots.length} boards in play`}
          >
            {slots.map((slot) => (
              <BoardCard
                key={slot}
                board={lattice[slot]}
                slot={slot}
                round={round}
                megaLine={winningSet.has(slot)}
                focused={focused === slot}
                highlight={highlightSlot === slot}
                viewerSeat={viewerSeat}
                viewerCanMove={viewerCanMove}
                busy={busy}
                pendingCell={
                  pending && pending.boardIndex === slot ? pending.cellIndex : null
                }
                lastMove={lastMove}
                onFocusBoard={onFocusBoard}
                onPlay={onPlay}
              />
            ))}
          </div>

          {overlay && (
            <svg
              data-testid="mega-winning-line"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
            >
              <line
                x1={overlay.x1}
                y1={overlay.y1}
                x2={overlay.x2}
                y2={overlay.y2}
                stroke={overlay.color}
                strokeWidth="3"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                style={{ filter: `drop-shadow(0 0 6px ${overlay.color})` }}
              />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendChip({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-white/70">
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      {value} {label}
    </span>
  );
}

// The lattice is a pure function of its props and the page re-renders on every
// poll tick; memoising keeps the SVG cells from reconciling when the snapshot
// did not change.
export default memo(MegaBoard);
