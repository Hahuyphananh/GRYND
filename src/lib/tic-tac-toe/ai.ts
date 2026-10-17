// src/lib/tic-tac-toe/ai.ts
//
// The Tic-Tac-Toe practice bot. PURE and deterministic under an injected
// `random`, exactly like every other GRYND AI: the store passes the state and
// the bot's seat, and gets back ONE legal (board, cell) move. No database, no
// I/O.
//
// Two layers live here:
//
//   • `chooseAiCell` — the single 3x3 board solver. It is the shared, tested
//     minimax used for one mini-board, and it is what keeps a tiered opponent
//     (easy = random, normal = shallow, hard = full depth with a small slip)
//     available for an ordinary 3x3 board.
//   • `chooseAiMove` — the Ultimate chooser. It enumerates every move the RULES
//     allow (which means it respects the forced destination), runs the real
//     `applyMove` on each candidate and scores the resulting position. So it
//     never re-implements a rule: the engine decides legality, board claims,
//     lattice lines and the draw, and the bot only ranks the outcomes.
//
// Skill tiers come from the shared scale (src/lib/aiDifficulty.ts), and they
// are separated on TWO axes so the picker visibly changes the game:
//
//   • easy   — a uniformly random legal move (no lookahead at all).
//   • normal — a shallow search on a single board, so it misses some threats.
//   • hard   — full-depth analysis with a small slip, so it is very strong but
//              no longer literally unbeatable.

import { CELL_COUNT, LATTICE_LINES, WINNING_LINES } from "./constants";
import { chooseAiOption, coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";
import { applyMove, markForSeat, otherSeat, playableBoardIndexes } from "./rules";
import type { Cell, Mark, Seat, SmallBoard, TicTacToeState } from "./types";

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
 * Pick the bot's next cell on ONE 3x3 board. Returns a 0..8 index, or null when
 * the board is full (the caller treats that as "nothing to play").
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

// ── Ultimate move selection ───────────────────────────────────────────────
//
// `chooseAiCell` reasons about ONE mini-board. An Ultimate match adds a forced
// destination and a lattice win, so the store needs a chooser that picks a
// (boardIndex, cellIndex) pair against the whole match. It reuses the same pure
// machinery: it enumerates every move the RULES allow, runs the REAL `applyMove`
// on each and scores the resulting position, so a move that claims a board,
// blocks the opponent's finish or completes a lattice line is preferred without
// a second rules implementation.

/** One candidate move on the match: always one of the nine real mini-boards. */
export type AiMove = { boardIndex: number; cellIndex: number };

/**
 * Every move the seat to move is allowed to make, in a stable order.
 *
 * `playableBoardIndexes` is the same derivation `validateMove` uses, so during a
 * forced destination the bot is offered ONLY that board — it can never name a
 * completed/drawn board, a board it is not allowed to play, or an occupied cell.
 */
function legalMoves(state: TicTacToeState): AiMove[] {
  if (!state || state.phase === "finished") return [];
  const out: AiMove[] = [];
  for (const boardIndex of playableBoardIndexes(state)) {
    // A legacy row can hold an un-materialised slot; the engine reads it as an
    // empty, active board, so the bot must offer its nine cells too.
    const cells = state.boards?.[boardIndex]?.cells;
    for (let cellIndex = 0; cellIndex < CELL_COUNT; cellIndex += 1) {
      if (!cells || cells[cellIndex] === null) out.push({ boardIndex, cellIndex });
    }
  }
  return out;
}

/** True when `seat` has a move that ends the whole match right now. */
function canFinish(state: TicTacToeState, seat: Seat): boolean {
  if (!state || state.phase === "finished") return false;
  for (const move of legalMoves(state)) {
    const applied = applyMove({ state, seat, boardIndex: move.boardIndex, cellIndex: move.cellIndex });
    if (applied.matchCompleted) return true;
  }
  return false;
}

// ── Position evaluation ───────────────────────────────────────────────────
//
// These read ONLY the visible, authoritative state — no hidden information, no
// lookahead past what a human reading the board could see. They turn the
// one-ply score into a lattice-aware one: board control, latent lattice lines
// (two claimed boards plus the open third) and the board-count differential.
// They never decide a result; the server still does.

/**
 * How many lattice lines are one claimed board away from `mark`: exactly two
 * slots claimed by `mark` and the third still active. A line whose third slot
 * is drawn or taken by the opponent is dead and uncounted.
 */
function latticeThreatCount(boards: (SmallBoard | null)[], mark: Mark): number {
  let threats = 0;
  for (const line of LATTICE_LINES) {
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

/** Claimed-board differential: boards we own minus boards the opponent owns. */
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
 * Pick the bot's next move on an Ultimate match. Returns null only when there
 * is no legal move (which cannot happen while the match is `playing`) or when
 * the match is already finished.
 *
 * Each candidate is run through the REAL engine (`applyMove`), so a mini-board
 * claim, a draw, a forced destination and a lattice line all resolve exactly as
 * the server would. The one-ply score then rewards:
 *
 *   • ending the match outright above all;
 *   • claiming the mini-board it lands on, or drawing it (a useful lock);
 *   • creating our lattice threats and denying the opponent's;
 *   • owning more mini-boards;
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
    // Ending the match outright — a lattice line or the draw that finishes the
    // last board — dominates everything else.
    if (applied.matchCompleted) {
      score += 1_000_000;
    } else {
      // What did this move do to the board it landed on? A move can only ever
      // finish OUR line or fill the board to a draw; it can never hand control
      // to the opponent.
      const target = applied.state.boards?.[move.boardIndex];
      if (target?.control === aiMark) score += 12_000;
      else if (target?.control === "draw") score += 400;

      // A move that hands the opponent an immediate finish is almost never
      // right — checked with the real engine, so it covers a mini-board claim
      // that completes their lattice line as well as a direct match win.
      if (canFinish(applied.state, opponent)) {
        score -= 500_000;
      } else {
        const next = applied.state;
        // Owning more mini-boards is how a lattice line is built.
        score += boardControlBalance(next.boards, seat) * 300;
        // Our latent lattice lines are good; the opponent's are a real danger.
        score += latticeThreatCount(next.boards, aiMark) * 5_000;
        score -= latticeThreatCount(next.boards, oppMark) * 6_000;
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
