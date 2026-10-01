// src/lib/tic-tac-toe/ai.ts
//
// The Tic-Tac-Toe practice bot. PURE and deterministic under an injected
// `random`, exactly like every other GRYND AI: the store passes the board and
// the bot's seat, and gets back ONE legal cell index. No database, no I/O.
//
// Skill tiers come from the shared scale (src/lib/aiDifficulty.ts):
//   • easy   — a uniformly random legal cell (no lookahead at all).
//   • normal — perfect search with the shared ~12% slip, so it is beatable.
//   • hard   — perfect search (never loses; draws a perfect opponent).
//
// The search is full-depth minimax over at most 9 cells, which is cheap and
// makes `hard` provably optimal — exactly the behaviour players expect from a
// "hard" tic-tac-toe opponent.

import { CELL_COUNT, WINNING_LINES } from "./constants";
import { chooseAiOption, coerceAiDifficulty } from "../aiDifficulty";
import { markForSeat, otherSeat } from "./rules";
import type { Cell, Mark, Seat } from "./types";

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
): number {
  const winner = findWinner(board);
  if (winner === aiMark) return 10 - depth;
  if (winner !== null) return depth - 10;

  const legal = emptyCells(board);
  if (legal.length === 0) return 0;

  const opponent: Mark = turn === "X" ? "O" : "X";
  let best = turn === aiMark ? -Infinity : Infinity;
  for (const cell of legal) {
    board[cell] = turn;
    const score = minimax(board, aiMark, opponent, depth + 1);
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

  const aiMark = markForSeat(seat);
  const opponent = markForSeat(otherSeat(seat));
  const scoreOf = (cell: number): number => {
    const probe = [...board];
    probe[cell] = aiMark;
    return minimax(probe, aiMark, opponent, 1);
  };

  // `chooseAiOption` ranks by score and applies the tier's slip, so `normal`
  // occasionally takes a weaker (but never absurd) cell and `hard` always
  // takes the best one.
  const chosen = chooseAiOption(tier, legal, scoreOf, random);
  return chosen ?? legal[0];
}
