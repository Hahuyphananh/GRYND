import { Chess } from "chess.js";

// Both boards render the alias "start" until the authoritative FEN arrives,
// and chess.js rejects that alias (it wants a real six-field FEN) — so every
// helper normalizes the position before loading it.
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function toFen(position) {
  return position === "start" ? START_FEN : position;
}

/**
 * Legal destinations for `square` in `position`, each tagged with whether it
 * captures a piece.
 *
 * Returns [] when the square holds nothing playable — an empty square, an
 * opponent's piece, or a position where it is not that side's turn. chess.js v1
 * THROWS on a malformed position, so a stale board reads as "no targets"
 * instead of escaping the click handler.
 *
 * @param {string} position FEN (or "start")
 * @param {string|null} square e.g. "e2"
 * @returns {{ to: string, capture: boolean }[]}
 */
export function legalTargetsFrom(position, square) {
  // A missing position is a stale board, never the start position: chess.js
  // would happily load its own default and highlight a position the board is
  // not showing.
  if (!square || !position) return [];
  try {
    return new Chess(toFen(position))
      .moves({ square, verbose: true })
      .map((move) => ({ to: move.to, capture: Boolean(move.captured) }));
  } catch {
    return [];
  }
}

/**
 * True when the move `from` → `to` is a pawn stepping onto the far rank, i.e.
 * it needs a promotion piece before it can be played. The piece is read off the
 * position, so it works for both colours and never guesses from the player's
 * seat.
 *
 * @param {string} position FEN (or "start")
 * @param {string|null} from
 * @param {string|null} to
 */
export function isPromotionMove(position, from, to) {
  if (!position || !from || !to) return false;
  if (to[1] !== "1" && to[1] !== "8") return false;
  try {
    return new Chess(toFen(position)).get(from)?.type === "p";
  } catch {
    return false;
  }
}
