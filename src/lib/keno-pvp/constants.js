// src/lib/keno-pvp/constants.js
//
// Shared constants + helpers for the PvP Keno ("Keno Catch Duel")
// match system. Built as a parallel to `src/lib/slots-pvp/constants.js`
// / `src/lib/mines-pvp/constants.js` so the match flow shares the same
// shape (status enum / timer / stake presets / advisory-lock namespace /
// RESULT enum) while the game logic is keno-specific.
//
// Game rules:
//   * First to POINTS_TO_WIN (10) cumulative points takes the pot —
//     the match ends as soon as a player's aggregate round score
//     reaches 10. Both players cross 10 in the same round? The higher
//     total wins; an exact tie is a DRAW (full refund, no rake).
//   * Match clock: rounds keep running up to MAX_ROUNDS (16, ≈ 3
//     minutes). If nobody reaches POINTS_TO_WIN by then, the match
//     enters a 30s OVERTIME countdown and the player with the most
//     tiles (highest cumulative score) wins when it ends. An
//     overtime tie is a DRAW that refunds each player 95% of their
//     stake (5% rake per side — 10% total).
//   * Every round BOTH players face the SAME shared draw: 10 unique
//     balls drawn from the 1-40 keno pool. The draw is generated
//     server-side when the round opens and its release schedule is
//     derived from the round deadline, so both clients render the
//     identical ball stream.
//   * Skill loop: the round is a shared GLOW-STREAM. Tiles light up
//     one at a time (BALL_INTERVAL_MS apart) and stay GLOWING for
//     GLOW_MS (0.8s). Tap the glowing tile while it's lit → catch it.
//     Tap it after the glow fades → nothing gained and the tile turns
//     red. Catching is binary — you're in the window or you're not;
//     there are no timing-quality tiers anymore. A small hidden
//     CATCH_GRACE_MS cushion absorbs network latency so taps that were
//     sent while the tile was visibly glowing still land (invisible to
//     players — the ring and glow end at GLOW_MS).
//   * Round score = the classic keno multiplier for the number caught
//     (KENO_MULTIPLIER_TABLE — catching 5 is worth 50, catching 10 is
//     worth 5000, so every extra catch compounds). Catching more
//     dominates — the goal is to click the most tiles.
//   * A catch can never be submitted for a ball that isn't in the
//     current draw, and each player catches each ball at most once.
//
// Status state machine (values match the `keno_pvp_status` pgEnum in
// src/db/schema.ts / migrations 0061 + 0064 — do not change one
// without the other):
//   waiting → ready → round_1 … round_16 → overtime → finished
//   waiting → cancelled (creator cancel, or disconnect forfeit before
//   the opponent joins)
//   ready/round_N/overtime → finished (natural resolve, or disconnect
//   forfeit resolving the match as a win for the opponent)

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  ROUND_1: "round_1",
  ROUND_2: "round_2",
  ROUND_3: "round_3",
  ROUND_4: "round_4",
  ROUND_5: "round_5",
  ROUND_6: "round_6",
  ROUND_7: "round_7",
  ROUND_8: "round_8",
  ROUND_9: "round_9",
  ROUND_10: "round_10",
  ROUND_11: "round_11",
  ROUND_12: "round_12",
  ROUND_13: "round_13",
  ROUND_14: "round_14",
  ROUND_15: "round_15",
  ROUND_16: "round_16",
  // 30-second countdown after the 3-minute match clock expires with
  // nobody at POINTS_TO_WIN; most tiles wins when it ends.
  OVERTIME: "overtime",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
// Includes OVERTIME so a disconnect during the countdown still
// resolves as a forfeit win for the opponent.
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.ROUND_4,
  MATCH_STATUS.ROUND_5,
  MATCH_STATUS.ROUND_6,
  MATCH_STATUS.ROUND_7,
  MATCH_STATUS.ROUND_8,
  MATCH_STATUS.ROUND_9,
  MATCH_STATUS.ROUND_10,
  MATCH_STATUS.ROUND_11,
  MATCH_STATUS.ROUND_12,
  MATCH_STATUS.ROUND_13,
  MATCH_STATUS.ROUND_14,
  MATCH_STATUS.ROUND_15,
  MATCH_STATUS.ROUND_16,
  MATCH_STATUS.OVERTIME,
]);

