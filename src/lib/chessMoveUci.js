/**
 * The one way a chess move is encoded as UCI for storage in
 * `chess_moves.move_uci`.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE EXPRESSION
 * ------------------------------------------------
 * `/api/chess/move` used to store `${from}${to}${promotion || ""}` using the
 * REQUEST's `promotion` field, which defaults to `"q"`. Every ordinary move was
 * therefore stored with a spurious promotion suffix — `"e2e4q"` instead of
 * `"e2e4"` — while Stockfish answers `bestmove e2e4`. The evaluator compares the
 * two byte-for-byte (src/lib/evaluation/games/chessEvaluator.ts), so no move
 * could ever be recognised as the engine's own choice and `bestMoves` was
 * structurally always 0.
 *
 * The fix is two rules, enforced HERE rather than at the call site:
 *
 *   1. The encoding describes the move the SERVER VALIDATED and applied — a
 *      chess.js `Move`, whose own `lan` field is already the UCI string
 *      (`e2e4`, `h7h8n`, `e1g1`, `e5d6`). Nothing the client sent is trusted as
 *      the source of truth; a client-supplied UCI string is never used, and the
 *      request's `promotion` default cannot leak into storage.
 *   2. The promotion suffix is emitted ONLY for a move that actually promotes,
 *      with the piece that was played. When the move carries chess.js's `flags`,
 *      the promotion flag (`p`) is required — so a stray `promotion` on an
 *      ordinary move is dropped rather than persisted.
 *
 * Format (UCI, lowercase): `e2e4`, `a7a8q`, `h7h8n`, `e1g1` (castling),
 * `e5d6` (en passant) — exactly what Stockfish prints for the same move.
 *
 * @param {{ lan?: string, from?: string, to?: string, promotion?: string, flags?: string } | null | undefined} move
 *   The validated move (a chess.js `Move` result). Anything that is not a
 *   well-formed square pair encodes to `""` rather than to a made-up string, so
 *   a malformed move can never be persisted as plausible-looking UCI.
 * @returns {string} The stored UCI string.
 */
export function toStoredUci(move) {
  if (!move || typeof move !== "object") return "";

  // chess.js renders the UCI string it validated itself — prefer it, so the
  // stored value can never drift from the move that was actually applied.
  const lan = String(move.lan ?? "")
    .trim()
    .toLowerCase();
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(lan)) return lan;

  // Fallback for a move object without `lan`: compose it from the validated
  // squares, and drop a promotion that chess.js did not flag as one.
  const from = String(move.from ?? "")
    .trim()
    .toLowerCase();
  const to = String(move.to ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return "";

  const flags = typeof move.flags === "string" ? move.flags : null;
  if (flags !== null && !flags.includes("p")) return `${from}${to}`;

  const promotion = String(move.promotion ?? "")
    .trim()
    .toLowerCase();
  const piece = /^[qrbn]$/.test(promotion) ? promotion : "";
  return `${from}${to}${piece}`;
}
