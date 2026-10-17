// tests/duel-pvp-stakes.test.mjs
//
// The five duel lobbies (Sudoku Duel, Solitaire Duel, Barricade, Mini Golf,
// Speed Typing) were unstaked. They are now coin matches in PvP and stay free
// vs the bot:
//
//   * the entry route REQUIRES a legal positive stake and passes it to the
//     store, so a missing stake can never silently open free play;
//   * the store only ever joins a lobby AT THE CALLER'S STAKE;
//   * both seats are escrowed when the second one joins (all-or-nothing, inside
//     the claim transaction);
//   * the winner is paid the pot (both stakes) minus the shared 10% rake, and a
//     draw / tie refunds both seats;
//   * the vs-AI route never debits and never pays out.
//
// Run:  node --import tsx --test tests/duel-pvp-stakes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pvpPotPayout } from "../src/lib/tokens/pvpPot.ts";
import { PVP_RAKE_PCT } from "../src/lib/games/economy.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const GAMES = [
  {
    key: "sudoku-duel",
    route: "src/app/api/sudoku-duel/create-or-join/route.ts",
    store: "src/lib/sudoku-duel/serverStore.ts",
    storeKey: "sudoku-duel",
  },
  {
    key: "solitaire-duel",
    route: "src/app/api/solitaire-duel/create-or-join/route.ts",
    store: "src/lib/solitaire-duel/serverStore.ts",
    storeKey: "solitaire-duel",
  },
  {
    key: "barricade",
    route: "src/app/api/barricade/create-or-join/route.ts",
    store: "src/lib/barricade/serverStore.ts",
    storeKey: "barricade",
    // Barricade ends only by conquest or forfeit — there is no draw branch, so
    // there is nothing to refund on a tie.
    canDraw: false,
  },
  {
    key: "mini-golf",
    route: "src/app/api/mini-golf/create-or-join/route.ts",
    store: "src/lib/mini-golf/serverStore.ts",
    storeKey: "mini-golf",
  },
  {
    key: "speed-typing",
    route: "src/app/api/speed-typing/create-or-join/route.ts",
    store: "src/lib/speed-typing/serverStore.ts",
    storeKey: "speed-typing",
  },
];

test("shared pot math: 1.8× the winner's stake, a tenth of the pot to the house", () => {
  assert.equal(PVP_RAKE_PCT, 0.1);
  for (const stake of [1, 5, 10, 25, 100]) {
    const pot = 2 * stake;
    assert.equal(pvpPotPayout(stake), Number((stake * 1.8).toFixed(2)));
    assert.equal(
      Number((pot - pvpPotPayout(stake)).toFixed(2)),
      Number((pot * PVP_RAKE_PCT).toFixed(2)),
    );
  }
  assert.equal(pvpPotPayout(0), 0, "a free match pays nothing");
});

for (const game of GAMES) {
  test(`${game.key}: the PvP entry requires a stake and hands it to the store`, () => {
    const route = read(game.route);
    assert.match(route, new RegExp(`requireStake\\(body\\?\\.stake, "${game.key}"\\)`));
    assert.match(route, /if \(!required\.ok\)/);
    assert.match(route, /stake: required\.stake/);
    // The store's answer for an unfundable seat is a client error, not a 500.
    assert.match(route, /status && status < 500/);
  });

  test(`${game.key}: only a lobby at the caller's stake is joinable`, () => {
    const store = read(game.store);
    assert.match(store, /const stakeAmount = Number\(stake\) > 0 \? Number\(stake\) : 0;/);
    assert.match(store, /stakeAmount\} = \$\{stakeAmount\}/);
    assert.match(store, /stakeAmount: stakeAmount\.toFixed\(2\)/);
  });

  test(`${game.key}: both seats are escrowed when the second one joins`, () => {
    const store = read(game.store);
    assert.match(store, /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/);
    assert.match(store, /clerkIds: \[updated\.player1Id, userId\]/);
    assert.match(store, /stake: stakeAmount,/);
    assert.match(store, new RegExp(`gameKey: "${game.storeKey}"`));
    assert.match(store, /Insufficient coins/);
  });

  test(`${game.key}: settlement pays the winner${game.canDraw === false ? "" : " and refunds a draw"}`, () => {
    const store = read(game.store);
    if (game.canDraw !== false) {
      assert.match(store, /await refundPvpPot\(\{/);
    }
    assert.match(store, /await payPvpPot\(\{/);
    assert.match(store, /winnerClerkId/);
    // The ledger's rake is recorded as a tenth of the pot (0.2 × each stake).
    assert.match(store, /houseFee[^\n]*\(stake(Amount)? \* 0\.2\)\.toFixed\(2\)|houseFee\.toFixed\(2\)/);
    assert.match(store, /prizePaid: payout\.toFixed\(2\)/);
  });
}

test("every practice path stays free and never touches the ledger", () => {
  const aiRoutes = [
    "src/app/api/sudoku-duel/create-ai/route.ts",
    "src/app/api/solitaire-duel/create-ai/route.ts",
    "src/app/api/mini-golf/create-ai/route.ts",
    "src/app/api/speed-typing/create-ai/route.ts",
    "src/app/api/pool/create-ai-match/route.ts",
  ];
  for (const path of aiRoutes) {
    const source = read(path);
    assert.doesNotMatch(source, /escrowMatchWagers/, `${path} must not escrow`);
    assert.doesNotMatch(source, /debitWager/, `${path} must not debit`);
    assert.doesNotMatch(source, /payPvpPot/, `${path} must not pay out`);
  }
});
