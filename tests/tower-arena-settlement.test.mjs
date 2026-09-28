/**
 * Tower Arena — settlement tests.
 *
 * Verifies the centralized payout/settlement contract for a 1v1 tower:
 *   pot = 2 × wager;  house = floor(pot × PVP_RAKE_PCT);
 *   prizePool = pot − house;   the winner takes the whole prize pool and the
 *   runner-up takes nothing, so payouts sum EXACTLY to the prize pool and
 *   never exceed it.
 *
 * The shared-table weight tables (3–6 seats) were removed with the
 * multiplayer mode; there is no seat count to vary over any more.
 *
 * Run:  node --import tsx --test tests/tower-arena-settlement.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  computePotPrize,
  payoutsByPlacement,
  payoutForPlacement,
  netForPlacement,
  paidPlacementsFor,
  PAYOUT_WEIGHTS,
} from "../src/lib/tower-arena/payout.ts";
import { SEATS } from "../src/lib/tower-arena/engine.ts";

test("1v1 @100: winner-take-all — 2nd place forfeits exactly the wager", () => {
  const wager = 100;
  const cfg = computePotPrize({ wager });
  assert.equal(cfg.maxPlayers, 2);
  assert.equal(cfg.pot, 200);
  assert.equal(cfg.houseFee, 10);
  assert.equal(cfg.prizePool, 190);

  const payouts = payoutsByPlacement({ prizePool: cfg.prizePool });
  assert.deepEqual(payouts, [190, 0]);

  // Winner nets +90; runner-up nets exactly −100.
  assert.equal(netForPlacement({ wager, prizePool: cfg.prizePool, placement: 1 }), 90);
  assert.equal(netForPlacement({ wager, prizePool: cfg.prizePool, placement: 2 }), -100);
  // Winner takes the entire prize pool (winner-take-most after rake).
  assert.equal(payouts[0], cfg.prizePool);
});

test("every wager: sums exactly to the prize pool, never exceeds it, all ≥ 0", () => {
  for (const w of [0, 1, 3, 7, 25, 100, 333, 777, 1000, 5000]) {
    const cfg = computePotPrize({ wager: w });
    assert.equal(cfg.pot, 2 * w, `pot = 2w for wager ${w}`);
    assert.ok(cfg.houseFee >= 0 && cfg.houseFee <= cfg.pot);
    assert.equal(cfg.prizePool, cfg.pot - cfg.houseFee);

    const payouts = payoutsByPlacement({ prizePool: cfg.prizePool });
    assert.equal(payouts.length, 2);
    assert.equal(payouts.reduce((a, b) => a + b, 0), cfg.prizePool, `W=${w} sums to prize`);
    for (const p of payouts) {
      assert.ok(Number.isInteger(p) && p >= 0 && p <= cfg.prizePool, `in-range payout W=${w}`);
    }
    assert.ok(Math.max(...payouts) <= cfg.prizePool);
  }
});

test("the winner is always the strictly top paid slot", () => {
  for (const w of [10, 50, 100, 999]) {
    const cfg = computePotPrize({ wager: w });
    const payouts = payoutsByPlacement({ prizePool: cfg.prizePool });
    assert.ok(payouts[0] >= payouts[1], `W=${w} placement 1 >= 2`);
    assert.equal(payouts[0], Math.max(...payouts), `W=${w} winner has the largest payout`);
    assert.ok(payouts[0] > 0, `W=${w} winner is always paid`);
    // The runner-up is never paid: 1v1 is winner-take-all.
    assert.equal(payouts[1], 0);
  }
});

test("house rake is applied once and payouts never leak beyond the pot", () => {
  for (const w of [10, 100, 1000]) {
    const cfg = computePotPrize({ wager: w });
    const payouts = payoutsByPlacement({ prizePool: cfg.prizePool });
    const paidOut = payouts.reduce((a, b) => a + b, 0);
    assert.ok(paidOut <= cfg.pot, `W=${w} paid out <= pot`);
    assert.equal(paidOut, cfg.prizePool);
  }
});

test("payoutForPlacement agrees with the table and clamps out-of-range placements", () => {
  const cfg = computePotPrize({ wager: 25 });
  const all = payoutsByPlacement({ prizePool: cfg.prizePool });
  for (let i = 0; i < all.length; i += 1) {
    assert.equal(payoutForPlacement({ prizePool: cfg.prizePool, placement: i + 1 }), all[i]);
  }
  // Out-of-range placements clamp: 0 → first (winner), 99 → last (runner-up).
  assert.equal(payoutForPlacement({ prizePool: cfg.prizePool, placement: 0 }), all[0]);
  assert.equal(payoutForPlacement({ prizePool: cfg.prizePool, placement: 99 }), all[all.length - 1]);
});

test("the weight table is 1v1 only", () => {
  assert.deepEqual(Object.keys(PAYOUT_WEIGHTS), [String(SEATS)]);
  assert.deepEqual(PAYOUT_WEIGHTS[SEATS], [1, 0]);
  assert.equal(PAYOUT_WEIGHTS[SEATS].length, SEATS);
  // No shared-table rows survive.
  for (const n of [3, 4, 5, 6]) {
    assert.equal(PAYOUT_WEIGHTS[n], undefined, `no weights for ${n} players`);
  }
});

test("paidPlacementsFor is the winner only", () => {
  assert.equal(paidPlacementsFor(), 1);
  assert.equal(
    paidPlacementsFor(),
    PAYOUT_WEIGHTS[SEATS].filter((w) => w > 0).length,
  );
});
