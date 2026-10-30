/**
 * Dominoes — the MATCH layer's pure arithmetic: cumulative points and who won.
 *
 * A round is one dealt set; a MATCH is a series of rounds played until one seat
 * reaches `MATCH_TARGET_POINTS` (50). Rounds are scored by `roundPoints` in
 * `./rules` (each seat scores the pips left in the opponent's hand); this module
 * is the only place those points are added up and compared, so the store, the
 * projection and the tests cannot disagree about who won.
 *
 * No randomness, no clock, no I/O: `matchVerdict` is a total function of the two
 * totals. ROUND outcomes stay on the engine's `DominoesOutcome`; this is the
 * separate, slower question of whether the MATCH is over.
 */

import { MATCH_TARGET_POINTS, SEATS } from "./constants";
import type { Seat } from "./types";

/** Cumulative points per seat across every completed round of a match. */
export type MatchScoreboard = Readonly<Record<Seat, number>>;

/** The match-level verdict: over or not, who won it, and whether it is tied up. */
export interface MatchVerdict {
  /** True once a seat LEADS with at least the target on its side. */
  readonly finished: boolean;
  /** The seat that won the match; `null` while playing and during a tiebreak. */
  readonly seat: Seat | null;
  /** `player1 | player2`, or `null` while the match is still live. */
  readonly result: string | null;
  /**
   * Both seats are at/above the target on LEVEL totals.
   *
   * Nobody may be declared the winner: the match continues with a TIEBREAK round
   * and is re-judged after every round until the totals are no longer level.
   */
  readonly tiebreak: boolean;
}

/** Normalise a stored/derived total to a non-negative integer. */
function totalOf(value: unknown): number {
  const total = Number(value);
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}

/** `true` when either seat has reached the target. */
export function isMatchTargetReached(scores: MatchScoreboard): boolean {
  return (
    totalOf(scores?.player1) >= MATCH_TARGET_POINTS ||
    totalOf(scores?.player2) >= MATCH_TARGET_POINTS
  );
}

/**
 * Did the match end, and who won it?
 *
 * The first seat to the target wins — which, because a BLOCKED round scores both
 * seats, can be both of them in the same round. There is no "first past the post"
 * ordering to lean on: the round awards points simultaneously, so the SCORE is
 * the only evidence, and the tie-break is therefore the score itself. When both
 * seats cross the target together, the higher final total wins.
 *
 * Totals can still be LEVEL at or above the target (46–46 scoring 4 each). That
 * is not a draw and it is not a win: the verdict says `tiebreak` and the match
 * goes on, round after round, until a round leaves the totals apart. Nothing here
 * ever invents a winner to break a tie — the tie has to be broken on the table.
 */
export function matchVerdict(scores: MatchScoreboard): MatchVerdict {
  const player1 = totalOf(scores?.player1);
  const player2 = totalOf(scores?.player2);
  if (player1 < MATCH_TARGET_POINTS && player2 < MATCH_TARGET_POINTS) {
    return Object.freeze({ finished: false, seat: null, result: null, tiebreak: false });
  }
  const seat = player1 > player2 ? SEATS[0] : player2 > player1 ? SEATS[1] : null;
  if (!seat) {
    // Level at or above the target: a tiebreak round, never a declared winner.
    return Object.freeze({ finished: false, seat: null, result: null, tiebreak: true });
  }
  return Object.freeze({ finished: true, seat, result: seat, tiebreak: false });
}
