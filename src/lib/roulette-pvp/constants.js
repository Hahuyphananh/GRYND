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
} from "../rouletteConfig";

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
export function generateSpin() {
  // Spin-result index is the position of the winning number in
  // ROULETTE_NUMBERS. The frontend already knows the wheel layout, so
  // returning both the index AND the number lets the client animate to
  // the right segment without re-deriving the mapping.
  const spinResultIndex = Math.floor(Math.random() * ROULETTE_NUMBERS.length);
  const spinResult = ROULETTE_NUMBERS[spinResultIndex];
  return { spinResultIndex, spinResult };
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
