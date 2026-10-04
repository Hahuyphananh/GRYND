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

import { CELL_COUNT, WINNING_LINES } from "./constants";
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
