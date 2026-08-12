// src/lib/slots-pvp/constants.js
//
// Shared constants + helpers for the PvP Slots ("Fruit Fortune Survival")
// system. Built as a parallel to `src/lib/plinko-pvp/constants.js` /
// `src/lib/mines-pvp/constants.js` so the match flow shares the same
// shape (status enum / timer / stake presets / advisory-lock namespace)
// while the game logic is slots-specific.
//
// Game rules (per user spec — "Sliding Columns Survival"):
//   * Single survival round per match (was best-of-5). MAX_ROUNDS / ROUNDS_TO_WIN
//     are both 1 so the existing best-of-5 machinery degrades to one round.
//   * Both players play SIMULTANEOUSLY on their own 3-column sliding window.
//   * Round flow per player:
//       - GRACE phase: stop columns until you form your FIRST 3-in-a-row
//         combo (3 identical symbols in a horizontal row or a diagonal —
//         verticals never count). You CANNOT bust during grace, but you
//         have at most GRACE_MAX_STOPS (10) stops to find that first
//         combo; if you burn all 10 without one → graceFailed (loss).
//       - SURVIVAL phase: from the first combo onward, every new column
//         you stop MUST re-form a horizontal/diagonal combo in the
//         visible window or you BUST (the round ends for you).
//   * A new column slides into the 3x3 window from the right and the
//     oldest column slides out to the left — the window always shows
//     exactly 3 columns.
//   * Per-column countdown: each active column must be stopped within
//     COLUMN_TIMER_SECONDS (10s) or the server auto-stops it (which can
//     bust you in the survival phase).
//   * Round resolution: the round resolves only when BOTH players' runs
//     have ended (no early loss reveal). Winner = higher `survived`
//     count (tiebreak: total lines formed). If BOTH players grace-fail
//     → RESULT.GRACE_DRAW: each player is refunded 95% of their wager
//     (house keeps 5% from each = 10% total).
//   * Safety cap: MAX_COLUMNS_PER_ROUND ends an (extremely unlikely)
//     infinite run.
//
// Status state machine (values match the `slots_pvp_status` pgEnum in
// src/db/schema.ts / migration 0059 — do not change one without the
// other):
//   waiting → ready → spin_1 → finished
//   waiting → cancelled (creator cancel, or disconnect forfeit before the
//   opponent joins)
//   ready/spin_1 → finished (natural resolve, or disconnect forfeit
//   resolving the match as a win for the opponent)

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  SPIN_1: "spin_1",
  SPIN_2: "spin_2",
  SPIN_3: "spin_3",
  SPIN_4: "spin_4",
  SPIN_5: "spin_5",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.SPIN_1,
  MATCH_STATUS.SPIN_2,
  MATCH_STATUS.SPIN_3,
  MATCH_STATUS.SPIN_4,
  MATCH_STATUS.SPIN_5,
]);

// States where column-stopping is allowed (the survival round is live).
export const SPIN_STATES = new Set([
  MATCH_STATUS.SPIN_1,
  MATCH_STATUS.SPIN_2,
  MATCH_STATUS.SPIN_3,
  MATCH_STATUS.SPIN_4,
  MATCH_STATUS.SPIN_5,
]);

// Terminal states — no further transitions allowed.
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// ──────────────────────────────────────────────────────────────────────
// Match structure — SINGLE survival round (was best-of-5)
// ──────────────────────────────────────────────────────────────────────

// Maximum number of rounds per match. 1 = single survival round.
export const MAX_ROUNDS = 1;

// Round wins needed to end the match. 1 = the single round decides.
export const ROUNDS_TO_WIN = 1;

// ──────────────────────────────────────────────────────────────────────
// The sliding-columns survival loop
// ──────────────────────────────────────────────────────────────────────

// Symbol sub-pool used for column generation: the first N symbols of the
// theme pool. 5 fruits keeps combos frequent enough to be a real skill
// loop (per-stop survival ≈ 1 - (1 - 1/5)^5 ≈ 67%).
export const SLIDING_SYMBOL_COUNT = 5;

// Max grace stops to find the FIRST 3-in-a-row combo. No combo within
// this many stops → the player loses immediately (anti-stall).
export const GRACE_MAX_STOPS = 10;

// Hard safety cap on total stopped columns per player per round — an
// ultra-lucky run can never hang the match.
export const MAX_COLUMNS_PER_ROUND = 60;

