// src/lib/battleship/timeouts.ts
//
// PURE timeout policy for Battleship — no database, no I/O, and ONE deliberate
// impure function that takes its randomness from node:crypto.
//
// ── WHY THE RANDOM PICK LIVES HERE AND TAKES A RANDOM SOURCE ──────────────
//
// An attack timeout must produce a LEGAL shot: a uniformly random cell that this
// seat has never fired at. That is one small function, and tests must be able to
// pin it — so `randomInt` is injectable and the production default is
// `crypto.randomInt`, which is uniform and server-side. The browser NEVER picks
// the cell; the client only displays the server's countdown.
//
// ── POLICY ────────────────────────────────────────────────────────────────
//
//   PLACEMENT (60 s): a seat that has no confirmed fleet by the deadline cannot
//   be given one (inventing or dealing a fleet for someone is explicitly not
//   allowed), so the match is settled the way GRYND settles an absent player:
//   the seat still present is awarded the win. If BOTH seats are missing, there
//   is nobody to award it to and the match is CANCELLED (the platform's
//   `timeout` cancel reason), never invented as a draw win.
//
//   ATTACK (15 s): a seat that has not locked is given one automatic random
//   legal attack, recorded as a timeout attack, and the round resolves together
//   with the opponent's — including when the opponent's shot was manual.
//
//   REPEATED TIMEOUTS: every automatic attack increments that seat's
//   consecutive-timeout counter; a manual attack resets it to zero. Two
//   consecutive automatic attacks forfeit the match to the opponent (the same
//   forfeit settlement path every other game uses). If BOTH seats reach the
//   threshold in the same round, the result is a deterministic DRAW — no winner
//   is invented and no player is punished for the other's absence.

import { randomInt } from "node:crypto";

import { COLUMNS, ROWS, SEATS } from "./constants";
import type { Seat } from "./types";

/** Consecutive automatic attacks that forfeit a match (no platform policy exists). */
export const TIMEOUT_FORFEIT_THRESHOLD = 2;

/** Reconnection grace before an absent player forfeits, matching the platform. */
export const DISCONNECT_GRACE_SECONDS = 30;

/** Every printable cell, in board order ("A1" … "J10"). */
export function allCoordinates(): string[] {
  const coordinates: string[] = [];
  for (const row of ROWS) {
    for (const column of COLUMNS) coordinates.push(`${column}${row}`);
  }
  return coordinates;
}

/** Every cell this seat has NOT fired at yet, in board order. */
export function untriedCoordinates(attacked: readonly string[]): string[] {
  const seen = new Set(attacked.map((coordinate) => String(coordinate).toUpperCase()));
  return allCoordinates().filter((coordinate) => !seen.has(coordinate));
}

/** A uniform integer in `[0, maxExclusive)`. Injectable so tests can pin it. */
export type RandomInt = (maxExclusive: number) => number;

/** Production randomness: node:crypto, never Math.random, never the client. */
export const serverRandomInt: RandomInt = (maxExclusive) => randomInt(0, maxExclusive);

/**
 * One uniformly random coordinate this seat has never attacked, or null when
 * the board is exhausted (all 100 cells fired — a match that long has already
 * ended, so null is a guard, not a policy).
 */
export function pickTimeoutCoordinate(
  attacked: readonly string[],
  randomInt: RandomInt = serverRandomInt,
): string | null {
  const candidates = untriedCoordinates(attacked);
  if (candidates.length === 0) return null;
  const raw = randomInt(candidates.length);
  const index =
    Number.isInteger(raw) && raw >= 0 && raw < candidates.length ? raw : 0;
  return candidates[index];
}

/** The counter after one attack: automatic increments, manual resets. */
export function nextConsecutiveTimeouts(consecutive: number, automatic: boolean): number {
  if (!automatic) return 0;
  return (Number.isFinite(consecutive) ? consecutive : 0) + 1;
}

/** Seats that have reached the forfeit threshold. */
export function timeoutForfeitSeats(consecutive: Record<Seat, number>): Seat[] {
  return SEATS.filter((seat) => (consecutive[seat] ?? 0) >= TIMEOUT_FORFEIT_THRESHOLD);
}

export type PlacementTimeoutVerdict =
  | { readonly action: "none" }
  | { readonly action: "forfeit"; readonly seat: Seat }
  | { readonly action: "cancel" };

/** What a missed 60-second placement deadline does. */
export function placementTimeoutVerdict(
  ready: Record<Seat, boolean>,
): PlacementTimeoutVerdict {
  const missing = SEATS.filter((seat) => !ready[seat]);
  if (missing.length === 0) return { action: "none" };
  if (missing.length === 2) return { action: "cancel" };
  return { action: "forfeit", seat: missing[0] };
}

/**
 * The result of BOTH seats reaching the timeout threshold in one round.
 * A draw is the only deterministic, non-arbitrary outcome: neither player was
 * present enough to win, and the engine's own mutual-destruction rule agrees.
 */
export function bothTimedOutResult(): "draw" {
  return "draw";
}
