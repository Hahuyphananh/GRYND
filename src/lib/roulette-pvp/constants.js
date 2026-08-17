// src/lib/roulette-pvp/constants.js
//
// Shared constants + payout helper for the Roulette PvP match system.
// Distinct from the existing solo roulette save-game route so that the
// existing /api/roulette/save-game does NOT need to be modified
// (constraint: don't touch the existing roulette UI / API surface).
//
// The payout math here is intentionally a mirror of
// /api/roulette/save-game/route.js — same bet keys, same multipliers,
// same RED_NUMBERS list. DRY would suggest extracting this into a
// single shared module consumed by both routes, but the user constraint
// "do not modify existing roulette UI / API surface" precludes that
// refactor. Keeping a parallel implementation is safer than risking
// regressions in the solo roulette path.

import {
  ROULETTE_NUMBERS,
  RED_NUMBERS,
  BLACK_NUMBERS,
} from "../rouletteConfig.js";

// ── Match "points" balance (persistent across rounds) ───────────────────
// Both players start the match with exactly STARTING_POINTS credits.
// The balance PERSISTS across rounds: each round's (payout − bet) is
// debited/credited from the player's match points directly. Players
// can never exceed their current match balance when betting.
export const STARTING_POINTS = 100;

// ── House fee (Prompt 10: 2.5% per the math in the spec) ─────────────────
// NOTE: this constant is Roulette-PvP-specific. coin_flip PvP still uses
// 2% — figure out whether you'd like to keep them in lockstep later.
export const HOUSE_FEE_PCT = 0.025;

// ── Per-bet amount hard caps ───────────────────────────────────────────
// `MAX_SINGLE_BET` is the largest amount a single bet key may carry
// (defence-in-depth against NaN / Infinity / negative payloads). The
// real per-round cap is the player's CURRENT persistent match balance
// (`match.playerOnePoints` / `match.playerTwoPoints`), enforced in
// `validateBets` — see serverStore.submitBets. `MAX_TOTAL_BET` is a
// separate (much larger) ceiling on the round total — distinct from
// the per-bet cap so a few medium-sized bets can still take a round
// close to the player's balance.
export const MAX_SINGLE_BET = 10000;
export const MAX_TOTAL_BET = 1000000;

// ── Skill layer: elimination market + opponent call ────────────────────
// Paying players can remove a single number from the shared wheel for
// the current round (visible to both players immediately). The spin is
// then drawn from the LIVE pool — removed numbers can never come up,
// so every removal raises the hit probability of everything that
// remains (payouts stay at standard roulette odds). The cost comes out
// of the player's persistent match-point balance, so it competes
// directly with the wagering budget.
export const ELIMINATION_COST = 10;
// Hard cap on how many numbers a player may remove per round (points
// budget usually binds first; this keeps the board from being gutted).
export const MAX_ELIMINATIONS_PER_ROUND = 6;
// The wheel never shrinks below this many live numbers (server-side
// guard, applied AFTER a removal would land).
export const MIN_LIVE_NUMBERS = 5;
// Points transferred from the opponent when your "call their bet"
// guess is correct.
export const CALL_BONUS = 15;

// Server-driven elimination rounds: each round past round 1, a revealed
// set of numbers is dead before betting opens. Round 2 kills 13–24;
// round 3 kills 13–36 (pool 0–12). Sudden death returns to the full
// wheel so the do-or-die rounds stay clean.
const DOZEN_1_12 = Array.from({ length: 12 }, (_, i) => i + 1);
const DOZEN_13_24 = Array.from({ length: 12 }, (_, i) => i + 13);
const DOZEN_25_36 = Array.from({ length: 12 }, (_, i) => i + 25);
const EVEN_NUMBERS = Array.from({ length: 18 }, (_, i) => (i + 1) * 2);
const ODD_NUMBERS = Array.from({ length: 18 }, (_, i) => (i + 1) * 2 - 1);
const HALF_1_18 = Array.from({ length: 18 }, (_, i) => i + 1);
const HALF_19_36 = Array.from({ length: 18 }, (_, i) => i + 19);

