// src/lib/keno-pvp/engine.js
//
// Pure game-logic for the Keno PvP ("Keno Catch Duel") match system —
// no DB, no side effects, fully unit-testable. The server store calls
// these helpers to stay authoritative; the client imports the same
// timing helpers (ballSchedule / gradeCatch) so its animations and
// the server's grading always agree.
//
// The skill model: both players face the SAME 10-ball draw. A ball is
// catchable for a short window after release and the server grades the
// tap against the ball's ideal catch instant:
//   perfect — inside PERFECT_WINDOW_MS of the ideal instant (+bonus)
//   good    — inside GOOD_WINDOW_MS of the ideal instant
//   late    — any time before the ball expires (+ a lag grace window)
//   miss    — the window passed without a catch
// Round score = keno multiplier for the number caught (catching more
// compounds: 5 balls = 50, 10 balls = 5000) + PERFECT_BONUS per
// perfect catch. Catching more dominates, timing refines.

import {
  BALL_COUNT,
  BALL_INTERVAL_MS,
  BALL_TTL_MS,
  BOT_CATCH_CHANCE,
  CATCH_GRACE_MS,
  GOOD_WINDOW_MS,
  IDEAL_CATCH_MS,
  KENO_POOL_SIZE,
  MAX_ROUNDS,
  PERFECT_BONUS,
  PERFECT_WINDOW_MS,
  RESULT,
  ROUNDS_TO_WIN,
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

// ── Ball release schedule ────────────────────────────────────────────
//
// The round deadline (match.round_deadline) is set when the round
// opens and equals openTime + ROUND_MS. Ball i (0-based) is released
// at `deadline - ROUND_MS + i * BALL_INTERVAL_MS`, its ideal catch
// instant is IDEAL_CATCH_MS later, and it expires BALL_TTL_MS after
// release. Both clients derive the SAME schedule from the same
// deadline, so the stream is identical for both players.

/**
 * Compute the release schedule for a round given its deadline (ms).
 * Returns an array of { index, number, releaseMs, idealMs, expiresMs,
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
      idealMs: releaseMs + IDEAL_CATCH_MS,
      expiresMs: releaseMs + BALL_TTL_MS,
      acceptedUntilMs: releaseMs + BALL_TTL_MS + CATCH_GRACE_MS,
    };
  });
}

// ── Catch-quality grading ────────────────────────────────────────────
//
// Quality tiers (also the vocabulary stored in the catches jsonb):
//   'perfect' — |now - ideal| <= PERFECT_WINDOW_MS
//   'good'    — |now - ideal| <= GOOD_WINDOW_MS
//   'late'    — now in [release, acceptedUntil] (missed the sweet spot)
//   null      — too early (before release) or expired (past
//               acceptedUntilMs)

export const CATCH_QUALITY = Object.freeze({
  PERFECT: "perfect",
  GOOD: "good",
  LATE: "late",
});

/**
 * Grade a catch attempt at `caughtAtMs` for the given ball window.
 * Returns one of CATCH_QUALITY values, or null when the ball is not
 * catchable at that instant (too early / expired).
 */
export function gradeCatch(caughtAtMs, ball) {
  const at = Number(caughtAtMs);
  if (!Number.isFinite(at)) return null;
  if (!ball || !Number.isFinite(ball.releaseMs)) return null;
  if (at < ball.releaseMs || at > ball.acceptedUntilMs) return null;
  const diff = Math.abs(at - ball.idealMs);
  if (diff <= PERFECT_WINDOW_MS) return CATCH_QUALITY.PERFECT;
  if (diff <= GOOD_WINDOW_MS) return CATCH_QUALITY.GOOD;
  return CATCH_QUALITY.LATE;
}

// ── Round scoring ────────────────────────────────────────────────────

/** Value of a single catch by quality (perfect adds the timing bonus). */
export function catchValue(quality) {
  if (quality === CATCH_QUALITY.PERFECT) return PERFECT_BONUS;
  return 0;
}

/**
 * Compute a player's round stats from their catches array (each entry
 * { number, quality, caughtAt }):
 *   { caught, perfects, score }
 * score = getKenoMultiplier(caught, caught) + PERFECT_BONUS * perfects.
 * The keno multiplier for "all N caught" is the classic house table
 * (1→3, 5→50, 10→5000) — catching more compounds exponentially.
 */
export function computeRoundStats(catches) {
  const list = Array.isArray(catches) ? catches : [];
  // Only well-formed catch entries count (defensive: the server never
  // writes nulls, but a malformed payload must not skew the score).
  const valid = list.filter(
    (c) => c && Number.isInteger(Number(c.number)) && typeof c.quality === "string",
  );
  const caught = valid.length;
  const perfects = valid.filter(
    (c) => c.quality === CATCH_QUALITY.PERFECT,
  ).length;
  const multiplier = caught > 0 ? getKenoMultiplier(caught, caught) || 0 : 0;
  return {
    caught,
    perfects,
    score: multiplier + PERFECT_BONUS * perfects,
  };
}

/**
 * Decide who wins a round given both players' catches.
 * Highest score wins; score tie → more perfect catches; still tied →
 * more caught balls; otherwise the round is a DRAW (no round-win for
 * either side).
 */
export function decideRoundWinner(p1Catches, p2Catches) {
  const p1 = computeRoundStats(p1Catches);
  const p2 = computeRoundStats(p2Catches);
  if (p1.score > p2.score) return RESULT.PLAYER1;
  if (p2.score > p1.score) return RESULT.PLAYER2;
  if (p1.perfects > p2.perfects) return RESULT.PLAYER1;
  if (p2.perfects > p1.perfects) return RESULT.PLAYER2;
  if (p1.caught > p2.caught) return RESULT.PLAYER1;
  if (p2.caught > p1.caught) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

// ── Match result ─────────────────────────────────────────────────────

/**
 * Decide the MATCH result from the round-win tallies:
 *   * Either side reached ROUNDS_TO_WIN → they win the match.
 *   * 5 rounds level → higher aggregate round score wins.
 *   * Still level → DRAW (full refund, no rake).
 */
export function decideMatchResult({ roundsWonPlayer1, roundsWonPlayer2, p1Score, p2Score }) {
  const r1 = Number(roundsWonPlayer1) || 0;
  const r2 = Number(roundsWonPlayer2) || 0;
  if (r1 >= ROUNDS_TO_WIN) return RESULT.PLAYER1;
  if (r2 >= ROUNDS_TO_WIN) return RESULT.PLAYER2;
  const s1 = Number(p1Score) || 0;
  const s2 = Number(p2Score) || 0;
  if (s1 > s2) return RESULT.PLAYER1;
  if (s2 > s1) return RESULT.PLAYER2;
  return RESULT.DRAW;
}

// ── Practice bot ─────────────────────────────────────────────────────

/**
 * Generate the practice bot's catches for the balls that have already
 * passed their ideal instant (elapsed = now - roundOpen). Each ball is
 * caught with BOT_CATCH_CHANCE at a random quality (weighted toward
 * good/late so the bot feels human). Returns an array of catch entries
 * shaped like a real player's catches ({ number, quality, caughtAt }),
 * EXCLUDING balls the bot already caught (pass those in `alreadyCaught`
 * as the set of numbers it has).
 */
export function botCatchesForElapsed(schedule, elapsedMs, alreadyCaught = []) {
  const caughtSet = new Set(alreadyCaught);
  const out = [];
  for (const ball of schedule) {
    if (caughtSet.has(ball.number)) continue;
    if (elapsedMs < ball.idealMs) continue; // ball not catchable yet
    if (Math.random() >= BOT_CATCH_CHANCE) continue; // bot drops it
    const roll = Math.random();
    let quality;
    let caughtAtMs;
    if (roll < 0.3) {
      quality = CATCH_QUALITY.PERFECT;
      caughtAtMs = ball.idealMs + (Math.random() * 2 - 1) * PERFECT_WINDOW_MS * 0.8;
    } else if (roll < 0.75) {
      quality = CATCH_QUALITY.GOOD;
      caughtAtMs = ball.idealMs + (Math.random() * 2 - 1) * GOOD_WINDOW_MS * 0.8;
    } else {
      quality = CATCH_QUALITY.LATE;
      caughtAtMs =
        ball.idealMs +
        GOOD_WINDOW_MS +
        Math.random() *
          Math.max(0, ball.expiresMs - ball.idealMs - GOOD_WINDOW_MS);
    }
    // Never let the bot appear to catch a ball in the future.
    out.push({
      number: ball.number,
      quality,
      caughtAt: new Date(Math.min(caughtAtMs, elapsedMs)).toISOString(),
    });
  }
  return out;
}

// Re-export the multiplier table lookup so routes/tests use the same
// source of truth as the solo-kneo scoring.
export { getKenoMultiplier };
export { MAX_ROUNDS, ROUNDS_TO_WIN };