// Per-column countdown: each active column must be stopped within this
// many seconds or the server auto-stops it. Stored on the match row as
// `round_timer_seconds` (same column as before, new meaning).
export const ROUND_TIMER_SECONDS = 10;
export const COLUMN_TIMER_SECONDS = ROUND_TIMER_SECONDS;
export const COLUMN_DEADLINE_MS = COLUMN_TIMER_SECONDS * 1000;

// Auto-advance window between player2 joining and spin_1 starting
// (server-authoritative "Get ready" banner).
export const READY_WINDOW_MS = 3000;

// Client-side transition overlay between round-end and the reveal.
export const BETWEEN_ROUNDS_MS = 3000;

// Window between FINISHED and the client being allowed to navigate
// back to the lobby.
export const FINISHED_GRACE_MS = 5000;

// ──────────────────────────────────────────────────────────────────────
// Stake constants
// ──────────────────────────────────────────────────────────────────────

export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
export const MAX_STAKE = 1000000;

// Normal win: 90/10 split of the loser's stake (winner 1.9x net).
export const HOUSE_FEE_PCT = 0.10;
export const WINNER_RATIO = 0.90;
export const HOUSE_RATIO = 0.10;

// Double grace-fail tie: refund 95% of EACH wager; house keeps 5% from
// each player (10% total).
export const GRACE_DRAW_REFUND_PCT = 0.95;
export const GRACE_DRAW_RAKE_PCT = 0.05;

// ──────────────────────────────────────────────────────────────────────
// Advisory-lock namespace
// ──────────────────────────────────────────────────────────────────────
// Stable ASCII pack for "SLTS" (SlotS): S=0x53, L=0x4C, T=0x54, S=0x53.
export const SLOTS_PVP_LOCK_NAMESPACE = 0x534c5453 & 0x7fffffff;

// Result vocabulary — matches the `slots_pvp_rounds.round_winner`
// varchar(10) and `slots_pvp_matches.result` varchar(20) columns.
// 'grace_draw' is exactly 10 chars and fits both.
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
  GRACE_DRAW: "grace_draw",
});

// ──────────────────────────────────────────────────────────────────────
// Status ↔ spin-number mapping helpers
// ──────────────────────────────────────────────────────────────────────

/** Map a 1-based spin number (1..MAX_ROUNDS) to the canonical
 *  match.status enum value. Out-of-range inputs clamp defensively. */
export function statusForSpinNumber(spinNumber) {
  const n = Number(spinNumber);
  if (!Number.isFinite(n)) return MATCH_STATUS.SPIN_1;
  const clamped = Math.max(1, Math.min(MAX_ROUNDS, Math.trunc(n)));
  return `spin_${clamped}`;
}

/** Inverse of statusForSpinNumber. Returns the 1-based spin number for
 *  a spin_N status, or null for any other status. */
export function spinNumberForStatus(status) {
  const m = /^spin_([1-9]\d*)$/.exec(String(status || ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > MAX_ROUNDS) return null;
  return n;
}

/** True when the match is inside a live spin round. */
export function isSpinStatus(status) {
  return spinNumberForStatus(status) !== null;
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
//   DRAW:              both fully refunded (refundEach = stake), no rake.
//   GRACE_DRAW:        both players grace-failed → each refunded 95% of
//                      their wager (refundEach = 0.95 * stake); house
//                      keeps 5% from each (houseFee = 0.10 * stake).

export function computePayout({ stakeAmount, result }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < 0) {
    throw new RangeError(
      `computePayout: stakeAmount must be a non-negative number, got ${stakeAmount}`,
    );
  }
  if (![RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW, RESULT.GRACE_DRAW].includes(result)) {
    throw new RangeError(
      `computePayout: result must be player1|player2|draw|grace_draw, got ${result}`,
    );
  }
  if (result === RESULT.DRAW) {
    return {
      stake: round2(stake),
      winnerNet: null,
      loserNet: null,
      houseFee: round2(0),
      prizePaid: round2(0),
      refundEach: round2(stake),
    };
  }
  if (result === RESULT.GRACE_DRAW) {
    return {
      stake: round2(stake),
      winnerNet: null,
      loserNet: null,
      houseFee: round2(stake * 2 * GRACE_DRAW_RAKE_PCT), // 5% from each = 10% of one stake
      prizePaid: round2(0),
      refundEach: round2(stake * GRACE_DRAW_REFUND_PCT),
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
 *  fallback (mirrors plinko-pvp's pickPositiveInt). */
export function pickPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}
