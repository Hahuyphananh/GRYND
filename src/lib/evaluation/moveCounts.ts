/**
 * Ply / full-move counting for the Game Evaluation feature — one documented
 * convention, shared by the evaluator, the service's user-facing messages and
 * the evaluation page.
 *
 * ── THE UNITS ───────────────────────────────────────────────────────────
 * A PLY is one player's move. A FULL MOVE is one White move plus one Black move
 * (chess's numbering unit, the number PGN prints in front of a move).
 *
 * The evaluation payload carries both, and they must never be confused:
 *
 *   - `plyCount`  — every individual move by both players. Grows by 1 per turn.
 *   - `moveCount` — COMPLETED FULL MOVES, i.e. `ceil(plyCount / 2)`.
 *
 * The convention is chess's own: the full-move number of ply `p` is
 * `ceil(p / 2)`, which is exactly what the evaluator already reports per move
 * (`moveNumber`) and what a PGN viewer shows. Rounding UP is what makes a game
 * whose last move was White's report the move number the player actually saw —
 * the 13-ply Légal's mate is 7 full moves, ending on move 7.
 *
 * Why this is a module rather than a formula at each call site: the payload, the
 * 422 message and the UI header all have to agree on the unit. Previously
 * `moveCount` and `plyCount` were both set to the ply count, so a 40-ply game
 * displayed as "40 moves played" and the too-short message named a unit it was
 * not counting.
 */

/**
 * Converts a ply count into completed full moves (`ceil(plies / 2)`).
 *
 * @param {number} plies Total individual moves by both players.
 * @returns {number} Full moves; 0 for a non-finite or non-positive count.
 */
export function fullMoveCount(plies: number): number {
  const n = Number(plies);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 2);
}
