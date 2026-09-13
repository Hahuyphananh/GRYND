import test from "node:test";
import assert from "node:assert/strict";
import {
  createHand,
  applyFold,
  curveMultiplierAt,
  isCrashDueAt,
  resolveHand,
  handFromEntries,
  pauseHandOnFold,
  resumePauseIfDue,
} from "../src/lib/crash-poker/roundSystem.js";
import {
  CRASH_GROWTH_RATE,
  PLATFORM_FEE,
  FOLD_PAUSE_MS,
} from "../src/lib/crash-poker/constants.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const SIX_PLAYERS = Array.from({ length: 6 }, (_, i) => ({
  userId: i + 1,
  name: `P${i + 1}`,
}));

function player(hand, userId) {
  return hand.players.find((p) => p.userId === userId);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Build a hand and fold a sequence of players: [userId, multiplier][] */
function handWithFolds(folds, { players = SIX_PLAYERS, wager = 10, carryOver = 0 } = {}) {
  let hand = createHand({ players, wager, carryOver });
  for (const [userId, multiplier] of folds) {
    const res = applyFold(hand, { userId, multiplier });
    assert.ok(!res.error, `fold of user ${userId} failed: ${res.error}`);
    hand = res.hand;
  }
  return hand;
}

// ── Opening (flat ante) ────────────────────────────────────────────────────

test("every player posts the wager as a flat ante — no blinds, no roles", () => {
  const hand = createHand({ players: SIX_PLAYERS, wager: 10 });
  assert.equal(hand.wager, 10);
  assert.equal(hand.pot, 60); // 6 × $10
  for (const p of hand.players) {
    assert.equal(p.contributed, 10);
    assert.equal(p.lastAction, "ante");
    assert.equal(p.allIn, false);
    assert.equal(p.isActive, true);
  }
  // No roles/blinds ever appear on the hand.
  assert.equal(hand.smallBlind, undefined);
  assert.equal(hand.bigBlind, undefined);
  assert.equal(hand.dealerPosition, undefined);
});

test("a short stack posts everything and is all-in on the ante; broke players sit out", () => {
  const stackByUser = new Map([
    [1, 50], // fine
    [2, 3],  // short — all-in $3
    [3, 0],  // broke — left out
    [4, 50],
    [5, 50],
    [6, 0.01], // exactly the floor — all-in $0.01
  ]);
  const hand = createHand({ players: SIX_PLAYERS, wager: 10, stackByUser });
  assert.equal(player(hand, 2).contributed, 3);
  assert.equal(player(hand, 2).allIn, true);
  assert.equal(player(hand, 3).contributed, 0);
  assert.equal(player(hand, 3).isActive, false);
  assert.equal(player(hand, 6).contributed, 0.01);
  assert.equal(player(hand, 6).allIn, true);
  assert.equal(hand.players.filter((p) => p.isActive).length, 5);
  assert.equal(hand.pot, 10 + 3 + 10 + 10 + 0.01); // 33.01
});

test("carry-over is added to the pot", () => {
  const hand = createHand({ players: SIX_PLAYERS, wager: 10, carryOver: 40 });
  assert.equal(hand.pot, 100);
  assert.equal(hand.carryOver, 40);
});

// ── The continuous curve ───────────────────────────────────────────────────

test("the curve climbs continuously from 1.00x at hand start", () => {
  const hand = createHand({ players: SIX_PLAYERS, wager: 10, startedAt: 1_000_000 });
  assert.ok(Math.abs(curveMultiplierAt(hand, hand.flightResumedAt) - 1.0) < 1e-9);
  const at = curveMultiplierAt(hand, hand.flightResumedAt + 1000);
  assert.ok(Math.abs(at - Math.exp(CRASH_GROWTH_RATE)) < 1e-6);
  // It keeps climbing forever (no checkpoint holds it).
  const later = curveMultiplierAt(hand, hand.flightResumedAt + 60_000);
  assert.ok(later > at);
});

// ── Fold pauses (the server freezes the curve for the reveal) ─────────────

test("a fold pause freezes the multiplier for FOLD_PAUSE_MS, then resumes from the same value", () => {
  const t0 = 1_000_000;
  const hand = createHand({ players: SIX_PLAYERS, wager: 10, startedAt: t0 });
  const foldAt = t0 + 2000;
  const frozen = curveMultiplierAt(hand, foldAt); // exp(rate·2)
  const paused = pauseHandOnFold(hand, foldAt);

  assert.equal(paused.pausedSince, foldAt);
  assert.equal(paused.pausedUntil, foldAt + FOLD_PAUSE_MS);

  // Mid-window: the curve is FROZEN at the fold multiplier.
  assert.ok(Math.abs(curveMultiplierAt(paused, foldAt + 1000) - frozen) < 1e-9);
  // At the deadline the hold still stands (pause window is open until `until`).
  assert.ok(Math.abs(curveMultiplierAt(paused, foldAt + FOLD_PAUSE_MS) - frozen) < 1e-9);

  // Resume the instant the window closes: the clock re-bases so the frozen
  // interval adds nothing to the crash timeline.
  const after = foldAt + FOLD_PAUSE_MS + 500;
  const { hand: resumed, resumed: didResume } = resumePauseIfDue(paused, after);
  assert.equal(didResume, true);
  assert.equal(resumed.pausedSince, null);
  assert.equal(resumed.pausedUntil, null);
  assert.equal(resumed.pausedTotalMs, FOLD_PAUSE_MS + 500); // foldAt → after
  assert.ok(Math.abs(curveMultiplierAt(resumed, after) - frozen) < 1e-9);

  // Later: the curve keeps climbing from the frozen value.
  const later = curveMultiplierAt(resumed, after + 1000);
  assert.ok(Math.abs(later - Math.exp(CRASH_GROWTH_RATE * 3.0)) < 1e-6);
  assert.ok(later > frozen);
});

test("a fold during an open pause EXTENDS the window; the curve stays frozen", () => {
  const t0 = 1_000_000;
  const hand = createHand({ players: SIX_PLAYERS, wager: 10, startedAt: t0 });
  const foldAt = t0 + 2000;
  const frozen = curveMultiplierAt(hand, foldAt);
  const paused = pauseHandOnFold(hand, foldAt);

  // Second fold while the first window is open — extends the deadline.
  const secondFoldAt = foldAt + 1000;
  const extended = pauseHandOnFold(paused, secondFoldAt);
  assert.equal(extended.pausedSince, foldAt); // window stays anchored at entry
  assert.equal(extended.pausedUntil, secondFoldAt + FOLD_PAUSE_MS);

  // Between the old deadline and the new one the hand is STILL paused.
  const between = foldAt + FOLD_PAUSE_MS + 500; // past first window
  const { resumed: early } = resumePauseIfDue(extended, between);
  assert.equal(early, false);
  assert.ok(Math.abs(curveMultiplierAt(extended, between) - frozen) < 1e-9);

  // Once the extended window ends, the pause closes and the curve resumes
  // from the exact frozen multiplier.
  const { hand: resumed, resumed: didResume } = resumePauseIfDue(
    extended,
    extended.pausedUntil + 1000,
  );
  assert.equal(didResume, true);
  assert.equal(resumed.pausedTotalMs, extended.pausedUntil - foldAt + 1000);
  assert.ok(Math.abs(curveMultiplierAt(resumed, extended.pausedUntil + 1000) - frozen) < 1e-9);
});

test("no pause fields → curveMultiplierAt is a plain continuous flight (legacy hands)", () => {
  const t0 = 1_000_000;
  const hand = {
    flightResumedAt: t0,
    players: SIX_PLAYERS,
  };
  const at = curveMultiplierAt(hand, t0 + 1000);
  assert.ok(Math.abs(at - Math.exp(CRASH_GROWTH_RATE)) < 1e-6);
  const { resumed } = resumePauseIfDue(hand, t0 + 1000);
  assert.equal(resumed, false);
});

test("handFromEntries restores the fold-pause fields", () => {
  const hand = handFromEntries({
    round: {
      bigBlind: 10,
      handState: {
        flightResumedAt: 1234,
        pausedSince: 2000,
        pausedUntil: 5000,
        pausedTotalMs: 3000,
      },
    },
    entries: [
      { userId: 1, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: false, result: "pending" },
    ],
    carryOver: 0,
  });
  assert.equal(hand.pausedSince, 2000);
  assert.equal(hand.pausedUntil, 5000);
  assert.equal(hand.pausedTotalMs, 3000);
  // Missing on legacy hands → zeros, i.e. no pause (plain continuous flight).
  const legacy = handFromEntries({
    round: { bigBlind: 10, handState: null },
    entries: [
      { userId: 1, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: false, result: "pending" },
    ],
    carryOver: 0,
  });
  assert.equal(legacy.pausedSince, null);
  assert.equal(legacy.pausedUntil, null);
  assert.equal(legacy.pausedTotalMs, 0);
});

test("isCrashDueAt fires only once the curve reaches the crash point", () => {
  const hand = createHand({ players: SIX_PLAYERS, wager: 10, startedAt: 1_000_000 });
  const crashPoint = 2.0;
  // Rate-agnostic: crash at 2.0 lands at t = ln(2)/GROWTH_RATE (~6.3s at 0.11).
  const dueAtMs = (Math.log(2) / CRASH_GROWTH_RATE) * 1000;
  assert.equal(isCrashDueAt(hand, hand.flightResumedAt + dueAtMs - 1000, crashPoint), false);
  assert.equal(isCrashDueAt(hand, hand.flightResumedAt + dueAtMs + 1000, crashPoint), true);
});

// ── Folding ────────────────────────────────────────────────────────────────

test("a fold records the server-authoritative multiplier and keeps the ante in the pot", () => {
  const hand = handWithFolds([[4, 1.5]]);
  const p4 = player(hand, 4);
  assert.equal(p4.folded, true);
  assert.equal(p4.isActive, false);
  assert.equal(p4.foldedAtMultiplier, 1.5);
  assert.equal(p4.lastAction, "fold");
  assert.equal(hand.pot, 60); // ante stays in the pot as dead money
  assert.equal(hand.actions.length, 1);
});

test("a fold leaving exactly one active player ends the hand (fold-out)", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  const hand = createHand({ players: two, wager: 10 });
  const res = applyFold(hand, { userId: 1, multiplier: 1.4 });
  assert.ok(!res.error, res.error);
  assert.equal(res.handOver, true);
  assert.equal(res.winnerUserId, 2);
});