// States where ball-catching is allowed (a round is live). Overtime is
// a pure countdown — no new balls are released, so it is NOT a round.
export const ROUND_STATES = new Set([
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.ROUND_4,
  MATCH_STATUS.ROUND_5,
  MATCH_STATUS.ROUND_6,
  MATCH_STATUS.ROUND_7,
  MATCH_STATUS.ROUND_8,
  MATCH_STATUS.ROUND_9,
  MATCH_STATUS.ROUND_10,
  MATCH_STATUS.ROUND_11,
  MATCH_STATUS.ROUND_12,
  MATCH_STATUS.ROUND_13,
  MATCH_STATUS.ROUND_14,
  MATCH_STATUS.ROUND_15,
  MATCH_STATUS.ROUND_16,
]);

// Terminal states — no further transitions allowed.
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// ──────────────────────────────────────────────────────────────────────
// Match structure — first to 10 points
// ──────────────────────────────────────────────────────────────────────

// Cumulative points needed to win the match (first to reach it takes
// the pot). Round scores are the keno multiplier for the number
// caught, so a single 3-catch round (10 pts) can clinch it.
export const POINTS_TO_WIN = 10;

// Hard cap on rounds per match (matches the round_1…round_16 status
// enum in the DB). 16 rounds × ~11.6s ≈ 3 minutes — the round race is
// allowed to run PAST the 3-minute match clock (MATCH_TIME_LIMIT_MS)
// so the overtime rule below can actually fire; whichever boundary
// comes first ends the match. If neither player reaches POINTS_TO_WIN
// by the clock, the match enters a 30s overtime and the higher
// cumulative score wins (tie → fee-refund draw).
export const MAX_ROUNDS = 16;

// ──────────────────────────────────────────────────────────────────────
// The shared-draw glow loop
// ──────────────────────────────────────────────────────────────────────

// Keno board + draw constants (mirror src/lib/kenoMultipliers.ts).
export const KENO_POOL_SIZE = 40;

// Tiles drawn per round — the shared glow-stream both players catch.
export const BALL_COUNT = 10;

// How long a tile GLOWS (stays catchable) after it lights up. The
// player must tap the tile while it's glowing — a tap after the glow
// fades is a miss (tile turns red, no points). 800ms keeps the
// reaction window tight enough to be a real skill test on both
// desktop and mobile.
export const GLOW_MS = 800;

// Network cushion: a tap arriving up to this long AFTER a tile's glow
// faded is still honoured as a catch. The player tapped while the tile
// was visibly glowing — the request just took a moment to reach the
// server (mobile RTT + the client's 100ms render tick can eat the tail
// of the 0.8s window; without this, well-timed taps become false misses
// on slow connections). INVISIBLE to players: the ring/glow still end
// at GLOW_MS, the server grades with its own clock (no client
// timestamps, so it can't be exploited), and the round deadline still
// sits on the last tile's glow end (that final cushion is clipped by
// round resolution, mirroring the pre-glow design).
export const CATCH_GRACE_MS = 150;

// Time between tile glows.
export const BALL_INTERVAL_MS = 1200;

// Total round duration = release schedule + the final tile's glow:
// the last tile (index BALL_COUNT-1) lights up at
// `deadline - GLOW_MS`, so it stops glowing EXACTLY at the round
// deadline and the round resolves the moment the stream ends.
export const ROUND_MS = GLOW_MS + (BALL_COUNT - 1) * BALL_INTERVAL_MS; // 11600ms

// Stored as `round_timer_seconds` on the match row (ceil of ROUND_MS).
export const ROUND_TIMER_SECONDS = Math.ceil(ROUND_MS / 1000); // 12

// ──────────────────────────────────────────────────────────────────────
// Match clock + overtime
// ──────────────────────────────────────────────────────────────────────

// The match-level time budget, measured from `started_at` (when the
// opponent joins). Rounds play normally while the clock runs; at the
// next round boundary AFTER this expires, if nobody has reached
// POINTS_TO_WIN, the match enters the 30-second overtime countdown
// instead of opening another round. "Around 3 minutes" — the clock
// is checked on round resolution, so the actual trigger lands within
// one round (~12s) of the 3-minute mark.
export const MATCH_TIME_LIMIT_MS = 3 * 60 * 1000; // 180s

// Overtime countdown duration. During overtime no new balls release;
// when the countdown hits 0 the match settles and the player with the
// most tiles (highest cumulative score) wins.
export const OVERTIME_MS = 30 * 1000; // 30s

// Rake applied to an OVERTIME TIE only: each player is refunded 95%
// of their stake (5% taken from each side — 10% of the pot total,
// matching the standard house take). Normal (non-overtime) draws stay
// a full refund with no rake.
export const OVERTIME_DRAW_FEE_PCT = 0.05;

// Auto-advance window between player2 joining and round_1 starting
// (server-authoritative "Get ready" banner).
export const READY_WINDOW_MS = 3000;

