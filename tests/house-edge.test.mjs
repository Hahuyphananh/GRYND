/**
 * house-edge.test.mjs
 *
 * THE 10% HOUSE EDGE, VERIFIED FOR EVERY GAME THAT MOVES COINS.
 *
 * Two shapes of the same rule:
 *
 *   * PvP — the pot is both stakes, the house keeps 10% of it
 *     (`PVP_RAKE_PCT`), so a win pays exactly 1.8× the winner's own stake.
 *   * House/PvE — return-to-player is capped at `HOUSE_RTP` (0.9), i.e. the
 *     house keeps at least 10%.
 *
 * The first half of this file calls every game's own payout helper and checks
 * the number it returns; the second half reads the settlement sources and
 * refuses a payout that re-derives the split instead of using the shared
 * constant. A game that drifts off 10% therefore fails HERE, not in production.
 *
 * Run:  node --import tsx --test tests/house-edge.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  HOUSE_RTP,
  PVP_RAKE_PCT,
  PVP_WINNER_SHARE,
} from "../src/lib/games/economy.ts";
import { pvpPotPayout } from "../src/lib/tokens/pvpPot.ts";
import { rpsPvpPayout } from "../src/lib/rps-pvp/serverStore.js";
import { oddsPvpPayout } from "../src/lib/odds-pvp/serverStore.ts";
import { ticTacToePayout } from "../src/lib/tic-tac-toe/serverStore.ts";
import { PRECISION_PAYOUT_MULTIPLIER } from "../src/lib/precision/finishMatch.ts";
import { computePayout as kenoPayout } from "../src/lib/keno-pvp/constants.js";
import { computePayout as laneRushPayout } from "../src/lib/lane-rush-duel/constants.js";
import { computePayout as memoryGridPayout } from "../src/lib/memory-grid/constants.js";
import { computePayout as minesPayout } from "../src/lib/mines-pvp/constants.js";
import {
  computePotPrize,
  payoutsByPlacement,
} from "../src/lib/tower-arena/payout.ts";

const STAKE = 100;
/** 2 × stake − 10% of the pot = 1.8 × stake. */
const EXPECTED_WIN = 180;

const read = (path) => fs.readFileSync(path, "utf8");

// ════════════════════════════════════════════════════════════════════════
// 1. The one rule
// ════════════════════════════════════════════════════════════════════════

test("the shared rake is 10% of the pot and the house RTP ceiling is 90%", () => {
  assert.equal(PVP_RAKE_PCT, 0.1);
  assert.equal(PVP_WINNER_SHARE, 0.9);
  assert.equal(HOUSE_RTP, 0.9);
  // The house edge is the same number from both directions.
  assert.equal(Number((1 - PVP_WINNER_SHARE).toFixed(2)), PVP_RAKE_PCT);
  assert.equal(Number((1 - HOUSE_RTP).toFixed(2)), PVP_RAKE_PCT);
});

test("the shared pot helper pays 1.8x and the house keeps 10% of the pot", () => {
  assert.equal(pvpPotPayout(STAKE), EXPECTED_WIN);
  assert.equal(2 * STAKE - pvpPotPayout(STAKE), 2 * STAKE * PVP_RAKE_PCT);
  assert.equal(pvpPotPayout(0), 0);
  assert.equal(pvpPotPayout(undefined), 0);
});

// ════════════════════════════════════════════════════════════════════════
// 2. Every PvP game pays through the same arithmetic
// ════════════════════════════════════════════════════════════════════════

