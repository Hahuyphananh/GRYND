// src/lib/tic-tac-toe/ai.ts
//
// The Tic-Tac-Toe practice bot. PURE and deterministic under an injected
// `random`, exactly like every other GRYND AI: the store passes the board and
// the bot's seat, and gets back ONE legal cell index. No database, no I/O.
//
// Skill tiers come from the shared scale (src/lib/aiDifficulty.ts), and they
// are separated on TWO axes so the picker visibly changes the game:
//
//   • easy   — a uniformly random legal cell (no lookahead at all).
//   • normal — a shallow search (a few plies), so it misses some threats.
//   • hard   — full-depth minimax with a small slip, so it is very strong but
//              no longer literally unbeatable.
//
// The DEPTH limit is what makes the weaker tiers actually lose. A pure minimax
// is unbeatable at full depth, and a small slip on top of a perfect search
// still draws almost every game — which is why `normal` and `hard` used to play
// indistinguishably. Searching only a few plies makes a weak tier miss the
// opponent's threats entirely, which is a real, visible weakness.

import { CELL_COUNT, SUDDEN_DEATH_BOARD_INDEX, WINNING_LINES } from "./constants";
import { chooseAiOption, coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";

/**
 * How many plies each tier searches before scoring statically.
 *
 * `hard` searches the whole game (a 9-cell board is cheap), so it sees every
 * threat. `normal` is deliberately short-sighted — it will miss a threat that
 * is more than a couple of moves away, which is a genuine, beatable weakness.
 */
const AI_LOOKAHEAD_PLIES: Partial<Record<AiDifficulty, number>> = {
  normal: 3,
};
import {
  activeBoardIndexes,
  applyMove,
  countCells,
  currentSuddenDeathBoard,
  markForSeat,
  megaLinesForStage,
  otherSeat,
} from "./rules";
import type { Cell, Mark, Seat, SmallBoard, TicTacToeState } from "./types";

/** The winning mark, or null. Repeated here so the bot never touches state. */
function findWinner(board: Cell[]): Mark | null {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    const mark = board[a];
    if (mark !== null && mark === board[b] && mark === board[c]) return mark;
  }
  return null;
}

function emptyCells(board: Cell[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELL_COUNT; i += 1) if (board[i] === null) out.push(i);
  return out;
}

/**
 * Minimax score for `aiMark` from `board`, with `turn` to move.
 *
 * Win is `10 - depth` so a faster win scores higher (and a slower loss scores
 * higher than a quick one); a draw is 0. Deterministic and side-effect free —
 * it mutates only its own scratch copy.
 */
