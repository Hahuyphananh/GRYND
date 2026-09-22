// src/lib/keno-pvp/constants.js
//
// Shared constants for the 1v1 Keno SURVIVAL DUEL match system. Built as
// a parallel to `src/lib/slots-pvp/constants.js` /
// `src/lib/mines-pvp/constants.js` so the match flow shares the same
// shape (status enum / ready window / stake presets / advisory-lock
// namespace / RESULT enum) while the game logic is keno-specific.
//
// Game rules (the survival duel — NO points, NO first-to-10, NO rounds):
//   * Both players start with STARTING_LIVES (3) lives.
//   * ONE tile at a time is lit for both players: the live tile, drawn
//     from the 1..40 board and never repeated during a match.
//   * The first player to tap the live tile CLAIMS it. Claiming costs the
//     opponent a life, and the next tile lights up immediately.
//   * A tile that nobody claims before its window closes is a
//     BOTH-MISS: both players lose a life.
//   * Your lives hit 0 → you are eliminated and the opponent takes the
//     pot. If a both-miss eliminates both players at once the match ends
//     as a DRAW (full refund, no rake).
//   * The window starts at START_WINDOW_MS (1.6s) and tightens by
//     WINDOW_STEP_MS (100ms) for every tile either player has claimed,
//     down to MIN_WINDOW_MS (0.4s) — later tiles are pure reaction time.
//   * If the board is exhausted before anyone is eliminated, the player
//     with more lives wins (equal lives → DRAW).
//
// Status state machine (values must stay inside the `keno_pvp_status`
// pgEnum in src/db/schema.ts / migrations — do not change one without
// the other):
//   waiting → ready → <live> → finished
//   waiting → cancelled (creator cancel, or disconnect forfeit before
//   the opponent joins)
//   ready/live → finished (natural resolve, or disconnect forfeit
//   resolving the match as a win for the opponent)
//
// `<live>` is the single continuous survival run. The DB enum has no
// dedicated `live` value and ALTER TYPE … ADD VALUE is not safe to run
// from the app's migration path, so the run reuses the `round_1` slot it
// inherited from the old multi-round game (see DB_STATUS_VALUES below).
// Nothing advances a round number any more: `currentRound` stays 1 for
// the whole run.

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  // The live survival run (DB value: "round_1").
  LIVE: "round_1",
  // Legacy only: rows created by the pre-rework multi-round game can
  // still be sitting in these states. Nothing ever transitions INTO
  // them any more.
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
  OVERTIME: "overtime", // legacy only (old overtime countdown)
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// Every value the `keno_pvp_status` pgEnum accepts. MATCH_STATUS must
// stay a subset of this list — the enum is owned by the database, not by
// the app, so a value that is not listed here cannot be written.
export const DB_STATUS_VALUES = Object.freeze([
  "waiting",
  "ready",
  "round_1",
  "round_2",
  "round_3",
  "round_4",
  "round_5",
  "round_6",
  "round_7",
  "round_8",
  "round_9",
  "round_10",
  "round_11",
  "round_12",
  "round_13",
  "round_14",
  "round_15",
  "round_16",
  "overtime",
  "finished",
  "cancelled",
]);

// States where a match is still in progress (not yet terminal). Includes
// the legacy round_N / overtime values so a row left in one of them by
// the pre-rework game can still be settled (e.g. by a disconnect
// forfeit) instead of being treated as untouchable.
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.LIVE,
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

// States where a live tile is on the board and claims are accepted.
export const LIVE_STATES = new Set([MATCH_STATUS.LIVE]);

// Legacy alias — the survival run is the only "catch round" there is.
// Kept so route/store imports that predate the rework keep working.
export const ROUND_STATES = LIVE_STATES;

// Terminal states — no further transitions allowed.
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// ──────────────────────────────────────────────────────────────────────
// Survival rules
// ──────────────────────────────────────────────────────────────────────

// Lives each player starts the match with. Every tile you LOSE costs one
// life: your opponent claims the live tile first, or nobody claims it in
// time (a both-miss costs both players a life). Lose all of them and the
// match is over.
export const STARTING_LIVES = 3;

// How long the live tile stays claimable on the FIRST tile of a match.
// Deliberately slower than the old 0.8s glow: a window you can read, not
// a twitch test — the pace ramps as the match goes on.
export const START_WINDOW_MS = 1600;

// How much the window tightens for every tile either player has CLAIMED
// (both-misses do not speed the game up). After 12 claims the window sits
// on its floor.
export const WINDOW_STEP_MS = 100;

// Fastest the window ever gets.
export const MIN_WINDOW_MS = 400;

// Network cushion: a claim that reaches the server this long AFTER the
// window closed is still honoured as a claim. The tap was made while the
// tile was visibly lit — the request just took a moment to arrive, and on
// a slow connection that would otherwise turn a winning tap into a
// both-miss for BOTH players. Invisible to players (the ring always ends
// at the window) and server-clocked, so it cannot be exploited.
export const TAP_GRACE_MS = 120;

// Keno board size (mirror src/lib/kenoMultipliers.ts).
export const KENO_POOL_SIZE = 40;

// The public per-tile log is capped at the whole board — a match can
// never draw more than KENO_POOL_SIZE tiles, so nothing is ever dropped.
export const TILE_LOG_LIMIT = KENO_POOL_SIZE;

// Auto-advance window between player2 joining and the run starting
// (server-authoritative "Get ready" banner).
export const READY_WINDOW_MS = 3000;

// Window between FINISHED and the client being allowed to navigate back
// to the lobby.
export const FINISHED_GRACE_MS = 5000;

// ──────────────────────────────────────────────────────────────────────
// Stake constants
// ──────────────────────────────────────────────────────────────────────

export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
// Must match GLOBAL_MAX_BET in src/lib/games/economy.ts.
export const MAX_STAKE = 100000;

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

// Result vocabulary — matches the `keno_pvp_matches.result` varchar(20)
// column.
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
});

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
//   DRAW:              both fully refunded (refundEach = stake), no rake
//                      — UNLESS `drawFeePct` is passed (legacy overtime
//                      ties on pre-rework rows): each player keeps
//                      (1 - drawFeePct) of their stake and the house
//                      takes 2 × that fee.

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

// Legacy rake applied to a pre-rework OVERTIME tie only (5% per side).
// Kept so old rows keep rendering the same numbers; the survival duel
// never enters overtime.
export const OVERTIME_DRAW_FEE_PCT = 0.05;

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

/** Coerce an arbitrary DB-shaped value to a non-negative integer. */
export function pickNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}