test("an all-in player is committed and cannot fold", () => {
  const stackByUser = new Map([[1, 50], [2, 5]]); // B all-in at $5
  const hand = createHand({ players: SIX_PLAYERS, wager: 10, stackByUser });
  const res = applyFold(hand, { userId: 2, multiplier: 2.0 });
  assert.ok(res.error);
  assert.match(res.error, /all-in/i);
});

test("a player who is not active (already folded / out of the hand) cannot fold", () => {
  let hand = handWithFolds([[4, 1.5]]);
  const res = applyFold(hand, { userId: 4, multiplier: 2.0 });
  assert.ok(res.error);
  assert.match(res.error, /not active/i);
  // A broke player never entered the hand.
  const stackByUser = new Map([[1, 50], [2, 0]]);
  const broke = createHand({ players: SIX_PLAYERS, wager: 10, stackByUser });
  const res2 = applyFold(broke, { userId: 2, multiplier: 1.5 });
  assert.ok(res2.error);
});

// ── Settlement (rank-based payouts) ────────────────────────────────────────

test("crash with nobody folded → the whole pot carries over", () => {
  const hand = createHand({ players: SIX_PLAYERS, wager: 10 });
  const outcome = resolveHand(hand, 2.4);
  assert.equal(outcome.winnerUserId, null);
  assert.deepEqual(outcome.activeAtCrash.sort(), [1, 2, 3, 4, 5, 6]);
  assert.equal(outcome.carryOver, 60);
  assert.deepEqual(outcome.payouts, []);
  assert.equal(outcome.rake, 0);
});

