// src/lib/keno-pvp/engine.js
//
// Pure game-logic for the Keno PvP ("Keno Catch Duel") match system —
// no DB, no side effects, fully unit-testable. The server store calls
// these helpers to stay authoritative; the client imports the same
// timing helpers (ballSchedule / gradeCatch) so its animations and
// the server's grading always agree.
//
// The skill model: both players face the SAME 10-tile draw. Tiles
// light up one at a time and each GLOWS for GLOW_MS (0.8s) — tap the
// glowing tile while it's lit to catch it. A tap after the glow fades
// is a miss (no points, tile turns red). Catching is binary: in the
// window or not.
// Round score = keno multiplier for the number caught (catching more
// compounds: 5 tiles = 50, 10 tiles = 5000). No timing bonus — the
// goal is to click the most tiles.
// Match result = first to POINTS_TO_WIN cumulative points.

import {
  BALL_COUNT,
  BALL_INTERVAL_MS,
  CATCH_GRACE_MS,
  GLOW_MS,
  KENO_POOL_SIZE,
  MAX_ROUNDS,
  POINTS_TO_WIN,
  RESULT,
  ROUND_MS,
} from "./constants";
import { getKenoMultiplier } from "../kenoMultipliers";

// ── Draw generation ──────────────────────────────────────────────────

/** Generate a fresh shared draw: BALL_COUNT unique numbers from the
 *  1..KENO_POOL_SIZE pool (Fisher-Yates partial shuffle). */
export function generateDraw() {
  const all = Array.from({ length: KENO_POOL_SIZE }, (_, i) => i + 1);
  for (let i = 0; i < BALL_COUNT; i += 1) {
    const j = i + Math.floor(Math.random() * (KENO_POOL_SIZE - i));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, BALL_COUNT);
}

// ── Tile glow schedule ───────────────────────────────────────────────
//
// The round deadline (match.round_deadline) is set when the round
// opens and equals openTime + ROUND_MS. Tile i (0-based) lights up at
// `deadline - ROUND_MS + i * BALL_INTERVAL_MS` and GLOWS for GLOW_MS:
//   expiresMs       = releaseMs + GLOW_MS            (the visible window)
//   acceptedUntilMs = expiresMs + CATCH_GRACE_MS     (hidden network
//                      cushion — a tap sent while glowing still lands)
// The client drives its glow/ring visuals off expiresMs so the ring
// always empties at the visible 1s mark; the server grades against
// acceptedUntilMs so slow connections don't turn well-timed taps into
// false misses.
// Both clients derive the SAME schedule from the same deadline, so the
// glow-stream is identical for both players.

/**
 * Compute the glow schedule for a round given its deadline (ms).
 * Returns an array of { index, number, releaseMs, expiresMs,
 * acceptedUntilMs }.
 */
export function ballSchedule(roundDeadlineMs, draw) {
  const deadline = Number(roundDeadlineMs);
  if (!Number.isFinite(deadline)) return [];
  const numbers = Array.isArray(draw) ? draw : [];
  return numbers.slice(0, BALL_COUNT).map((number, i) => {
    const releaseMs = deadline - ROUND_MS + i * BALL_INTERVAL_MS;
    return {
      index: i,
      number: Number(number),
      releaseMs,
      expiresMs: releaseMs + GLOW_MS,
      acceptedUntilMs: releaseMs + GLOW_MS + CATCH_GRACE_MS,
    };
  });
}

// ── Catch grading (binary) ───────────────────────────────────────────
//
// Quality vocabulary stored in the catches jsonb. Grading is binary
// now — a tile is either caught inside its 0.8s glow window or missed.
// Successful catches are stored as 'good'; 'perfect'/'late' remain in
// the enum only so old resolved-round history keeps its shape.

export const CATCH_QUALITY = Object.freeze({
  PERFECT: "perfect",
  GOOD: "good",
  LATE: "late",
});

/**
 * Grade a catch attempt at `caughtAtMs` for the given tile window.
 * Returns CATCH_QUALITY.GOOD when the tap landed inside the catch
 * window [releaseMs, acceptedUntilMs] (the 0.8s glow plus the hidden
 * network grace), else null (too early / long past the glow).
 */
export function gradeCatch(caughtAtMs, ball) {
  const at = Number(caughtAtMs);
  if (!Number.isFinite(at)) return null;
  if (!ball || !Number.isFinite(ball.releaseMs)) return null;
  if (at < ball.releaseMs || at > ball.acceptedUntilMs) return null;
  return CATCH_QUALITY.GOOD;
}

// ── Round scoring ────────────────────────────────────────────────────

/**
 * Compute a player's round stats from their catches array (each entry
 * { number, quality, caughtAt }):
 *   { caught, perfects, score }
 * score = getKenoMultiplier(caught, caught) — the classic house table
 * (1→3, 5→50, 10→5000). Catching more compounds exponentially, so the
 * dominant strategy is to catch as many tiles as possible. There is no
 * timing bonus anymore (perfects is kept at 0 for shape compatibility).
 */
export function computeRoundStats(catches) {
  const list = Array.isArray(catches) ? catches : [];
  // Only well-formed catch entries count (defensive: the server never
  // writes nulls, but a malformed payload must not skew the score).
  const valid = list.filter(
    (c) => c && Number.isInteger(Number(c.number)) && typeof c.quality === "string",
  );
  const caught = valid.length;
  const multiplier = caught > 0 ? getKenoMultiplier(caught, caught) || 0 : 0;
  return {
    caught,
    perfects: 0,
    score: multiplier,
  };
}

/**
 * Decide who wins a round given both players' catches.
 * Highest score wins; an exact score tie is a DRAW (no round-win for
 * either side). The keno multiplier is strictly increasing in the
 * number caught, so a score tie implies an equal catch count — no
 * further tiebreaks exist.
 */
export function decideRoundWinner(p1Catches, p2Catches) {
  const p1 = computeRoundStats(p1Catches);
  const p2 = computeRoundStats(p2Catches);
  if (p1.score > p2.score) return RESULT.PLAYER1;
  if (p2.score > p1.score) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

// ── Match result ─────────────────────────────────────────────────────

/**
 * Decide the MATCH result from the cumulative round scores.
 *
 * The caller (serverStore.resolveRound) ends the match as soon as a
 * player's aggregate score reaches POINTS_TO_WIN; this function only
 * decides WHO wins the ended match:
 *   * Higher cumulative score wins.
 *   * Exact tie → DRAW (full refund, no rake).
 * `roundsWonPlayer1/2` are accepted for call-shape compatibility but
 * no longer influence the decision (round wins are display-only now).
 */
export function decideMatchResult({ roundsWonPlayer1, roundsWonPlayer2, p1Score, p2Score }) {
  const s1 = Number(p1Score) || 0;
  const s2 = Number(p2Score) || 0;
  if (s1 > s2) return RESULT.PLAYER1;
  if (s2 > s1) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

// Re-export the multiplier table lookup so routes/tests use the same
// source of truth as the solo-kneo scoring.
export { getKenoMultiplier };
export { MAX_ROUNDS, POINTS_TO_WIN };
