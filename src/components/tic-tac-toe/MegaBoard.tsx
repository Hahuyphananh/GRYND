"use client";

// src/components/tic-tac-toe/MegaBoard.tsx
//
// The Ultimate Tic-Tac-Toe board: ONE large 3x3 board whose nine squares are
// themselves 3x3 mini-boards.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────────
//
// This component DRAWS the server snapshot and OFFERS cells; it never decides
// anything. Every board's cells, its control ("active" / "draw" / "X" / "O"),
// its winning cell line, the required destination (`nextBoard`), the playable
// set (`playableBoards`) and the winning lattice line all arrive in the DTO.
// There is no client-side winner detection, no client-side control inference
// and no re-derivation of the forced destination: a click that slipped through
// would still be rejected by the store's `validateMove`.
//
// ── WHAT IT COMMUNICATES ──────────────────────────────────────────────────
//
//   • the REQUIRED mini-board, unmistakable: amber ring, glow, "Play here"
//     chip. Exactly ONE board is ever highlighted this way.
//   • FREE CHOICE, when the destination resolved: said in words in the header
//     chip and every open board is drawn in the same "you may play here" style.
//   • each board's own state as one word — Play here / Open / Waiting / X / O /
//     Draw — and, once a board is DONE, a claimed-board overlay: a dark wash
//     with the owner's mark blown up across the whole board (or DRAW), so a
//     resolved board is unmistakable at a glance on a nine-board lattice.
//   • the winning mini-board line (from the server's per-board winningLine) and
//     the winning three-board lattice line (a drawn line plus emerald rings).
//   • the three rules of the game, in a strip under the board.
//
// Every card is mounted at once and stays mounted: in Ultimate there is no
// expansion, so nothing appears later and no board ever moves.