test("fold-out: the survivor ranks 1st and the pot splits by linear weights", () => {
  // P1..P5 fold (P5 last), P6 survives. Ranks: P6, P5, P4, P3, P2, P1.
  let hand = createHand({ players: SIX_PLAYERS, wager: 10 });
  for (const [userId, mult] of [[1, 1.3], [2, 1.5], [3, 1.7], [4, 1.9], [5, 2.1]]) {
    const res = applyFold(hand, { userId, multiplier: mult });
    assert.ok(!res.error, res.error);
    hand = res.hand;
    // After P5 folds only P6 remains → hand over.
    if (userId === 5) {
      assert.equal(res.handOver, true);
      assert.equal(res.winnerUserId, 6);
    }
  }
  const outcome = resolveHand(hand, 3.0);
  assert.equal(outcome.winnerUserId, 6);
  assert.deepEqual(outcome.activeAtCrash, []);
  assert.equal(outcome.carryOver, 0);
  // Pot 60, fee 3, distributable 57. Weights 6,5,4,3,2,1 → sums to 21.
  assert.equal(outcome.rake, 3);
  assert.equal(outcome.payoutGross, 57);
  const byUser = Object.fromEntries(outcome.payouts.map((p) => [p.userId, p]));
  assert.equal(byUser[6].rank, 1);
  assert.equal(byUser[6].amount, 16.29);
  assert.equal(byUser[5].amount, 13.57);
  assert.equal(byUser[4].amount, 10.86);
  assert.equal(byUser[3].amount, 8.14);
  assert.equal(byUser[2].amount, 5.43);
  assert.equal(byUser[1].amount, 2.71);
  // Every cent of the distributable pool is accounted for.
  const total = outcome.payouts.reduce((s, p) => s + p.amount, 0);
  assert.equal(total, 57);
});