export function serverEliminatedNumbers(roundNumber, suddenDeath) {
  if (suddenDeath) return [];
  if (roundNumber >= 3) return [...DOZEN_13_24, ...DOZEN_25_36];
  if (roundNumber === 2) return [...DOZEN_13_24];
  return [];
}

// Map a bet key to its member wheel numbers (null = not a valid key).
export function betKeyNumbers(key) {
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && n <= 36) return [n];
  switch (key) {
    case "red":
      return RED_NUMBERS;
    case "black":
      return BLACK_NUMBERS;
    case "green":
      return [0];
    case "even":
      return EVEN_NUMBERS;
    case "odd":
      return ODD_NUMBERS;
    case "1-12":
      return DOZEN_1_12;
    case "13-24":
      return DOZEN_13_24;
    case "25-36":
      return DOZEN_25_36;
    case "1-18":
      return HALF_1_18;
    case "19-36":
      return HALF_19_36;
    default:
      return null;
  }
}

// A bet key is dead when every member number has been eliminated (e.g.
// the "13-24" dozen once 13–24 are off the wheel). `eliminated` is a
// Set of STRING number keys (jsonb object keys are strings).
export function isBetKeyLive(key, eliminated) {
  const nums = betKeyNumbers(key);
  if (!nums || nums.length === 0) return false;
  return nums.some((n) => !eliminated.has(String(n)));
}

export function isValidCallKey(key, eliminated) {
  if (key === null || key === undefined || key === "") return false;
  const k = String(key);
  return betKeyNumbers(k) !== null && isBetKeyLive(k, eliminated);
}

// ── Timing ─────────────────────────────────────────────────────────────
// Duration (in seconds) of each round's betting window. Stored on the
// match row so admin tooling can pull a match's pacing without code
// changes. The per-round `round_deadline` timestamp is computed as
//   now() + round_timer_seconds * 1000
// when a new betting window opens. The per-round betting window is
// also enforced by `fetchMatchWithAutoResolve` so the timer is
// authoritative even if the client never opens its socket or stops
// polling.
export const ROUND_TIMER_SECONDS = 20;
export const ROUND_BET_DEADLINE_MS = ROUND_TIMER_SECONDS * 1000;

// ── Status state machine ───────────────────────────────────────────────
export const MATCH_STATUS = Object.freeze({
  WAITING: "waiting",
  READY: "ready",
  ROUND_1: "round_1",
  ROUND_2: "round_2",
  ROUND_3: "round_3",
  SUDDEN_DEATH: "sudden_death",
  FINISHED: "finished",
  CANCELLED: "cancelled",
});

// States where the match is still in progress (not yet terminal).
// `READY` is in this set so /status polls include it, but bets are
// NOT accepted during the brief "get ready" window (see BETTABLE below).
export const ACTIVE_STATES = new Set([
  MATCH_STATUS.READY,
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.SUDDEN_DEATH,
]);

// States where bets are accepted. `READY` is intentionally excluded:
// it's a brief 3-second auto-transition window after both players
// join. The match view locks the betting panel and the API route
// rejects /bet submissions while in `ready`.
export const BETTABLE_STATES = new Set([
  MATCH_STATUS.ROUND_1,
  MATCH_STATUS.ROUND_2,
  MATCH_STATUS.ROUND_3,
  MATCH_STATUS.SUDDEN_DEATH,
]);

// Auto-advance window between player2 joining and round_1 starting.
export const READY_WINDOW_MS = 3000;

