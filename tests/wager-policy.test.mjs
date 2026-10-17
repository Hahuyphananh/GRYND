/**
 * wager-policy.test.mjs
 *
 * Wagering is back and balanced. This pins the policy seam
 * (src/lib/games/stakes.js) and the economy constants it reads
 * (src/lib/games/economy.ts), plus the fact that every stake-taking store
 * forwards its verdict instead of re-implementing the range.
 *
 * Run:  node --import tsx --test tests/wager-policy.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FREE_STAKE,
  MAX_STAKE,
  MIN_STAKE,
  STAKE_LABEL,
  WAGER_CAPS,
  WAGERING_ENABLED,
  isStakeAccepted,
  maxStakeFor,
  normalizeStake,
  tokensMoveForMatches,
  validateWager,
} from "../src/lib/games/stakes.js";

import {
  DAILY_ENERGY_GRANT,
  ENERGY_GRANT_FLOOR,
  GLOBAL_MAX_BET,
  HIGH_VARIANCE_MAX_BET,
  HOUSE_RTP,
  MAX_WIN_PER_MATCH,
  PVP_RAKE_PCT,
  STARTING_COINS,
  WALLET_HARD_CAP,
} from "../src/lib/games/economy.ts";

// ════════════════════════════════════════════════════════════════════════
// 1. The seam itself
// ════════════════════════════════════════════════════════════════════════

test("wagering is enabled and a match may move coins", () => {
  assert.equal(WAGERING_ENABLED, true);
  assert.equal(tokensMoveForMatches(), true);
  assert.equal(FREE_STAKE, 0);
  assert.equal(MIN_STAKE, 1);
  assert.equal(MAX_STAKE, GLOBAL_MAX_BET);
  assert.equal(STAKE_LABEL, "Coins");
});

// ════════════════════════════════════════════════════════════════════════
// 2. The balanced economy — no account can reach millions
// ════════════════════════════════════════════════════════════════════════

test("the economy constants are balanced and bounded", () => {
  assert.equal(STARTING_COINS, 1_000);
  assert.equal(DAILY_ENERGY_GRANT, 500);
  assert.equal(ENERGY_GRANT_FLOOR, 500);
  assert.equal(GLOBAL_MAX_BET, 100);
  assert.equal(HIGH_VARIANCE_MAX_BET, 25);
  assert.equal(MAX_WIN_PER_MATCH, 1_000);
  assert.equal(HOUSE_RTP, 0.9);
  assert.equal(WALLET_HARD_CAP, 100_000);
  assert.equal(PVP_RAKE_PCT, 0.1);
});

test("the balanced economy cannot mint millions", () => {
  // A day's grant never exceeds the floor the player is refilled to, so it
  // cannot be farmed above it.
  assert.ok(DAILY_ENERGY_GRANT <= ENERGY_GRANT_FLOOR);
  // A wager never exceeds the wallet a player can actually hold, and a single
  // win is capped well below the wallet ceiling.
  assert.ok(GLOBAL_MAX_BET <= WALLET_HARD_CAP);
  assert.ok(MAX_WIN_PER_MATCH <= WALLET_HARD_CAP);
  // The final guarantee: the wallet ceiling is the hard bound, and it is two
  // orders of magnitude below "millions".
  assert.ok(WALLET_HARD_CAP < 1_000_000);
  // The house never pays out more than it takes.
  assert.ok(HOUSE_RTP < 1);
});

// ════════════════════════════════════════════════════════════════════════
// 3. validateWager — the entry-point gate
// ════════════════════════════════════════════════════════════════════════

test("a zero / absent wager is a legal free match", () => {
  for (const requested of [0, "0", undefined, null, ""]) {
    assert.deepEqual(
      validateWager(requested),
      { ok: true, stake: 0 },
      `validateWager(${String(requested)}) must be a free match`,
    );
  }
});

test("validateWager accepts a whole wager inside the range", () => {
  for (const requested of [1, 5, 50, 100, "25"]) {
    const result = validateWager(requested);
    assert.equal(result.ok, true);
    assert.equal(result.stake, Number(requested));
  }
});

test("validateWager rejects anything outside the range or not a whole coin", () => {
  for (const requested of [-1, -0.5, 0.5, 1.5, 101, 1_000_000, "abc", NaN, Infinity, {}]) {
    const result = validateWager(requested);
    assert.equal(result.ok, false, `validateWager(${String(requested)}) must fail`);
    assert.equal(result.status, 400);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4. Per-game ceilings
// ════════════════════════════════════════════════════════════════════════

test("maxStakeFor defaults to the global cap and honours overrides", () => {
  // No game in the current catalogue is high-variance: every wager gets the
  // global ceiling.
  assert.deepEqual(WAGER_CAPS, {});
  for (const gameKey of ["keno", "mines", "tower-arena", "uno", undefined, ""]) {
    assert.equal(maxStakeFor(gameKey), GLOBAL_MAX_BET, `cap for ${String(gameKey)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 5. normalizeStake — the permissive legacy clamp
// ════════════════════════════════════════════════════════════════════════

test("normalizeStake clamps to the cap and never yields an illegal wager", () => {
  assert.equal(normalizeStake(500), MAX_STAKE); // over-cap → clamped, not dropped
  assert.equal(normalizeStake("50"), 50);
  assert.equal(normalizeStake(50.9), 50); // whole coins only
  assert.equal(normalizeStake(0.5), 0); // rounds down to nothing
  for (const requested of [-5, 0, NaN, Infinity, null, undefined, "abc", {}]) {
    assert.equal(normalizeStake(requested), 0, `normalizeStake(${String(requested)})`);
  }
});

test("isStakeAccepted is true only for a legal positive wager", () => {
  assert.equal(isStakeAccepted(0), false);
  assert.equal(isStakeAccepted(undefined), false);
  assert.equal(isStakeAccepted(1), true);
  assert.equal(isStakeAccepted(100), true);
  assert.equal(isStakeAccepted(101), false);
  assert.equal(isStakeAccepted(-5), false);
});

// ════════════════════════════════════════════════════════════════════════
// 6. The stores forward the policy verdict (no per-game drift)
// ════════════════════════════════════════════════════════════════════════

const STORES = [
  "src/lib/keno-pvp/serverStore.js",
  "src/lib/lane-rush-duel/serverStore.js",
  "src/lib/memory-grid/serverStore.js",
  "src/lib/mines-pvp/serverStore.js",
  "src/lib/tower-arena/serverStore.ts",
];

test("every stake-taking store delegates to validateWager", () => {
  for (const file of STORES) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /validateWager\(/,
      `${file} must take its wager verdict from the policy`,
    );
    assert.doesNotMatch(
      src,
      /Stake must be a number in/,
      `${file} still re-implements the wager range`,
    );
    assert.doesNotMatch(
      src,
      /STAKES_RETIRED/,
      `${file} still branches on the retired-stakes flag`,
    );
  }
});
