// src/lib/keno-pvp/constants.js
//
// Shared constants + helpers for the PvP Keno ("Keno Catch Duel")
// match system. Built as a parallel to `src/lib/slots-pvp/constants.js`
// / `src/lib/mines-pvp/constants.js` so the match flow shares the same
// shape (status enum / timer / stake presets / advisory-lock namespace /
// RESULT enum) while the game logic is keno-specific.
//
// Game rules (per user spec — "make keno skill-based 1v1"):
//   * Best-of-5 rounds. First to 3 round wins takes the match; if the
//     rounds are level after 5, the aggregate round scores break the
//     tie (a full DRAW refunds both players, no rake).
//   * Every round BOTH players face the SAME shared draw: 10 unique
//     balls drawn from the 1-40 keno pool. The draw is generated
//     server-side when the round opens and its release schedule is
//     derived from the round deadline, so both clients render the
//     identical ball stream.
//   * Skill loop: the round is a shared GLOW-STREAM. Tiles light up
//     one at a time (BALL_INTERVAL_MS apart) and stay GLOWING for
//     GLOW_MS (0.5s). Tap the glowing tile while it's lit → catch it.
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
// src/db/schema.ts / migration 0061 — do not change one without the
// other):
//   waiting → ready → round_1 → round_2 → round_3 → round_4 → round_5 → finished
//   waiting → cancelled (creator cancel, or disconnect forfeit before
//   the opponent joins)
//   ready/round_N → finished (natural resolve, or disconnect forfeit
//   resolving the match as a win for the opponent)

export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  ROUND_1: "round_1",
  ROUND_2: "round_2",
  ROUND_3: "round_3",
  ROUND_4: "round_4",
  ROUND_5: "round_5",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.ROUND_4,
  MATCH_STATUS.ROUND_5,
]);

// States where ball-catching is allowed (a round is live).
export const ROUND_STATES = new Set([
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.ROUND_4,
  MATCH_STATUS.ROUND_5,
]);

// Terminal states — no further transitions allowed.
export const TERMINAL_STATES = new Set([
  MATCH_STATUS.FINISHED,
  MATCH_STATUS.CANCELLED,
]);

// ──────────────────────────────────────────────────────────────────────
// Match structure — best-of-5
// ──────────────────────────────────────────────────────────────────────

// Maximum number of rounds per match.
export const MAX_ROUNDS = 5;

// Round wins needed to end the match early (first to 3).
export const ROUNDS_TO_WIN = 3;

// ──────────────────────────────────────────────────────────────────────
// The shared-draw glow loop
// ──────────────────────────────────────────────────────────────────────

// Keno board + draw constants (mirror src/lib/kenoMultipliers.ts).
export const KENO_POOL_SIZE = 40;

// Tiles drawn per round — the shared glow-stream both players catch.
export const BALL_COUNT = 10;

// How long a tile GLOWS (stays catchable) after it lights up. The
// player must tap the tile while it's glowing — a tap after the glow
// fades is a miss (tile turns red, no points).
export const GLOW_MS = 500;

// Network cushion: a tap arriving up to this long AFTER a tile's glow
// faded is still honoured as a catch. The player tapped while the tile
// was visibly glowing — the request just took a moment to reach the
// server (mobile RTT + the client's 100ms render tick can eat the tail
// of a 0.5s window; without this, well-timed taps become false misses
// on slow connections). INVISIBLE to players: the ring/glow still end
// at GLOW_MS, the server grades with its own clock (no client
// timestamps, so it can't be exploited), and the round deadline still
// sits on the last tile's glow end (that final cushion is clipped by
// round resolution, mirroring the pre-glow design).
export const CATCH_GRACE_MS = 200;

// Time between tile glows.
export const BALL_INTERVAL_MS = 1400;

// Total round duration = release schedule + the final tile's glow:
// the last tile (index BALL_COUNT-1) lights up at
// `deadline - GLOW_MS`, so it stops glowing EXACTLY at the round
// deadline and the round resolves the moment the stream ends.
export const ROUND_MS = GLOW_MS + (BALL_COUNT - 1) * BALL_INTERVAL_MS; // 13100ms

// Stored as `round_timer_seconds` on the match row (ceil of ROUND_MS).
export const ROUND_TIMER_SECONDS = Math.ceil(ROUND_MS / 1000); // 14

// Auto-advance window between player2 joining and round_1 starting
// (server-authoritative "Get ready" banner).
export const READY_WINDOW_MS = 3000;

// Window between FINISHED and the client being allowed to navigate
// back to the lobby.
export const FINISHED_GRACE_MS = 5000;

// ──────────────────────────────────────────────────────────────────────
// Test / practice mode
// ──────────────────────────────────────────────────────────────────────

// Email domain of the developer's test accounts. Lobbies hosted by
// these accounts are excluded from REAL matchmaking, and matches
// created via the "Test vs Bot" button are free play — no stake is
// escrowed and no payout is credited.
export const TEST_ACCOUNT_EMAIL_DOMAIN = "codebuff-test.dev";

// How likely the practice bot catches each released ball during a
// test match (driven off the /status poll). Kept below 1.0 so the
// bot drops balls like a human instead of catching everything.
export const BOT_CATCH_CHANCE = 0.55;

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
//   DRAW:              both fully refunded (refundEach = stake), no rake.

export function computePayout({ stakeAmount, result }) {
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