import { memo, useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import TicTacToeBoard, { MarkGlyph } from "./TicTacToeBoard";
import { withReducedMotion } from "../../lib/animations";
import {
  HOW_TO_PLAY,
  boardName,
  boardPositionName,
  boardState,
  boardStateBadge,
  boardStateDescription,
  boardStateMark,
  destinationChip,
  isFreeChoice,
  latticeProgress,
  latticeSlots,
  normaliseLattice,
  normaliseWinningBoards,
  playableLatticeBoards,
  requiredBoard,
  seatColor,
  slotGridPosition,
  winningBoardSet,
  type BoardVisualState,
  type NormalisedBoard,
} from "../../lib/tic-tac-toe/ui";
import type { Seat } from "../../lib/tic-tac-toe/types";

/** The lattice is a fixed 3x3 grid — named so the grid template reads clearly. */
const LATTICE_COLUMNS = 3;

export type MegaBoardProps = {
  /** The server's lattice, length 9. */
  boards: unknown;
  /** The server's winning lattice slots (three of them), or null. */
  winningBoards?: unknown;
  /** The server's last accepted move, for the "just played" marker. */
  lastMove?: unknown;
  /** The server's required destination slot, or null for a free choice. */
  nextBoard?: unknown;
  /** The server's playable boards — the boards a move may address. */
  playableBoards?: unknown;
  /** The server's row status, so a terminal match says so. */
  status?: unknown;
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

/** The frame + chip styling for each board state. */
const CARD_FRAME: Record<BoardVisualState, string> = {
  // The required board owns the eye, but with a seated shadow rather than a
  // halo: a downward drop plus a 1px top-lit edge reads as a raised card on a
  // dark ground without smearing the board's own border.
  required:
    "border-amber-300/80 bg-amber-400/[0.07] ring-2 ring-amber-300/60 shadow-[0_14px_28px_-22px_rgba(251,191,36,0.9),inset_0_1px_0_rgba(255,255,255,0.07)]",
  open: "border-amber-400/25 bg-black/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-amber-300/45",
  waiting: "border-white/[0.08] bg-black/40 opacity-60",
  "won-x": "border-amber-400/40 bg-amber-400/[0.05]",
  "won-o": "border-cyan-400/40 bg-cyan-400/[0.05]",
  drawn: "border-white/10 bg-white/[0.03] opacity-85",
};

/** The badge styling for each board state. */
const CARD_BADGE: Record<BoardVisualState, string> = {
  required: "border-amber-300/70 bg-amber-400/20 text-amber-100",
  open: "border-amber-400/30 bg-amber-500/10 text-amber-200/80",
  waiting: "border-white/10 bg-white/5 text-white/45",
  "won-x": "border-transparent text-[#070b16]",
  "won-o": "border-transparent text-[#070b16]",
  drawn: "border-white/15 bg-white/10 text-white/70",
};

/** One mini-board inside the lattice: header, board, and its state framing. */
function BoardCard({
  board,
  slot,
  state,
  latticeLine,
  selectable,
  focused,
  highlight,
  viewerSeat,
  busy,
  pendingCell,
  lastMove,
  reduceMotion,
  onFocusBoard,
  onPlay,
}: {
  board: NormalisedBoard;
  slot: number;
  state: BoardVisualState;
  latticeLine: boolean;
  selectable: boolean;
  focused: boolean;
  highlight: boolean;
  viewerSeat: Seat | null;
  busy: boolean;
  pendingCell: number | null;
  lastMove: unknown;
  reduceMotion: boolean;
  onFocusBoard?: (boardIndex: number) => void;
  onPlay: (boardIndex: number, cellIndex: number) => void;
}) {
  const ownerMark = boardStateMark(state);
  const ownerColour = ownerMark ? seatColor(ownerMark === "X" ? "player1" : "player2") : null;
  const position = boardPositionName(slot);
  const cardLabel = `${boardName(slot)} (${position}) — ${boardStateDescription(state)}`;

  const frame = latticeLine
    ? "border-emerald-300/60 ring-2 ring-emerald-300/50 shadow-[0_0_26px_-4px_rgba(52,211,153,0.55)]"
    : CARD_FRAME[state];

  return (
    <motion.div
      layout
      initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 260, damping: 26, delay: Math.min(slot, 8) * 0.015 }
      }
      role="group"
      aria-label={cardLabel}
      data-testid={`tic-tac-toe-lattice-board-${slot}`}
      data-state={state}
      data-control={board.control}
      data-resolved={state === "won-x" || state === "won-o" || state === "drawn" ? "true" : "false"}
      data-required={state === "required" ? "true" : "false"}
      data-offered={state === "open" || state === "required" ? "true" : "false"}
      data-selectable={selectable ? "true" : "false"}
      data-focused={focused ? "true" : "false"}
      data-lattice-line={latticeLine ? "true" : "false"}
      onMouseEnter={onFocusBoard ? () => onFocusBoard(slot) : undefined}
      onFocus={onFocusBoard ? () => onFocusBoard(slot) : undefined}
      // `min-w-0`: a grid item defaults to `min-width: auto`, i.e. it refuses to
      // shrink below its own min-content width (the position label plus the
      // state chip). Without this the nine cards would push the lattice past the
      // viewport on a phone; with it the cards and their `aspect-square` cells
      // shrink to whatever the track gives them.
      className={`relative min-w-0 rounded-xl border p-1 transition sm:rounded-2xl sm:p-1.5 ${frame} ${
        highlight
          ? "ring-2 ring-amber-200/80"
          : focused
            ? "ring-1 ring-white/30"
            : state === "required"
              ? ""
              : ""
      }`}
    >
      <div className="relative mb-1 flex items-center justify-between gap-1">
        <span className="truncate text-[9px] font-bold uppercase tracking-wider text-white/45 sm:text-[10px]">
          {position}
        </span>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8.5px] font-black uppercase tracking-wider sm:text-[9.5px] ${
            latticeLine ? "border-emerald-300/60 bg-emerald-400/15 text-emerald-100" : CARD_BADGE[state]
          }`}
          style={ownerColour ? { background: ownerColour } : undefined}
          data-testid={`lattice-board-badge-${slot}`}
        >
          {latticeLine ? "Line" : boardStateBadge(state)}
        </span>
      </div>

      <div className="relative">
        {/* A CLAIMED or DRAWN board is covered: a dark wash plus the outcome
            blown up across the whole board. On a nine-board lattice the player
            needs to see which boards are gone without reading nine headers, and
            the giant glyph is the same silhouette (outline + seat colour) the
            cells use, so it reads as this game's own language rather than a
            badge. The wash is translucent, so the line that won the board is
            still visible underneath; the overlay itself is inert. */}
        <AnimatePresence>
          {(ownerMark || state === "drawn") && (
            <motion.div
              key={`overlay-${ownerMark ?? "draw"}`}
              aria-hidden="true"
              data-testid={`lattice-board-overlay-${slot}`}
              data-outcome={ownerMark ?? "draw"}
              {...withReducedMotion(reduceMotion, {
                initial: { opacity: 0 },
                animate: { opacity: 1 },
                exit: { opacity: 0 },
                transition: { duration: 0.22, ease: "easeOut" as const },
              })}
              className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center overflow-hidden rounded-[6px] bg-[#050a14]/60"
            >
              {ownerMark ? (
                <motion.span
                  {...withReducedMotion(reduceMotion, {
                    initial: { opacity: 0, scale: 0.55 },
                    animate: { opacity: 0.94, scale: 1 },
                    exit: { opacity: 0 },
                    transition: { type: "spring" as const, stiffness: 240, damping: 22 },
                  })}
                  className="flex h-[74%] w-[74%] items-center justify-center"
                  style={{ color: ownerColour ?? undefined }}
                >
                  <MarkGlyph mark={ownerMark} className="h-full w-full" />
                </motion.span>
              ) : (
                <span className="rotate-[-8deg] text-[13px] font-black uppercase tracking-[0.28em] text-white/70 sm:text-base">
                  Draw
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <TicTacToeBoard
          board={board.cells}
          winningLine={board.winningLine}
          control={board.control}
          boardIndex={slot}
          megaLine={latticeLine}
          state={state}
          compact
          label={cardLabel}
          lastMove={(lastMove as { boardIndex?: unknown } | null)?.boardIndex === slot ? lastMove : null}
          viewerSeat={viewerSeat}
          viewerCanMove={selectable}
          busy={busy}
          pendingCell={pendingCell}
          className="relative"
          onPlay={(cellIndex) => onPlay(slot, cellIndex)}
        />
      </div>
    </motion.div>
  );
}

function MegaBoard({
  boards,
  winningBoards,
  lastMove,
  nextBoard = null,
  playableBoards,
  status,
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
  const reduce = useReducedMotion();
  const lattice = useMemo(() => normaliseLattice(boards), [boards]);
  const slots = latticeSlots();
  const winningSlots = normaliseWinningBoards(winningBoards);
  const winningSet = winningBoardSet(winningBoards);
  const progress = latticeProgress(boards);

  // The destination and the playable set come straight from the server's own
  // derived fields — the same ones `validateMove` enforces.
  const snapshot = useMemo(
    () => ({ boards, nextBoard, playableBoards, status, viewerCanMove, lastMove }),
    [boards, nextBoard, playableBoards, status, viewerCanMove, lastMove],
  );
  const required = requiredBoard(snapshot);
  const freeChoice = isFreeChoice(snapshot);
  const offered = playableLatticeBoards(snapshot);
  const chip = destinationChip(snapshot);

  const winningMark = winningSlots.length ? lattice[winningSlots[0]]?.control ?? null : null;

  // The lattice win overlay: one line between the first and last winning board's
  // centres, in the winner's colour. The grid is always 3x3, so a slot's index
  // IS its row-major position in that grid.
  let overlay: { x1: number; y1: number; x2: number; y2: number; color: string } | null = null;
  if (winningSlots.length === 3) {
    const first = slotGridPosition(winningSlots[0]);
    const last = slotGridPosition(winningSlots[2]);
    overlay = {
      x1: ((first.col + 0.5) / first.cols) * 100,
      y1: ((first.row + 0.5) / first.rows) * 100,
      x2: ((last.col + 0.5) / last.cols) * 100,
      y2: ((last.row + 0.5) / last.rows) * 100,
      color: seatColor(winningMark === "O" ? "player2" : "player1"),
    };
  }

  const focused = focusedBoard !== null && slots.includes(focusedBoard) ? focusedBoard : null;

  return (
    <div
      data-testid="tic-tac-toe-mega"
      data-cols={LATTICE_COLUMNS}
      data-required-board={required ?? ""}
      data-free-choice={freeChoice ? "true" : "false"}
      className={className}
    >
      {/* ── The live destination, and how far the match has gone ─────────── */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p
          data-testid="lattice-destination"
          data-required={required ?? ""}
          data-free-choice={freeChoice ? "true" : "false"}
          // Announced politely: the destination changes on every accepted move,
          // and a screen reader must hear it without stealing focus.
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
            required !== null
              ? "border-amber-300/60 bg-amber-400/10 text-amber-100"
              : freeChoice
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-100"
                : "border-white/10 bg-white/5 text-white/60"
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              required !== null
                ? "animate-pulse bg-amber-300"
                : freeChoice
                  ? "bg-emerald-300"
                  : "bg-white/30"
            }`}
          />
          {chip}
        </p>
        <span data-testid="lattice-progress" className="text-[11px] tabular-nums text-white/40">
          {progress.label}
        </span>
      </div>

      {/* ── The lattice win ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {winningSet.size === 3 && (
          <motion.p
            key="lattice-win"
            data-testid="mega-win-line"
            {...withReducedMotion(reduce, {
              initial: { opacity: 0, scale: 0.96 },
              animate: { opacity: 1, scale: 1 },
              exit: { opacity: 0 },
              transition: { type: "spring" as const, stiffness: 320, damping: 24 },
            })}
            className="mb-2 rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-2.5 py-1.5 text-center text-xs font-black uppercase tracking-[0.2em] text-emerald-100"
          >
            Line — {winningMark ?? "X"} wins the match
            <span className="mt-0.5 block text-[10px] font-semibold tracking-normal text-emerald-200/80">
              {winningSlots.map((slot) => boardName(slot)).join(" · ")}
            </span>
          </motion.p>
        )}
      </AnimatePresence>

      {/* ── The board ────────────────────────────────────────────────────── */}
      {/* The lattice fits its column whatever the width (see `.mega-lattice` in
          globals.css), so a phone never scrolls sideways and all nine boards
          stay visible. `overflow-x-auto` is only a safety net for a
          pathological viewport.

          HEIGHT, not just width: on a laptop the nine boards were sized by the
          column alone, so the bottom row sat below the fold and the player had
          to scroll mid-turn to reach it. The cap below is the SHORTEST of the
          column and the room left under the page chrome, floored so a short
          window shrinks the board rather than crushing it.

          The width also reserves 20px, not the full column: on a phone the last
          row was ending within a pixel or two of (or just past) the viewport,
          so a slight inset keeps every cell reachable without shrinking them
          below the tap target.

          The 420px height reserve is MEASURED, not guessed: the QA harness
          mounts the shipped page's own chrome (header, seat cards, turn
          guidance, the controls box) and reports what it costs — 363px above
          the lattice on a desktop column. That leaves the boards as large as
          they can be while the bottom row still ends inside the fold, INCLUDING
          the ~50px the transient "X claims the board!" banner adds for its two
          seconds. It is 25px tighter than the 445px figure it replaces, which is
          what buys the extra size (a 480px lattice and ~45px cells at 1280×900,
          up from 455px and 40px). */}
      <div className="overflow-x-auto pb-1">
        <div
          className="mega-lattice relative mx-auto w-full"
          data-cols={LATTICE_COLUMNS}
          style={{ maxWidth: "min(calc(100% - 20px), max(300px, calc(100svh - 420px)))" }}
        >
          {/* The large board's own frame: it is what makes nine separate boards
              read as ONE 3x3 game, and it carries the winning line. */}
          <div className="relative rounded-2xl border border-white/10 bg-[#070b16]/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_24px_60px_-40px_rgba(0,0,0,0.95)] sm:rounded-[20px] sm:p-1.5">
            <div className="relative">
              <div
                className="grid gap-1.5 sm:gap-2"
                style={{ gridTemplateColumns: `repeat(${LATTICE_COLUMNS}, minmax(0, 1fr))` }}
                aria-label="Ultimate Tic-Tac-Toe board — nine mini-boards"
              >
                {slots.map((slot) => {
                  const board = lattice[slot];
                  const state = boardState({
                    control: board.control,
                    required: required === slot,
                    offered: offered.includes(slot),
                  });
                  return (
                    <BoardCard
                      key={slot}
                      board={board}
                      slot={slot}
                      state={state}
                      latticeLine={winningSet.has(slot)}
                      selectable={viewerCanMove && offered.includes(slot) && state !== "waiting"}
                      focused={focused === slot}
                      highlight={highlightSlot === slot}
                      viewerSeat={viewerSeat}
                      busy={busy}
                      pendingCell={pending && pending.boardIndex === slot ? pending.cellIndex : null}
                      lastMove={lastMove}
                      reduceMotion={Boolean(reduce)}
                      onFocusBoard={onFocusBoard}
                      onPlay={onPlay}
                    />
                  );
                })}
              </div>

              {overlay && (
                <svg
                  data-testid="mega-winning-line"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  {/* Dark casing under the animated line, so the outcome reads
                      over three different card grounds without a glow. */}
                  <line
                    x1={overlay.x1}
                    y1={overlay.y1}
                    x2={overlay.x2}
                    y2={overlay.y2}
                    stroke="var(--gr-outline, #05101f)"
                    strokeWidth="7"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    opacity="0.7"
                  />
                  <motion.line
                    x1={overlay.x1}
                    y1={overlay.y1}
                    x2={overlay.x2}
                    y2={overlay.y2}
                    stroke={overlay.color}
                    strokeWidth="3"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    {...withReducedMotion(reduce, {
                      initial: { opacity: 0 },
                      animate: { opacity: 0.95 },
                      transition: { duration: 0.4, ease: "easeOut" as const },
                    })}
                  />
                </svg>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── How to play ──────────────────────────────────────────────────── */}
      <ul
        data-testid="lattice-rules"
        className="mt-2.5 grid gap-x-4 gap-y-1 text-[10.5px] leading-snug text-white/45 sm:grid-cols-3 sm:text-[11px]"
      >
        {HOW_TO_PLAY.map((line, index) => (
          <li key={line} className="flex items-start gap-1.5">
            <span
              aria-hidden="true"
              className="mt-[3px] inline-block h-1 w-1 shrink-0 rounded-full bg-amber-300/70"
              data-step={index + 1}
            />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The lattice is a pure function of its props and the page re-renders on every
// poll tick; memoising keeps the nine boards from reconciling when the snapshot
// did not change.
export default memo(MegaBoard);