// ── Payout calculation (mirror of save-game/route.js logic) ────────────
export function calculatePayout(bets, spinResult) {
  let winAmount = 0;

  // Guard against weird payloads (null, non-object, primitive)
  if (!bets || typeof bets !== "object") return 0;

  for (const [bet, amount] of Object.entries(bets)) {
    const betAmount = Number(amount);
    if (!Number.isFinite(betAmount) || betAmount <= 0) continue;
    const betKey = Number.isNaN(Number(bet)) ? bet : Number(bet);

    if (typeof betKey === "number" && betKey === spinResult)
      winAmount += betAmount * 35;
    if (betKey === "red" && RED_NUMBERS.includes(spinResult))
      winAmount += betAmount * 2;
    if (
      betKey === "black" &&
      spinResult !== 0 &&
      !RED_NUMBERS.includes(spinResult)
    )
      winAmount += betAmount * 2;
    if (betKey === "green" && spinResult === 0) winAmount += betAmount * 35;
    if (betKey === "even" && spinResult % 2 === 0 && spinResult !== 0)
      winAmount += betAmount * 2;
    if (betKey === "odd" && spinResult % 2 === 1)
      winAmount += betAmount * 2;
    if (betKey === "1-12" && spinResult >= 1 && spinResult <= 12)
      winAmount += betAmount * 3;
    if (betKey === "13-24" && spinResult >= 13 && spinResult <= 24)
      winAmount += betAmount * 3;
    if (betKey === "25-36" && spinResult >= 25 && spinResult <= 36)
      winAmount += betAmount * 3;
    if (betKey === "1-18" && spinResult >= 1 && spinResult <= 18)
      winAmount += betAmount * 2;
    if (betKey === "19-36" && spinResult >= 19 && spinResult <= 36)
      winAmount += betAmount * 2;
  }
  return Number(winAmount.toFixed(2));
}

// ── Spin result generation (server-authoritative) ─────────────────────
// `pool` is the list of live numbers the spin is drawn from. The
// returned index is the position of the winning number in the FULL
// wheel layout (ROULETTE_NUMBERS) so the frontend can animate to the
// right segment without re-deriving the mapping.
export function generateSpinFromPool(pool) {
  const live = pool && pool.length > 0 ? pool : ROULETTE_NUMBERS;
  const spinResult = live[Math.floor(Math.random() * live.length)];
  const spinResultIndex = ROULETTE_NUMBERS.indexOf(spinResult);
  return { spinResultIndex, spinResult };
}

export function generateSpin() {
  return generateSpinFromPool(ROULETTE_NUMBERS);
}

// The bet key(s) carrying the largest single amount (ties all count).
// Empty/zero bets → empty array.
export function biggestWagerKeys(bets) {
  if (!bets || typeof bets !== "object") return [];
  let best = 0;
  const keys = [];
  for (const [k, v] of Object.entries(bets)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      if (n > best) {
        best = n;
        keys.length = 0;
        keys.push(k);
      } else if (n === best) {
        keys.push(k);
      }
    }
  }
  return keys;
}

// Score each player's "call their bet" guess against the opponent's
// actual biggest-wager keys. A correct call yields CALL_BONUS, but the
// transfer is only applied if the payer has the points (resolveRound
// floors it against the payer's balance).
export function resolveCalls(calls, player1Bets, player2Bets) {
  const out = {
    player1: { correct: false, transfer: 0 },
    player2: { correct: false, transfer: 0 },
  };
  const p1 = calls && calls.player1 ? String(calls.player1) : null;
  const p2 = calls && calls.player2 ? String(calls.player2) : null;
  const p2Keys = biggestWagerKeys(player2Bets);
  const p1Keys = biggestWagerKeys(player1Bets);
  if (p1 && p2Keys.includes(p1)) {
    out.player1.correct = true;
    out.player1.transfer = CALL_BONUS;
  }
  if (p2 && p1Keys.includes(p2)) {
    out.player2.correct = true;
    out.player2.transfer = CALL_BONUS;
  }
  return out;
}

// ── Per-round resolution helpers ──────────────────────────────────────
/**
 * Take a (possibly empty) bets payload and return:
 *   - totalBet: sum of all bet amounts
 *   - payout: result of calculatePayout(bets, spinResult)
 *   - net: payout − totalBet
 *
 * Empty `{}` bets are an explicit and valid choice (zero wager,
 * guaranteed zero payout, negative net of zero) — used as the default
 * when a player doesn't bet before the deadline.
 */
export function resolveRoundSide(bets, spinResult) {
  const totalBet = sumBetAmounts(bets);
  const payout = calculatePayout(bets, spinResult);
  const net = Number((payout - totalBet).toFixed(2));
  return { totalBet: Number(totalBet.toFixed(2)), payout, net };
}

export function sumBetAmounts(bets) {
  if (!bets || typeof bets !== "object") return 0;
  let sum = 0;
  for (const v of Object.values(bets)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return Number(sum.toFixed(2));
}

export { ROULETTE_NUMBERS, RED_NUMBERS };