test("each PvP game's own payout helper returns 1.8x", () => {
  const helpers = {
    "rps-pvp": rpsPvpPayout(STAKE),
    "odds-pvp": oddsPvpPayout(STAKE),
    "tic-tac-toe": ticTacToePayout(STAKE),
    "tower-arena": payoutsByPlacement({
      prizePool: computePotPrize({ wager: STAKE }).prizePool,
    })[0],
  };
  for (const [game, paid] of Object.entries(helpers)) {
    assert.equal(Number(paid), EXPECTED_WIN, `${game} must pay 1.8x`);
  }

  const pots = {
    "keno-pvp": kenoPayout({ stakeAmount: STAKE, result: "player1" }),
    "lane-rush-duel": laneRushPayout({ stakeAmount: STAKE, result: "player1" }),
    "memory-grid": memoryGridPayout({ stakeAmount: STAKE, result: "player1" }),
    "mines-pvp": minesPayout({ stakeAmount: STAKE, result: "player1" }),
  };
  for (const [game, pot] of Object.entries(pots)) {
    assert.equal(Number(pot.winnerNet), EXPECTED_WIN, `${game} winner must net 1.8x`);
    assert.equal(
      Number(pot.houseFee),
      2 * STAKE * PVP_RAKE_PCT,
      `${game} house fee must be 10% of the pot`,
    );
  }
});

test("Tower Arena's pot takes exactly the shared rake", () => {
  const pot = computePotPrize({ wager: STAKE });
  assert.equal(pot.pot, 2 * STAKE);
  assert.equal(pot.houseFee, 2 * STAKE * PVP_RAKE_PCT);
  assert.equal(pot.prizePool, EXPECTED_WIN);
  // The allocation never exceeds the pool it was given.
  const paid = payoutsByPlacement({ prizePool: pot.prizePool });
  assert.equal(
    paid.reduce((a, b) => a + b, 0),
    pot.prizePool,
  );
});