function minimax(
  board: Cell[],
  aiMark: Mark,
  turn: Mark,
  depth: number,
  maxDepth = Infinity,
): number {
  const winner = findWinner(board);
  if (winner === aiMark) return 10 - depth;
  if (winner !== null) return depth - 10;

  const legal = emptyCells(board);
  if (legal.length === 0) return 0;
  // Depth-limited tiers stop here and score the position statically, so they
  // never see a threat that is further away than their horizon.
  if (depth >= maxDepth) return 0;

  const opponent: Mark = turn === "X" ? "O" : "X";
  let best = turn === aiMark ? -Infinity : Infinity;
  for (const cell of legal) {
    board[cell] = turn;
    const score = minimax(board, aiMark, opponent, depth + 1, maxDepth);
    board[cell] = null;
    best = turn === aiMark ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

/**
 * Pick the bot's next cell. Returns a 0..8 index, or null when the board is
 * full (the caller treats that as "nothing to play").
 *
 * `random` is injectable so the tests can pin the tier behaviour.
 */
export function chooseAiCell({
  board,
  seat,
  difficulty = "normal",
  random = Math.random,
}: {
  board: Cell[];
  seat: Seat;
  difficulty?: unknown;
  random?: () => number;
}): number | null {
  const legal = emptyCells(board);
  if (legal.length === 0) return null;

  const tier = coerceAiDifficulty(difficulty);
  // Easy ignores deduction entirely — a uniformly random empty cell.
  if (tier === "easy") {
    return legal[Math.min(legal.length - 1, Math.floor(random() * legal.length))];
  }

  // How many plies the tier looks ahead. `normal` sees a few moves and so
  // misses longer threats; `hard` searches the whole game.
  const maxDepth = AI_LOOKAHEAD_PLIES[tier] ?? Infinity;
  const aiMark = markForSeat(seat);
  const opponent = markForSeat(otherSeat(seat));
  const scoreOf = (cell: number): number => {
    const probe = [...board];
    probe[cell] = aiMark;
    return minimax(probe, aiMark, opponent, 1, maxDepth);
  };

  // `chooseAiOption` ranks by score and applies the tier's slip. Tic-tac-toe
  // scores are small integers (a win is 10 - depth, a draw 0), so the ratio
  // floor would misfire — it is disabled here, and the depth limit plus the
  // slip pool are what bound how bad a blunder can be.
  const chosen = chooseAiOption(tier, legal, scoreOf, random, 0);
  return chosen ?? legal[0];
}

// ── Mega-aware move selection ─────────────────────────────────────────────
//
// `chooseAiCell` reasons about ONE small board. A Mega match is a lattice of
// boards whose STATE changes when a board resolves and the match expands, so
// the store needs a chooser that picks a (boardIndex, cellIndex) pair against
// the whole match. It reuses the same pure machinery: it enumerates every
// legal move, runs the REAL `applyMove` on each and scores the resulting
// position, so a move that wins a board, blocks the opponent's finish or
// completes a Mega line is preferred without a second rules implementation.

/** One candidate move on the match. `boardIndex` is a slot (0..8), or the
 *  sudden-death sentinel (-1) while sudden death is live. */
export type AiMove = { boardIndex: number; cellIndex: number };

/** Every legal move for the side to play, in a stable order. */
function legalMoves(state: TicTacToeState): AiMove[] {
  const out: AiMove[] = [];
  const collect = (boardIndex: number, board: SmallBoard) => {
    for (let cellIndex = 0; cellIndex < CELL_COUNT; cellIndex += 1) {
      if (board.cells[cellIndex] === null) out.push({ boardIndex, cellIndex });
    }
  };
  const sudden = currentSuddenDeathBoard(state);
  if (state?.suddenDeath && sudden) {
    collect(SUDDEN_DEATH_BOARD_INDEX, sudden);
    return out;
  }
  for (const slot of activeBoardIndexes(state)) {
    const board = state.boards?.[slot];
    if (board) collect(slot, board);
  }
  return out;
}

/** True when `seat` has a move that ends the whole match right now. */
function canFinish(state: TicTacToeState, seat: Seat): boolean {
  for (const move of legalMoves(state)) {
    const applied = applyMove({ state, seat, boardIndex: move.boardIndex, cellIndex: move.cellIndex });
    if (applied.matchCompleted) return true;
  }
  return false;
}

// ── Mega position evaluation ──────────────────────────────────────────────
//
// These read ONLY the visible, authoritative state — no hidden information, no
// lookahead past what a human reading the board could see. They turn the
// one-ply score into a Mega-aware one: control of small boards, latent Mega
// lines (two controlled boards plus the open third), and a lean toward the
// final tiebreak. They never decide a result; the server still does.

/**
 * How many LIVE Mega lines are one controlled board away from `mark`: exactly
 * two slots controlled by `mark` and the third still active. A line whose
 * third slot is drawn or taken by the opponent is dead and uncounted.
 */
function megaThreatCount(boards: (SmallBoard | null)[], stage: unknown, mark: Mark): number {
  let threats = 0;
  for (const line of megaLinesForStage(stage)) {
    let mine = 0;
    let open = 0;
    for (const slot of line) {
      const control = boards?.[slot]?.control;
      if (control === mark) mine += 1;
      else if (control === "active") open += 1;
    }
    if (mine === 2 && open === 1) threats += 1;
  }
  return threats;
}

/** Controlled-board differential: boards we own minus boards the opponent owns. */
function boardControlBalance(boards: (SmallBoard | null)[], seat: Seat): number {
  const mine = markForSeat(seat);
  const theirs = markForSeat(otherSeat(seat));
  let diff = 0;
  for (const board of boards ?? []) {
    if (!board) continue;
    if (board.control === mine) diff += 1;
    else if (board.control === theirs) diff -= 1;
  }
  return diff;
}

/**
 * A lean toward the stage-3 tiebreak, MIRRORING `evaluateTiebreak`'s units:
 * only resolved boards count, board control by cell majority first, then the
 * total cell differential. This only biases which board/cell the bot plays —
 * the server computes the actual tiebreak.
 */
function tiebreakLean(boards: (SmallBoard | null)[], seat: Seat): number {
  const mine = markForSeat(seat);
  const theirs = markForSeat(otherSeat(seat));
  let boardsLed = 0;
  let cellDiff = 0;
  for (const board of boards ?? []) {
    if (!board || board.control === "active") continue;
    const x = countCells(board.cells, mine);
    const o = countCells(board.cells, theirs);
    cellDiff += x - o;
    if (x > o) boardsLed += 1;
    else if (o > x) boardsLed -= 1;
  }
  return boardsLed * 100 + cellDiff * 5;
}

/**
 * Pick the bot's next move on a Mega match. Returns null only when there is no
 * legal move (every board in play is resolved — which cannot happen while the
 * match is still `playing`) or when the match is already finished.
 *
 * The candidate set comes from `activeBoardIndexes`, so the bot can never name
 * a completed/drawn board, an un-materialised slot, or an occupied cell — and
 * during sudden death only the sentinel slot is offered. Each candidate is run
 * through the REAL engine (`applyMove`), so a small-board win, a draw, a stage
 * expansion, a Mega line and the tiebreak all resolve exactly as the server
 * would. The one-ply score then rewards:
 *
 *   • ending the match outright (a Mega win) above all;
 *   • controlling a small board (12k) — and a draw on it (a small lock);
 *   • creating our Mega threats and denying the opponent's;
 *   • controlling more boards and leaning into the final tiebreak;
 * and heavily punishes handing the opponent an immediate match win.
 *
 * `easy` plays a uniformly random legal move (no lookahead). `normal` and
 * `hard` rank the scored candidates through the shared tier policy, so the same
 * slip model that separates the per-board tiers separates them here too. All of
 * it stays a pure function of (state, seat, difficulty, random).
 */
export function chooseAiMove({
  state,
  seat,
  difficulty = "normal",
  random = Math.random,
}: {
  state: TicTacToeState;
  seat: Seat;
  difficulty?: unknown;
  random?: () => number;
}): AiMove | null {
  // A decided match has no move — the store never asks, but refusing here keeps
  // the chooser total and makes the "no legal move" contract a property of the
  // function rather than of its caller.
  if (!state || state.phase === "finished") return null;
  const moves = legalMoves(state);
  if (moves.length === 0) return null;

  const tier = coerceAiDifficulty(difficulty);
  if (tier === "easy") {
    return moves[Math.min(moves.length - 1, Math.floor(random() * moves.length))];
  }

  const opponent = otherSeat(seat);
  const aiMark = markForSeat(seat);
  const oppMark = markForSeat(opponent);
  const scoreOf = (move: AiMove): number => {
    const applied = applyMove({
      state,
      seat,
      boardIndex: move.boardIndex,
      cellIndex: move.cellIndex,
    });
    let score = 0;
    // Ending the match outright — a Mega line (or the stage-1 / sudden-death
    // board) — dominates everything else.
    if (applied.matchCompleted) {
      score += 1_000_000;
    } else {
      // What did this move do to the board it landed on? A move can only ever
      // finish OUR line or fill the board to a draw; it can never hand control
      // to the opponent.
      const target =
        move.boardIndex === SUDDEN_DEATH_BOARD_INDEX
          ? currentSuddenDeathBoard(applied.state)
          : applied.state.boards?.[move.boardIndex];
      if (target?.control === aiMark) score += 12_000;
      else if (target?.control === "draw") score += 400;

      // A move that hands the opponent an immediate finish is almost never
      // right — checked with the real engine, so it covers a board win that
      // completes their Mega line as well as a direct match win.
      if (canFinish(applied.state, opponent)) {
        score -= 500_000;
      } else {
        const next = applied.state;
        // Controlling more small boards is how a Mega line is built.
        score += boardControlBalance(next.boards, seat) * 300;
        // Our latent Mega lines are good; the opponent's are a real danger.
        score += megaThreatCount(next.boards, next.stage, aiMark) * 5_000;
        score -= megaThreatCount(next.boards, next.stage, oppMark) * 6_000;
        // Late in a full Round 3, the tiebreak is what decides it.
        score += tiebreakLean(next.boards, seat);
      }
    }
    // Positional preference inside the target board (centre > corner > edge).
    const cell = move.cellIndex;
    if (cell === 4) score += 30;
    else if (cell === 0 || cell === 2 || cell === 6 || cell === 8) score += 20;
    else score += 10;
    return score;
  };

  const chosen = chooseAiOption(tier, moves, scoreOf, random, 0);
  return chosen ?? moves[0];
}