// Window between FINISHED and the client being allowed to navigate
// back to the lobby.
export const FINISHED_GRACE_MS = 5000;

// ──────────────────────────────────────────────────────────────────────
// Stake constants
// ──────────────────────────────────────────────────────────────────────

export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
export const MAX_STAKE = 1000000;

// Standard win: 90/10 split of the loser's stake (winner 1.9x net).
export const HOUSE_FEE_PCT = 0.10;
export const WINNER_RATIO = 0.90;
export const HOUSE_RATIO = 0.10;

// ──────────────────────────────────────────────────────────────────────
// Advisory-lock namespace
// ──────────────────────────────────────────────────────────────────────
// Stable ASCII pack for "KPVP" (Keno PvP): K=0x4B, P=0x50, V=0x56,
// P=0x50.
export const KENO_PVP_LOCK_NAMESPACE = 0x4b505650 & 0x7fffffff;

// Stable internal seat identity for free human-vs-AI matches. This is
// never a Clerk user and must never be used for balance/stat updates.
export const KENO_AI_PLAYER_ID = "keno_ai_bot";

export function isFreeAiMatch(match) {
  return Boolean(match?.isAi);
}

// Result vocabulary — matches the `keno_pvp_rounds.round_winner`
// varchar(10) and `keno_pvp_matches.result` varchar(20) columns.
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

// ──────────────────────────────────────────────────────────────────────
// Status ↔ round-number mapping helpers
// ──────────────────────────────────────────────────────────────────────

/** Map a 1-based round number (1..MAX_ROUNDS) to the canonical
 *  match.status enum value. Out-of-range inputs clamp defensively. */
export function statusForRoundNumber(roundNumber) {
  const n = Number(roundNumber);
  if (!Number.isFinite(n)) return MATCH_STATUS.ROUND_1;
  const clamped = Math.max(1, Math.min(MAX_ROUNDS, Math.trunc(n)));
  return `round_${clamped}`;
}

/** Inverse of statusForRoundNumber. Returns the 1-based round number
 *  for a round_N status, or null for any other status. */
export function roundNumberForStatus(status) {
  const m = /^round_([1-9]\d*)$/.exec(String(status || ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > MAX_ROUNDS) return null;
  return n;
}

/** True when the match is inside a live catch round. */
export function isRoundStatus(status) {
  return roundNumberForStatus(status) !== null;
}

// ──────────────────────────────────────────────────────────────────────
// Payout calculator
// ──────────────────────────────────────────────────────────────────────
// Returns the per-side settlement numbers for a resolved match:
//
//   { stake, winnerNet, loserNet, houseFee, prizePaid, refundEach }
//
// Rules:
//   PLAYER1 / PLAYER2: winner gets stake + 90% of loser's stake
//                      (winnerNet = 1.9x stake); loser loses their stake.
//   DRAW:              both fully refunded (refundEach = stake), no
//                      rake — UNLESS `drawFeePct` is passed (overtime
//                      ties): each player keeps (1 - drawFeePct) of
//                      their stake and the house takes 2 × that fee
//                      (e.g. 5% per side → 10% of the pot total,
//                      matching the standard house take).

export function computePayout({ stakeAmount, result, drawFeePct = 0 }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < 0) {
    throw new RangeError(
      `computePayout: stakeAmount must be a non-negative number, got ${stakeAmount}`,
    );
  }
  if (![RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW].includes(result)) {
    throw new RangeError(
      `computePayout: result must be player1|player2|draw, got ${result}`,
    );
  }
  const feeRate = Number(drawFeePct);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 1) {
    throw new RangeError(
      `computePayout: drawFeePct must be in [0, 1], got ${drawFeePct}`,
    );
  }
  if (result === RESULT.DRAW) {
    const fee = round2(stake * feeRate);
    return {
      stake: round2(stake),
      winnerNet: null,
      loserNet: null,
      houseFee: round2(fee * 2),
      prizePaid: round2(0),
      refundEach: round2(stake - fee),
    };
  }
  const winnerPrize = round2(stake * WINNER_RATIO); // 90% of loser's stake
  const houseFee = round2(stake * HOUSE_RATIO); // 10% of loser's stake
  return {
    stake: round2(stake),
    winnerNet: round2(stake + winnerPrize),
    loserNet: round2(-stake),
    houseFee,
    prizePaid: round2(stake + winnerPrize),
    refundEach: null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Format helpers
// ──────────────────────────────────────────────────────────────────────

/** Round a number to 2dp (identical strings server-side and client-side). */
export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

/** Coerce an arbitrary DB-shaped value to a positive integer with a
 *  fallback (mirrors slots-pvp's pickPositiveInt). */
export function pickPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}