test("games that settle with the shared multiplier advertise 1.8x", () => {
  assert.equal(Number((PRECISION_PAYOUT_MULTIPLIER * STAKE).toFixed(2)), 180);
  // Hex Duel's end-game and multiplayer routes derive it from PVP_WINNER_SHARE.
  assert.match(
    read("src/app/api/hex-duel/end-game/route.ts"),
    /const PAYOUT_MULTIPLIER = 2 \* PVP_WINNER_SHARE;/,
  );
  // Pool Masters settles through the same pot helper.
  assert.match(
    read("src/app/api/pool/submit-shot/route.ts"),
    /payPvpPot\(\{/,
  );
  assert.match(read("src/app/api/pool/resign/route.ts"), /payPvpPot\(\{/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. No settlement invents its own split
// ════════════════════════════════════════════════════════════════════════

test("no staked settlement pays a flat 2x pot (0% edge)", () => {
  const files = [
    "src/app/api/chess/end-game/route.js",
    "src/app/api/chess/move/route.js",
    "src/app/api/chess/game-state/route.js",
    "src/app/api/dice-flush/_lib.js",
    "src/app/api/uno/determine-winner/route.js",
    "src/app/api/uno/resign/route.js",
    "src/lib/barricade/serverStore.ts",
    "src/lib/mini-golf/serverStore.ts",
    "src/lib/solitaire-duel/serverStore.ts",
    "src/lib/speed-typing/serverStore.ts",
    "src/lib/sudoku-duel/serverStore.ts",
    "src/lib/keno-pvp/serverStore.js",
    "src/lib/lane-rush-duel/serverStore.js",
    "src/lib/memory-grid/serverStore.js",
    "src/lib/mines-pvp/serverStore.js",
    "src/lib/dotsAndBoxesServer.js",
    "src/lib/fourInARowServer.js",
    "src/lib/tower-arena/payout.ts",
    "src/lib/tokens/pvpPot.ts",
    "src/lib/rps-pvp/serverStore.js",
    "src/lib/odds-pvp/serverStore.ts",
    "src/lib/tic-tac-toe/serverStore.ts",
    "src/lib/precision/finishMatch.ts",
    "src/app/api/rps/play/route.js",
    "src/lib/hex-duel/settle.ts",
    "src/app/api/pool/submit-shot/route.ts",
    "src/app/api/pool/resign/route.ts",
    "src/lib/pool/lobbyJoin.ts",
  ];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(
      src,
      /payout\s*[:=]\s*(?:Number\(\()?\s*(?:wager|stake|bet|amount)\s*\*\s*2\b/,
      `${file} must not pay a bare 2x pot (0% house edge)`,
    );
    assert.doesNotMatch(
      src,
      /(?:wager|stake|bet|amount)\s*\*\s*2\b(?!\s*\*\s*(?:PVP_WINNER_SHARE|PVP_RAKE_PCT|\(1 - PVP_RAKE_PCT\)))/,
      `${file} must not multiply a wager by 2 without the rake`,
    );
  }
});

test("every staked game derives its pot from the shared 10% rake", () => {
  // Games that use the pot helper directly.
  const helperUsers = [
    "src/app/api/chess/end-game/route.js",
    "src/app/api/chess/move/route.js",
    "src/app/api/chess/game-state/route.js",
    "src/app/api/dice-flush/_lib.js",
    "src/app/api/dice-flush/resign/route.js",
    "src/app/api/uno/determine-winner/route.js",
    "src/app/api/uno/resign/route.js",
    "src/lib/barricade/serverStore.ts",
    "src/lib/mini-golf/serverStore.ts",
    "src/lib/solitaire-duel/serverStore.ts",
    "src/lib/speed-typing/serverStore.ts",
    "src/lib/sudoku-duel/serverStore.ts",
    "src/lib/hex-duel/settle.ts",
    "src/app/api/pool/submit-shot/route.ts",
    "src/app/api/pool/resign/route.ts",
  ];
  for (const file of helperUsers) {
    assert.match(read(file), /payPvpPot\(/, `${file} must settle the pot via payPvpPot`);
  }

  // Games with their own helper, each pinned to the shared constant.
  for (const file of [
    "src/lib/rps-pvp/serverStore.js",
    "src/lib/odds-pvp/serverStore.ts",
    "src/lib/tic-tac-toe/serverStore.ts",
  ]) {
    assert.match(
      read(file),
      /2 \* (?:stake|amount) \* PVP_WINNER_SHARE/,
      `${file} must derive its pot from PVP_WINNER_SHARE`,
    );
  }
  for (const file of ["src/lib/dotsAndBoxesServer.js", "src/lib/fourInARowServer.js"]) {
    assert.match(
      read(file),
      /2 \* bet \* \(1 - PVP_RAKE_PCT\)/,
      `${file} must derive its pot from PVP_RAKE_PCT`,
    );
  }
});

test("the four constants modules agree on the 20%-of-loser's-stake split", () => {
  for (const file of [
    "src/lib/keno-pvp/constants.js",
    "src/lib/lane-rush-duel/constants.js",
    "src/lib/memory-grid/constants.js",
    "src/lib/mines-pvp/constants.js",
  ]) {
    const src = read(file);
    // 20% of the LOSER's stake is 10% of the two-stake pot — the same edge.
    assert.match(src, /export const HOUSE_FEE_PCT = 0\.20?\b/, `${file} fee rate`);
    assert.match(src, /export const WINNER_RATIO = 0\.80?\b/, `${file} winner ratio`);
    assert.match(src, /export const HOUSE_RATIO = 0\.20?\b/, `${file} house ratio`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4. Nothing advertises a prize the ledger will not pay
// ════════════════════════════════════════════════════════════════════════

test("the vs-AI odds status does not advertise an unpayable 2x pot", () => {
  const src = read("src/app/api/odds/ai/status/route.ts");
  assert.doesNotMatch(src, /payout:\s*game\.wager \* 2/);
  assert.match(src, /payout: 0,/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. The games added last are staked at the same rate
// ════════════════════════════════════════════════════════════════════════

test("Pool Masters and Hex Duel require a stake and escrow both seats", () => {
  for (const [file, gate] of [
    ["src/app/api/pool/create-lobby/route.ts", /requireStake\(wager, "pool"\)/],
    ["src/app/api/hex-duel/multiplayer/create/route.ts", /requireStake\(wager, "hex-duel"\)/],
  ]) {
    assert.match(read(file), gate, `${file} must require a legal stake`);
  }
  for (const [file, game] of [
    ["src/lib/pool/lobbyJoin.ts", /gameKey: "pool"/],
    ["src/app/api/hex-duel/multiplayer/join/route.ts", /gameKey: "hex-duel"/],
  ]) {
    const src = read(file);
    assert.match(src, /escrowMatchWagers\(/, `${file} must escrow both seats`);
    assert.match(src, game, `${file} must tag the ledger with its game key`);
  }
});