test("crash with 2+ active: the LAST fold ranks 1st, remaining folders below, crash victims get nothing", () => {
  // P1 folds 1.5, P2 folds 2.0, P3 folds 2.5; P4, P5, P6 crash.
  const hand = handWithFolds([[1, 1.5], [2, 2.0], [3, 2.5]]);
  const outcome = resolveHand(hand, 2.7);
  assert.equal(outcome.winnerUserId, 3);
  assert.deepEqual(outcome.activeAtCrash.sort(), [4, 5, 6]);
  assert.equal(outcome.carryOver, 0);
  assert.equal(outcome.rake, 3); // floor(60 × 5%)
  assert.equal(outcome.payoutGross, 57);
  const byUser = Object.fromEntries(outcome.payouts.map((p) => [p.userId, p]));
  assert.equal(byUser[3].rank, 1);
  assert.equal(byUser[3].amount, 28.5); // 57 × 3/6
  assert.equal(byUser[2].rank, 2);
  assert.equal(byUser[2].amount, 19);   // 57 × 2/6
  assert.equal(byUser[1].rank, 3);
  assert.equal(byUser[1].amount, 9.5);  // remainder
  assert.equal(outcome.payouts.length, 3); // crash victims never appear
  assert.equal(outcome.payouts.reduce((s, p) => s + p.amount, 0), 57);
});

test("a single folder against crashing players takes the whole pot", () => {
  const hand = handWithFolds([[1, 2.0]]);
  const outcome = resolveHand(hand, 2.5);
  assert.equal(outcome.winnerUserId, 1);
  assert.deepEqual(outcome.activeAtCrash.sort(), [2, 3, 4, 5, 6]);
  assert.equal(outcome.payouts.length, 1);
  assert.equal(outcome.payouts[0].amount, 57);
  assert.equal(outcome.payouts[0].rank, 1);
});

test("same-multiplier folds: the fold recorded later in the action log ranks higher", () => {
  // P2 and P3 both fold at 2.0 — P3's fold is logged after P2's.
  const hand = handWithFolds([[2, 2.0], [3, 2.0]]);
  const outcome = resolveHand(hand, 2.3);
  assert.equal(outcome.winnerUserId, 3);
  assert.equal(outcome.payouts[0].userId, 3);
  assert.equal(outcome.payouts[1].userId, 2);
});

