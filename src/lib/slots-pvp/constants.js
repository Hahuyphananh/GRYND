// src/lib/slots-pvp/constants.js
//
// Shared constants + helpers for the PvP Slots ("Skill Slots") round
// system. Built as a parallel to `src/lib/plinko-pvp/constants.js` /
// `src/lib/mines-pvp/constants.js` so the match flow shares the same
// shape (status enum / round timer / stake presets / advisory-lock
// namespace) while the game logic is slots-specific.
//
// Round rules (per user spec):
//   * A round lasts EXACTLY ROUND_TIMER_SECONDS (10s).
//   * A match has at most MAX_ROUNDS (5) rounds — best-of-5, and a
//     player who reaches ROUNDS_TO_WIN (3) round wins ends the match
//     IMMEDIATELY (the remaining rounds are not played).
//   * Both players play SIMULTANEOUSLY, each stopping Reel 1/2/3.
//   * A stopped reel can never be stopped again.
//   * When the 10s timer expires the server auto-stops any remaining
//     reels (never longer than 10s).
//   * Once all 3 reels are stopped the board locks and the round result
//     is computed.
//
// Scoring system (FINAL, server-authoritative):
//   * 8 winning lines on the 3x3 board (3 rows + 3 cols + 2 diagonals);
//     a line wins when its 3 cells hold the same symbol.
//   * Symbol tiers are POSITION-BASED per user spec: each theme's first
//     6 symbols map to Cherry(100) … Diamond(500) in order; the other 14
//     theme symbols score 0 (never part of a winning line).
//   * Line-count multiplier: 1 line x1, 2 lines x1.25, 3 lines x1.5,
//     4 lines x2, 5+ lines x3.
//   * Stop accuracy (per reel, timing-based): stopped within the first
//     3s of the round = Perfect (+100), within 6s = Good (+50), after
//     (or auto-stopped by the deadline) = Normal (+0). Bonuses stay
//     small relative to symbol scores (max +300 vs up to 500+ per line).
//   * Round winner = higher total score (draw on tie); match winner =
//     most rounds won, tie-broken by aggregate points.
//   * Payout mirrors mines-pvp: 90/10 split of the loser's stake.

// ──────────────────────────────────────────────────────────────────────
// Status state machine
// ──────────────────────────────────────────────────────────────────────
//
// waiting → ready → spin_1 → spin_2 → spin_3 → spin_4 → spin_5 → finished
// waiting → cancelled (creator cancel, or disconnect forfeit before the
// opponent joins)
// ready/spin_N → finished (natural resolve, or disconnect forfeit
// resolving the match as a win for the opponent)
//
// These values match the `slots_pvp_status` pgEnum in src/db/schema.ts
// (migration 0059) — do not change one without the other.

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

// States where reel-stopping is allowed (a spin round is live).
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
// Round structure
// ──────────────────────────────────────────────────────────────────────

// Maximum number of rounds per match (best-of-5 hard cap — a match
// NEVER exceeds this many rounds even when nobody reaches
// ROUNDS_TO_WIN).
export const MAX_ROUNDS = 5;

// Number of round wins needed to end the match IMMEDIATELY. Per user
// spec the match is best-of-5: first to 3 round wins wins the match,
// so once a player hits ROUNDS_TO_WIN the remaining rounds are not
// played (still capped by MAX_ROUNDS).
export const ROUNDS_TO_WIN = 3;

// Number of reels each player stops per round.
export const REELS_PER_ROUND = 3;

// Duration (seconds) of each round's spin window. Per user spec the
// round lasts EXACTLY this long — the server stamps
// `round_deadline = round_start + ROUND_TIMER_SECONDS` and auto-stops
// any remaining reels the moment the deadline passes.
export const ROUND_TIMER_SECONDS = 10;
export const ROUND_DEADLINE_MS = ROUND_TIMER_SECONDS * 1000;

// Auto-advance window between player2 joining and spin_1 starting
// (server-authoritative "Get ready" banner).
export const READY_WINDOW_MS = 3000;

// Auto-advance window between consecutive rounds (client-side
// transition overlay; the server opens the next spin immediately,
// mirroring plinko-pvp's between-balls behavior).
export const BETWEEN_ROUNDS_MS = 3000;

// Window between FINISHED and the client being allowed to navigate
// back to the lobby.
export const FINISHED_GRACE_MS = 5000;

// ──────────────────────────────────────────────────────────────────────
// Stake constants (reserved for the matchmaking / scoring steps)
// ──────────────────────────────────────────────────────────────────────

export const STAKE_PRESETS = [10, 25, 50, 100, 250, 500];
export const MIN_STAKE = 1;
export const MAX_STAKE = 1000000;

// House fee (10% rake on the LOSER's stake) — reserved for the scoring
// step, mirrors mines-pvp / plinko-pvp.
export const HOUSE_FEE_PCT = 0.10;
export const WINNER_RATIO = 0.90;
export const HOUSE_RATIO = 0.10;

// ──────────────────────────────────────────────────────────────────────
// Symbol score tiers (position-based)
// ──────────────────────────────────────────────────────────────────────
//
// Each theme exposes a 20-symbol pool. Per user spec the SIX named score
// tiers map to the pool POSITIONALLY: symbols[0] = Cherry (100), …,
// symbols[5] = Diamond (500). Symbols at index >= SCORING_SYMBOL_COUNT
// score 0. Deterministic and identical for every theme — no per-theme
// tables, no visual change.

export const SYMBOL_SCORES = Object.freeze([100, 125, 150, 200, 300, 500]);
export const SCORING_SYMBOL_COUNT = SYMBOL_SCORES.length;

// ──────────────────────────────────────────────────────────────────────
// Line-count multiplier (per user spec)
// ──────────────────────────────────────────────────────────────────────
// 1 line = x1, 2 = x1.25, 3 = x1.5, 4 = x2, 5+ = x3. Rows sorted by
// `minLines` descending so `lineMultiplierForCount` short-circuits on
// the first entry it satisfies.
export const LINE_MULTIPLIERS = Object.freeze([
  Object.freeze({ minLines: 5, multiplier: 3 }),
  Object.freeze({ minLines: 4, multiplier: 2 }),
  Object.freeze({ minLines: 3, multiplier: 1.5 }),
  Object.freeze({ minLines: 2, multiplier: 1.25 }),
  Object.freeze({ minLines: 1, multiplier: 1 }),
]);

/** Map a winning-line count to its multiplier. <1 line → x1. */
export function lineMultiplierForCount(lineCount) {
  const n = Number(lineCount);
  if (!Number.isInteger(n) || n < 1) return 1;
  for (const row of LINE_MULTIPLIERS) {
    if (n >= row.minLines) return row.multiplier;
  }
  return 1;
}

// ──────────────────────────────────────────────────────────────────────
// Stop accuracy (per reel, timing-based)
// ──────────────────────────────────────────────────────────────────────
// The server knows when the round opened (round_deadline -
// ROUND_DEADLINE_MS) and when each reel was stopped (the POST arrives
// with a server timestamp). A stop within the first 3s = Perfect, within
// 6s = Good, later (or auto-stopped by the deadline) = Normal. Bonuses
// are deliberately small compared with symbol scores (max +300 per
// round across 3 reels).

export const PERFECT_STOP_BONUS = 100;
export const GOOD_STOP_BONUS = 50;
export const NORMAL_STOP_BONUS = 0;
export const PERFECT_STOP_WINDOW_MS = 3000;
export const GOOD_STOP_WINDOW_MS = 6000;

/** Map a stop offset (ms since round open) to its accuracy label. */
export function stopAccuracyForOffset(offsetMs) {
  const n = Number(offsetMs);
  if (!Number.isFinite(n) || n < 0) return "normal";
  if (n < PERFECT_STOP_WINDOW_MS) return "perfect";
  if (n < GOOD_STOP_WINDOW_MS) return "good";
  return "normal";
}

/** Map an accuracy label to its points bonus. */
export function stopBonusForAccuracy(accuracy) {
  if (accuracy === "perfect") return PERFECT_STOP_BONUS;
  if (accuracy === "good") return GOOD_STOP_BONUS;
  return NORMAL_STOP_BONUS;
}

// ──────────────────────────────────────────────────────────────────────
// Payout calculator (mirrors mines-pvp computePayout)
// ──────────────────────────────────────────────────────────────────────
// Returns the per-side settlement numbers for a resolved match:
//
//   { stake, winnerNet, loserNet, houseFee, prizePaid }
//
// Rules (per user spec, same 90/10 split as mines-pvp):
//   DRAW:       both refunded. winnerNet = loserNet = null,
//               houseFee = 0, prizePaid = 0.
//   PLAYER1:    player1 wins. player1 gets (stake + 0.9 * stake);
//               player2 loses their stake. House rake = 0.1 * stake.
//   PLAYER2:    mirror of PLAYER1.

export function computePayout({ stakeAmount, result }) {
  const stake = Number(stakeAmount);
  if (!Number.isFinite(stake) || stake < 0) {
    throw new RangeError(
      `computePayout: stakeAmount must be a non-negative number, got ${stakeAmount}`,
    );
  }
  if (![RESULT.PLAYER1, RESULT.PLAYER2, RESULT.DRAW].includes(result)) {
    throw new RangeError(
      `computePayout: result must be one of player1|player2|draw, got ${result}`,
    );
  }
  if (result === RESULT.DRAW) {
    return {
      stake: round2(stake),
      winnerNet: null,
      loserNet: null,
      houseFee: round2(0),
      prizePaid: round2(0),
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
  };
}

// ──────────────────────────────────────────────────────────────────────
// Advisory-lock namespace (reserved for the matchmaking step)
// ──────────────────────────────────────────────────────────────────────
//
// Stable ASCII pack to keep the global pg_advisory_xact_lock keyspace
// partitioned. ASCII for "SLTS" (SlotS): S=0x53, L=0x4C, T=0x54, S=0x53.
// Bitwise-AND with 0x7FFFFFFF keeps the 32-bit signed integer positive.
export const SLOTS_PVP_LOCK_NAMESPACE = 0x534c5453 & 0x7fffffff;

// Result vocabulary (reserved for the scoring step). 'player1' |
// 'player2' | 'draw' matches the blackjack-pvp / mines-pvp convention
// and the `slots_pvp_rounds.round_winner` varchar(10) column.
export const RESULT = Object.freeze({
  PLAYER1: "player1",
  PLAYER2: "player2",
  DRAW: "draw",
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
// Format helpers (used by the server store + client UI)
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