test("two-player hand: a fold leaves the survivor rank 1 and the folder rank 2", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  // A folds at 1.5 → B is the sole survivor → fold-out: B ranks 1st,
  // A ranks 2nd. Pot 20, fee 1, distributable 19, weights 2:1 → 12.67 / 6.33.
  const hand = handWithFolds([[1, 1.5]], { players: two });
  const outcome = resolveHand(hand, 2.0);
  assert.equal(outcome.winnerUserId, 2);
  assert.deepEqual(outcome.activeAtCrash, []);
  assert.equal(outcome.rake, Math.floor(20 * PLATFORM_FEE));
  assert.equal(outcome.payouts[0].amount, 12.67);
  assert.equal(outcome.payouts[1].amount, 6.33);
});

test("payouts conserve every cent for any ranked count", () => {
  for (const folds of [
    [[1, 1.3]],
    [[1, 1.3], [2, 1.5]],
    [[1, 1.3], [2, 1.5], [3, 1.7]],
    [[1, 1.3], [2, 1.5], [3, 1.7], [4, 1.9]],
    [[1, 1.3], [2, 1.5], [3, 1.7], [4, 1.9], [5, 2.1]],
  ]) {
    const hand = handWithFolds(folds);
    const outcome = resolveHand(hand, 9.2);
    const total = round2(outcome.payouts.reduce((s, p) => s + p.amount, 0));
    assert.equal(total, round2(hand.pot - Math.floor(hand.pot * PLATFORM_FEE)));
    assert.equal(outcome.payouts.reduce((s, p) => s + p.rank * 0, 0), 0); // ranks present
    const ranks = outcome.payouts.map((p) => p.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b)); // 1, 2, 3, …
  }
});

test("carry-over is included in the pot and split with the rank weights", () => {
  // P1 folds; P2, P3 crash. Pot = 30 + 40 carry = 70; fee 3 → 67 to P1.
  const hand = handWithFolds([[1, 2.0]], { players: SIX_PLAYERS.slice(0, 3), carryOver: 40 });
  assert.equal(hand.pot, 70);
  const outcome = resolveHand(hand, 2.5);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.rake, Math.floor(70 * PLATFORM_FEE));
  assert.equal(outcome.payouts[0].amount, 67);
});

test("handFromEntries rebuilds a hand from persisted round + entries", () => {
  const hand = handFromEntries({
    round: {
      bigBlind: 10,
      handState: {
        flightResumedAt: 1234,
        actions: [{ userId: 3, action: "fold", multiplier: 1.5, at: "t" }],
      },
    },
    entries: [
      { userId: 1, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: false, result: "pending" },
      { userId: 2, contributed: 5, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: true, result: "pending" },
      { userId: 3, contributed: 10, isActive: false, foldedAtMultiplier: 1.5, lastAction: "fold", allIn: false, result: "pending" },
    ],
    carryOver: 0,
  });
  assert.equal(hand.pot, 25);
  assert.equal(hand.wager, 10);
  assert.equal(hand.flightResumedAt, 1234);
  assert.equal(player(hand, 3).folded, true);
  assert.equal(player(hand, 3).foldedAtMultiplier, 1.5);
  assert.equal(player(hand, 2).allIn, true);
  assert.equal(hand.actions.length, 1);
});

test("handFromEntries excludes a released (disconnected) player from the hand", () => {
  const hand = handFromEntries({
    round: { bigBlind: 10, handState: null },
    entries: [
      { userId: 1, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: false, result: "pending" },
      // Disconnect cleanup marked the entry "lost".
      { userId: 2, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: false, result: "lost" },
    ],
    carryOver: 0,
  });
  const p2 = player(hand, 2);
  assert.equal(p2.folded, false);
  assert.equal(p2.isActive, false);
  // User 1 is the only active player → fold-out, they take the whole pot.
  const outcome = resolveHand(hand, 2.0);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.payouts[0].amount, round2(20 - Math.floor(20 * PLATFORM_FEE)));
});

test("resolveHand with everyone released carries the pot", () => {
  const hand = handFromEntries({
    round: { bigBlind: 10, handState: null },
    entries: [
      { userId: 1, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: false, result: "lost" },
      { userId: 2, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "ante", allIn: false, result: "lost" },
    ],
    carryOver: 0,
  });
  const outcome = resolveHand(hand, 2.0);
  assert.equal(outcome.winnerUserId, null);
  assert.equal(outcome.carryOver, 20);
});