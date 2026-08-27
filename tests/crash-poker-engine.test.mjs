import test from "node:test";
import assert from "node:assert/strict";
import {
  computeBlinds,
  computeOpeningContributions,
  createHand,
  applyAction,
  isCheckpointResolved,
  openNextCheckpoint,
  expireStaleActions,
  resumeFlight,
  curveMultiplierAt,
  hasCurveReachedNextCheckpoint,
  isCrashDueAt,
  computePots,
  resolveHand,
  handFromEntries,
} from "../src/lib/crash-poker/roundSystem.js";
import {
  FIRST_BETTING_CHECKPOINT,
  CHECKPOINT_STEP,
  checkpointMultiplier,
  checkpointIndexAtOrBelow,
} from "../src/lib/crash-poker/constants.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const SIX_PLAYERS = Array.from({ length: 6 }, (_, i) => ({
  userId: i + 1,
  name: `P${i + 1}`,
}));

/** A brand-new hand with NO betting checkpoint open yet — the flight is
 * climbing from 1.00x toward the first 0.25x checkpoint (1.25x), which the
 * server sweep opens when the curve reaches it. */
function freshHand({ players = SIX_PLAYERS, bigBlind = 10, dealerPosition = 0 } = {}) {
  return createHand({ players, bigBlind, dealerPosition });
}

/** A hand mid-flight with the first betting checkpoint OPEN — the curve
 * reached 1.25x and the flight paused there for decisions. */
function handAt(opts) {
  return openNextCheckpoint(freshHand(opts));
}

function player(hand, userId) {
  return hand.players.find((p) => p.userId === userId);
}

// ── Blinds & opening contributions ─────────────────────────────────────────

test("small blind is half the big blind", () => {
  assert.equal(computeBlinds(10).smallBlind, 5);
  assert.equal(computeBlinds(1).smallBlind, 0.5);
  assert.equal(computeBlinds(0.01).smallBlind, 0.01); // floor at $0.01
});

test("opening contributions: SB posts SB, BB posts BB, everyone else posts SB (ante)", () => {
  // Dealer = seat 0 (user 1) → SB = seat 1 (user 2), BB = seat 2 (user 3).
  const contributions = computeOpeningContributions(SIX_PLAYERS, 0, 5, 10);
  const byUser = Object.fromEntries(contributions.map((c) => [c.userId, c]));
  assert.equal(byUser[3].amount, 10); // BB
  assert.equal(byUser[3].role, "bb");
  assert.equal(byUser[2].amount, 5); // SB
  assert.equal(byUser[2].role, "sb");
  for (const id of [1, 4, 5, 6]) {
    assert.equal(byUser[id].amount, 5, `user ${id} posts the ante`);
  }
});

test("heads-up (2 players): SB is the dealer, BB is the other seat", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  const hand = createHand({ players: two, bigBlind: 10, dealerPosition: 0 });
  assert.equal(player(hand, 1).role, "sb");
  assert.equal(player(hand, 1).contributed, 5);
  assert.equal(player(hand, 2).role, "bb");
  assert.equal(player(hand, 2).contributed, 10);
});

test("initial hand: NO checkpoint open — the flight flies to 1.25x before betting opens", () => {
  // The hand starts with the curve climbing from 1.00x; the first betting
  // checkpoint (1.25x) is opened lazily (server sweep / first action) once
  // the curve reaches it — the rocket never offers betting mid-segment.
  const hand = freshHand({ bigBlind: 10 });
  assert.equal(hand.checkpointIndex, -1);
  assert.equal(hand.bettingOpen, false);
  assert.equal(hand.windowDeadlineAt, null);
  assert.equal(hand.requiredBet, 10);
  assert.equal(hand.pot, 5 * 5 + 10); // five antes of $5 + BB $10
  // Opening the first checkpoint pauses the flight there with a fresh
  // 30s stall-guard deadline for the decisions.
  const opened = openNextCheckpoint(hand, hand.flightResumedAt + 1000);
  assert.equal(opened.checkpointIndex, 0);
  assert.equal(opened.bettingOpen, true);
  // Fresh 30s stall-guard deadline for the new window.
  assert.equal(opened.windowDeadlineAt, hand.flightResumedAt + 1000 + 30_000);
});

// ── Checkpoint math ─────────────────────────────────────────────────────────

test("checkpoint multipliers step by 0.25 from 1.25", () => {
  assert.equal(checkpointMultiplier(0), 1.25);
  assert.equal(checkpointMultiplier(1), 1.5);
  assert.equal(checkpointMultiplier(2), 1.75);
  assert.equal(checkpointMultiplier(3), 2.0);
  assert.equal(checkpointMultiplier(10), 1.25 + 10 * 0.25);
  assert.equal(FIRST_BETTING_CHECKPOINT, 1.25);
  assert.equal(CHECKPOINT_STEP, 0.25);
});

test("checkpoint index at-or-below a multiplier (crash can land between checkpoints)", () => {
  assert.equal(checkpointIndexAtOrBelow(1.0), -1);
  assert.equal(checkpointIndexAtOrBelow(1.24), -1);
  assert.equal(checkpointIndexAtOrBelow(1.25), 0);
  assert.equal(checkpointIndexAtOrBelow(1.37), 0); // between 1.25 and 1.50
  assert.equal(checkpointIndexAtOrBelow(1.5), 1);
  assert.equal(checkpointIndexAtOrBelow(2.0), 3);
  assert.equal(checkpointIndexAtOrBelow(9.2), Math.floor((9.2 - 1.25) / 0.25));
});

// ── Betting actions ─────────────────────────────────────────────────────────

test("call matches the required bet (non-blind player tops up ante → BB)", () => {
  let hand = handAt({ bigBlind: 10 }); // user 4 has ante $5, must call $5
  const res = applyAction(hand, { userId: 4, action: "call" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(player(hand, 4).contributed, 10);
  assert.equal(player(hand, 4).lastAction, "call");
  assert.equal(hand.pot, 40); // 35 opening + 5 call
});

test("a matched player's call is a check (no extra money)", () => {
  let hand = handAt({ bigBlind: 10 });
  // BB player (user 3) is already matched at $10.
  const res = applyAction(hand, { userId: 3, action: "call" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(player(hand, 3).contributed, 10);
  assert.equal(player(hand, 3).lastAction, "check");
  assert.equal(hand.pot, 35); // no money moved
});

test("fold removes the player and keeps their contribution", () => {
  let hand = handAt({ bigBlind: 10 });
  const res = applyAction(hand, { userId: 4, action: "fold" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(player(hand, 4).isActive, false);
  assert.equal(player(hand, 4).folded, true);
  assert.equal(player(hand, 4).foldedAtMultiplier, 1.25);
  assert.equal(hand.pot, 35); // money stays in the pot
});

test("a raise raises the required contribution and re-opens other players", () => {
  let hand = handAt({ bigBlind: 10 });
  const res = applyAction(hand, { userId: 5, action: "raise", raiseTo: 25 });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(hand.requiredBet, 25);
  assert.equal(player(hand, 5).contributed, 25);
  // Everyone else is now unmatched and can act again.
  assert.equal(hand.bettingOpen, true);
  assert.ok(!isCheckpointResolved(hand));
  const others = hand.players.filter((p) => p.userId !== 5 && p.isActive);
  assert.ok(others.every((p) => p.contributed < hand.requiredBet));
});

test("a raise below min (required bet + one big blind) is rejected", () => {
  const hand = handAt({ bigBlind: 10 });
  const res = applyAction(hand, { userId: 5, action: "raise", raiseTo: 15 });
  assert.ok(res.error);
  assert.match(res.error, /minimum raise/i);
});

test("a player cannot act twice at the same checkpoint without an intervening raise", () => {
  let hand = handAt({ bigBlind: 10 });
  const first = applyAction(hand, { userId: 4, action: "call" });
  assert.ok(!first.error, first.error);
  const second = applyAction(first.hand, { userId: 4, action: "fold" });
  assert.ok(second.error);
  assert.match(second.error, /already acted/i);
});

test("checkpoint resolves (betting closes) once every active player has acted", () => {
  let hand = handAt({ bigBlind: 10 });
  // Every active player must act at checkpoint 0 — including the BB
  // (user 3), whose blind only matches the bet. Matching alone doesn't
  // close betting; the BB still gets a chance to check / raise / fold.
  for (const id of [1, 2, 3, 4, 5, 6]) {
    const res = applyAction(hand, { userId: id, action: "call" });
    assert.ok(!res.error, res.error);
    hand = res.hand;
  }
  assert.equal(isCheckpointResolved(hand), true);
  assert.equal(hand.bettingOpen, false);
});

test("fold-out: when a fold leaves one active player the hand is over", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  // The curve reached 1.25x → the first checkpoint opened.
  let hand = openNextCheckpoint(createHand({ players: two, bigBlind: 10, dealerPosition: 0 }));
  // A is SB ($5), B is BB ($10). A must call $5 to stay in.
  const res = applyAction(hand, { userId: 1, action: "fold" });
  assert.ok(!res.error, res.error);
  assert.equal(res.handOver, true);
  assert.equal(res.winnerUserId, 2);
});

// ── Settlement (the clean winner hook) ─────────────────────────────────────

test("crash with 2+ active players: the latest successful fold wins the whole pot", () => {
  let hand = handAt({ bigBlind: 10 });
  // One player folds, everyone else stays in and crashes.
  const fold = applyAction(hand, { userId: 4, action: "fold" });
  hand = fold.hand;
  const outcome = resolveHand(hand, 2.37); // crash between 2.25 and 2.50
  // Fold-order rule: the only successful fold (user 4) wins the whole pot.
  assert.equal(outcome.winnerUserId, 4);
  assert.equal(outcome.payoutGross, hand.pot);
  assert.deepEqual(outcome.returns, []);
  assert.equal(outcome.carryOver, 0);
  assert.deepEqual(outcome.activeAtCrash.sort(), [1, 2, 3, 5, 6]);
});

test("one active player left wins the pot (fold-order rule)", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  const hand = openNextCheckpoint(createHand({ players: two, bigBlind: 10, dealerPosition: 0 }));
  // B folds at 1.25x → A wins even if the crash comes later.
  const folded = applyAction(hand, { userId: 2, action: "fold" });
  assert.equal(folded.winnerUserId, 1);
  const outcome = resolveHand(folded.hand, 4.0);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.carryOver, 0);
});

test("a fold recorded above the crash point is void (that checkpoint never opened)", () => {
  // Crash at 1.37x — only checkpoint 0 (1.25x) ever opened. A fold at
  // checkpoint 1 (1.50x) is void: the player is restored to active and
  // busts with everyone else.
  let hand = handAt({ bigBlind: 10 });
  // Simulate an over-eager fold at checkpoint 1 (1.50x).
  hand = {
    ...hand,
    checkpointIndex: 1,
    players: hand.players.map((p) =>
      p.userId === 3 ? { ...p, folded: true, foldedAtMultiplier: 1.5, isActive: false } : p,
    ),
  };
  const outcome = resolveHand(hand, 1.37);
  assert.equal(outcome.winnerUserId, null);
  assert.ok(outcome.activeAtCrash.includes(3), "voided folder is active at the crash");
});

test("handFromEntries rebuilds a hand from persisted round + entries", () => {
  const hand = handFromEntries({
    round: {
      checkpointIndex: 0,
      requiredBet: 10,
      bettingOpen: true,
      smallBlind: 5,
      bigBlind: 10,
      dealerPosition: 0,
      handState: null,
    },
    entries: [
      { userId: 1, contributed: 5, isActive: true, foldedAtMultiplier: null, lastAction: "ante", result: "pending" },
      { userId: 2, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "bb", result: "pending" },
      { userId: 3, contributed: 5, isActive: false, foldedAtMultiplier: 1.25, lastAction: "fold", result: "pending" },
    ],
    carryOver: 0,
  });
  assert.equal(hand.pot, 20);
  assert.equal(hand.requiredBet, 10);
  assert.equal(hand.players.find((p) => p.userId === 3).folded, true);
  assert.equal(hand.players.find((p) => p.userId === 2).contributed, 10);
});

test("carry-over is included in the pot and carries in full when nobody folds", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  const hand = createHand({ players: two, bigBlind: 10, dealerPosition: 0, carryOver: 40 });
  assert.equal(hand.pot, 55); // SB 5 + BB 10 + carry 40
  const outcome = resolveHand(hand, 3.0);
  assert.equal(outcome.winnerUserId, null); // both still active, nobody folded
  assert.deepEqual(outcome.returns, []);
  assert.equal(outcome.carryOver, 55);
});

// ── Configurable blinds ────────────────────────────────────────────────────

test("a per-table small blind override wins over the default ratio", () => {
  assert.equal(computeBlinds(10, 4).smallBlind, 4);
  assert.equal(computeBlinds(10, 2.5).smallBlind, 2.5);
  // Invalid / missing overrides fall back to round(wager/2).
  assert.equal(computeBlinds(10, null).smallBlind, 5);
  assert.equal(computeBlinds(10, 0).smallBlind, 5);
  assert.equal(computeBlinds(10, -3).smallBlind, 5);
  // Still floored at $0.01.
  assert.equal(computeBlinds(1, 0.001).smallBlind, 0.01);
});

test("createHand uses the table's small blind override", () => {
  const hand = handAt({ bigBlind: 10, ...{} });
  assert.equal(hand.smallBlind, 5);
  const custom = createHand({
    players: SIX_PLAYERS,
    bigBlind: 10,
    dealerPosition: 0,
    smallBlind: 4,
  });
  assert.equal(custom.smallBlind, 4);
  assert.equal(player(custom, 3).contributed, 10); // BB unchanged
  assert.equal(player(custom, 2).contributed, 4);  // SB = 4
  assert.equal(player(custom, 1).contributed, 4);  // ante = 4
});

// ── All-in support ─────────────────────────────────────────────────────────

test("a call capped at the stack goes all-in instead of being rejected", () => {
  let hand = handAt({ bigBlind: 10 }); // user 4: ante $5, needs $5 to call
  const res = applyAction(hand, { userId: 4, action: "call", stack: 3 });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  const p4 = player(hand, 4);
  assert.equal(p4.contributed, 8); // 5 ante + 3 whole stack
  assert.equal(p4.allIn, true);
  assert.equal(p4.lastAction, "call");
});

test("a raise is capped at the stack (all-in shove)", () => {
  let hand = handAt({ bigBlind: 10 });
  // user 5: ante $5, stack $12 → can only reach $17 total.
  const res = applyAction(hand, { userId: 5, action: "raise", raiseTo: 25, stack: 12 });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  const p5 = player(hand, 5);
  assert.equal(p5.contributed, 17);
  assert.equal(p5.allIn, true);
  assert.equal(hand.requiredBet, 17);
});

test("an all-in shove below the minimum raise is legal", () => {
  let hand = handAt({ bigBlind: 10 });
  // user 5: ante $5, stack $8 → shove to $13 total, below min $20 raise.
  const res = applyAction(hand, { userId: 5, action: "raise", raiseTo: 50, stack: 8 });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  const p5 = player(hand, 5);
  assert.equal(p5.contributed, 13);
  assert.equal(p5.allIn, true);
});

test("an all-in player is committed and can't act again", () => {
  let hand = handAt({ bigBlind: 10 });
  // user 4 all-ins for $3 extra (total $8, below required $10).
  let res = applyAction(hand, { userId: 4, action: "call", stack: 3 });
  hand = res.hand;
  // The all-in player is committed; everyone else (including the BB) must
  // still act before the checkpoint resolves.
  assert.equal(isCheckpointResolved(hand), false);
  for (const id of [1, 2, 5, 6]) {
    res = applyAction(hand, { userId: id, action: "call" });
    assert.ok(!res.error, res.error);
    hand = res.hand;
  }
  // The BB (user 3) is matched but hasn't acted — still blocking.
  assert.equal(isCheckpointResolved(hand), false);
  res = applyAction(hand, { userId: 3, action: "call" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(isCheckpointResolved(hand), true);
  // All-in player cannot act at a later checkpoint either.
  hand = openNextCheckpoint(hand);
  assert.equal(hand.bettingOpen, true);
  const later = applyAction(hand, { userId: 4, action: "fold" });
  assert.ok(later.error);
  assert.match(later.error, /all-in/i);
});

test("a fold-out leaves the all-in player as the winner (fold-order rule)", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  let hand = openNextCheckpoint(createHand({ players: two, bigBlind: 10, dealerPosition: 0 }));
  // A (SB $5) has only $3 left — all-in for $3 extra (total $8).
  let res = applyAction(hand, { userId: 1, action: "call", stack: 3 });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(player(hand, 1).allIn, true);
  // B (BB $10) is matched but must still act — B checks, resolving 1.25x.
  res = applyAction(hand, { userId: 2, action: "call" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(hand.bettingOpen, false);
  // Open 1.50x — B folds there → A wins the whole pot despite being below
  // the required bet.
  hand = openNextCheckpoint(hand);
  assert.equal(hand.bettingOpen, true);
  res = applyAction(hand, { userId: 2, action: "fold" });
  assert.equal(res.handOver, true);
  assert.equal(res.winnerUserId, 1);
  const outcome = resolveHand(res.hand, 4.0);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.carryOver, 0);
});

test("all-in players bust with everyone else when the crash lands (nobody folded → carry)", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  let hand = openNextCheckpoint(createHand({ players: two, bigBlind: 10, dealerPosition: 0 }));
  let res = applyAction(hand, { userId: 1, action: "call", stack: 3 }); // A all-in $8
  hand = res.hand;
  res = applyAction(hand, { userId: 2, action: "call" }); // B calls $5 → $10
  hand = res.hand;
  const outcome = resolveHand(hand, 1.4); // crash just past 1.25x
  assert.equal(outcome.winnerUserId, null); // 2 active, nobody folded → carry
  assert.deepEqual(outcome.activeAtCrash.sort(), [1, 2]);
  assert.deepEqual(outcome.returns, []);
  assert.equal(outcome.carryOver, hand.pot); // 18 — the full pot carries
});

test("opening contribution is capped at the stack (all-in on the blinds)", () => {
  const stackByUser = new Map([
    [1, 50], // fine
    [2, 3],  // SB seat — short, all-in $3
    [3, 40], // BB seat — short of $10, all-in $40... actually fine
    [4, 50],
    [5, 50],
    [6, 0.01], // can just barely post the floor ante — all-in $0.01
  ]);
  const hand = createHand({
    players: SIX_PLAYERS,
    bigBlind: 10,
    dealerPosition: 0,
    stackByUser,
  });
  assert.equal(player(hand, 2).contributed, 3);
  assert.equal(player(hand, 2).allIn, true);
  assert.equal(player(hand, 3).contributed, 10); // full BB
  assert.equal(player(hand, 3).allIn, false);
  assert.equal(player(hand, 6).contributed, 0.01);
  assert.equal(player(hand, 6).allIn, true);
});

test("a player with no stack is left out of the hand entirely", () => {
  const stackByUser = new Map([
    [1, 50],
    [2, 0],  // broke — cannot play
    [3, 40],
    [4, 50],
    [5, 50],
    [6, 50],
  ]);
  const hand = createHand({
    players: SIX_PLAYERS,
    bigBlind: 10,
    dealerPosition: 0,
    stackByUser,
  });
  assert.equal(player(hand, 2).isActive, false);
  assert.equal(player(hand, 2).contributed, 0);
  assert.equal(hand.players.filter((p) => p.isActive).length, 5);
});

test("handFromEntries rebuilds the all-in flag from the entry row", () => {
  const round = {
    checkpointIndex: 0,
    requiredBet: 10,
    bettingOpen: true,
    smallBlind: 5,
    bigBlind: 10,
    dealerPosition: 0,
    handState: null,
  };
  const entries = [
    { userId: 1, contributed: 8, isActive: true, foldedAtMultiplier: null, lastAction: "call", allIn: true, result: "pending" },
    { userId: 2, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "bb", allIn: false, result: "pending" },
  ];
  const hand = handFromEntries({ round, entries, carryOver: 0 });
  assert.equal(player(hand, 1).allIn, true);
  assert.equal(player(hand, 1).actedThisCheckpoint, true);
  assert.equal(player(hand, 2).allIn, false);
  // The all-in player below the required bet is committed (never blocks),
  // but the BB — matched yet not acted — blocks resolution until it acts.
  assert.equal(player(hand, 2).actedThisCheckpoint, false);
  assert.equal(isCheckpointResolved(hand), false);
  // Once the BB's acted state is restored from the hand snapshot, the
  // checkpoint resolves (all-in committed + BB checked).
  const acted = handFromEntries({
    round: { ...round, handState: { players: [{ userId: 2, actedThisCheckpoint: true }] } },
    entries,
    carryOver: 0,
  });
  assert.equal(player(acted, 2).actedThisCheckpoint, true);
  assert.equal(isCheckpointResolved(acted), true);
});

// ── Side pots (poker-style tier accounting) ────────────────────────────────

/** Build a hand with explicit per-player contributions (for tier tests). */
function handWithContributions(specs, carryOver = 0) {
  const players = specs.map((s) => ({
    userId: s.userId,
    name: `P${s.userId}`,
    role: s.role ?? "ante",
    contributed: s.contributed,
    isActive: s.active !== false,
    folded: Boolean(s.folded),
    foldedAtMultiplier: s.folded ? (s.foldedAtMultiplier ?? 1.25) : null,
    lastAction: s.lastAction ?? null,
    actedThisCheckpoint: true,
    allIn: Boolean(s.allIn),
  }));
  return {
    bigBlind: 10,
    smallBlind: 5,
    dealerPosition: 0,
    carryOver,
    checkpointIndex: 0,
    bettingOpen: true,
    requiredBet: 10,
    pot: players.reduce((sum, p) => sum + p.contributed, 0) + carryOver,
    players,
    actions: [],
  };
}

test("computePots builds a main pot + side pot with correct eligibility", () => {
  // A all-in $8 (short), B and C deep at $30.
  const hand = handWithContributions([
    { userId: 1, contributed: 8, allIn: true },
    { userId: 2, contributed: 30 },
    { userId: 3, contributed: 30 },
  ]);
  const pots = computePots(hand);
  assert.equal(pots.length, 2);
  // Main: $8 × 3 — everyone can win it.
  assert.equal(pots[0].level, 8);
  assert.equal(pots[0].amount, 24);
  assert.deepEqual(pots[0].eligible, [1, 2, 3]);
  // Side: ($30 − $8) × 2 — only B and C can win it.
  assert.equal(pots[1].level, 30);
  assert.equal(pots[1].amount, 44);
  assert.deepEqual(pots[1].eligible, [2, 3]);
});

test("computePots includes the carry-over pot as its own bottom tier", () => {
  const hand = handWithContributions([
    { userId: 1, contributed: 8, allIn: true },
    { userId: 2, contributed: 30 },
    { userId: 3, contributed: 30 },
  ], 20);
  const pots = computePots(hand, 20);
  assert.equal(pots.length, 3);
  assert.equal(pots[0].level, 0);
  assert.equal(pots[0].amount, 20);
  assert.deepEqual(pots[0].eligible, [1, 2, 3]);
  assert.equal(pots[1].amount, 24);
  assert.equal(pots[2].amount, 44);
});

test("fold-out: the sole survivor takes the whole pot (no returns to folders)", () => {
  // A all-in $8. B and C both fold at $30 → A wins the WHOLE pot ($68):
  // every folded contribution stays in the pot and goes to the survivor.
  const hand = handWithContributions([
    { userId: 1, contributed: 8, allIn: true },
    { userId: 2, contributed: 30, folded: true },
    { userId: 3, contributed: 30, folded: true },
  ]);
  const outcome = resolveHand(hand, 4.0);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.payoutGross, 68);
  assert.equal(outcome.carryOver, 0);
  assert.deepEqual(outcome.returns, []);
});

test("fold-out: a deep winner takes the whole pot with no returns", () => {
  // B (BB $10) is the only active player after A (SB $5) folds — B matched
  // every tier, so nothing returns.
  const hand = handWithContributions([
    { userId: 1, contributed: 5, folded: true },
    { userId: 2, contributed: 10 },
  ]);
  const outcome = resolveHand(hand, 4.0);
  assert.equal(outcome.winnerUserId, 2);
  assert.equal(outcome.payoutGross, 15);
  assert.deepEqual(outcome.returns, []);
});

test("fold-out heads-up: the surviving player takes the whole pot", () => {
  // A (SB $5) wins when B (BB $10) folds — A takes the whole $15 pot.
  const hand = handWithContributions([
    { userId: 1, contributed: 5 },
    { userId: 2, contributed: 10, folded: true },
  ]);
  const outcome = resolveHand(hand, 4.0);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.payoutGross, 15);
  assert.deepEqual(outcome.returns, []);
});

test("fold-out with carry-over: the sole survivor takes the carry pot too", () => {
  const hand = handWithContributions([
    { userId: 1, contributed: 8, allIn: true },
    { userId: 2, contributed: 30, folded: true },
    { userId: 3, contributed: 30, folded: true },
  ], 20);
  const outcome = resolveHand(hand, 4.0);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.payoutGross, 88); // carry $20 + every contribution
  assert.equal(outcome.carryOver, 0);
  assert.deepEqual(outcome.returns, []);
});

test("crash: the successful fold wins; crash victims lose their contributions", () => {
  // A all-in $8, B deep $30, C folded after $8. Crash with A + B active →
  // C's fold is the latest successful fold and wins the whole pot.
  const hand = handWithContributions([
    { userId: 1, contributed: 8, allIn: true },
    { userId: 2, contributed: 30 },
    { userId: 3, contributed: 8, folded: true },
  ]);
  const outcome = resolveHand(hand, 1.4);
  assert.equal(outcome.winnerUserId, 3);
  assert.deepEqual(outcome.activeAtCrash, [1, 2]);
  assert.equal(outcome.payoutGross, 46);
  assert.deepEqual(outcome.returns, []);
  assert.equal(outcome.carryOver, 0);
});

test("crash: fully matched bets carry in full (no returns)", () => {
  const hand = handWithContributions([
    { userId: 1, contributed: 8, allIn: true },
    { userId: 2, contributed: 30 },
    { userId: 3, contributed: 30 },
  ]);
  const outcome = resolveHand(hand, 1.4);
  assert.equal(outcome.winnerUserId, null);
  assert.deepEqual(outcome.returns, []);
  assert.equal(outcome.carryOver, 68);
});

test("crash: the latest successful fold before the crash wins (fold-order rule)", () => {
  // P3 folded at 1.25x, P4 folded later at 1.50x. P1 + P2 stay in and
  // crash → P4's fold is the latest, so P4 wins the whole pot.
  const hand = handWithContributions([
    { userId: 1, contributed: 8, allIn: true },
    { userId: 2, contributed: 10 },
    { userId: 3, contributed: 10, folded: true, foldedAtMultiplier: 1.25 },
    { userId: 4, contributed: 10, folded: true, foldedAtMultiplier: 1.5 },
  ]);
  const outcome = resolveHand(hand, 2.0);
  assert.equal(outcome.winnerUserId, 4);
  assert.deepEqual(outcome.activeAtCrash.sort(), [1, 2]);
  assert.equal(outcome.payoutGross, 38);
  assert.deepEqual(outcome.returns, []);
  assert.equal(outcome.carryOver, 0);
});

test("same-checkpoint folds: the later fold in the action log wins", () => {
  const four = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
    { userId: 3, name: "C" },
    { userId: 4, name: "D" },
  ];
  let hand = openNextCheckpoint(createHand({ players: four, bigBlind: 10, dealerPosition: 0 }));
  // P1 raises to $25 at checkpoint 0 (1.25x) — everyone else is now
  // unmatched, so the checkpoint stays open across the folds below.
  let res = applyAction(hand, { userId: 1, action: "raise", raiseTo: 25 });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(hand.bettingOpen, true);
  // P2 then P3 both fold at the SAME checkpoint (1.25x).
  res = applyAction(hand, { userId: 2, action: "fold" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(hand.bettingOpen, true); // P3 + P4 still owe the call
  res = applyAction(hand, { userId: 3, action: "fold" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  // Crash at 1.37x — P1 + P4 bust; P3 folded after P2 → P3 wins the pot.
  const outcome = resolveHand(hand, 1.37);
  assert.equal(outcome.winnerUserId, 3);
  assert.deepEqual(outcome.activeAtCrash.sort(), [1, 4]);
  assert.equal(outcome.payoutGross, 45);
});

test("crash below the first betting checkpoint: nobody wins, the pot carries over", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  const hand = createHand({ players: two, bigBlind: 10, dealerPosition: 0 });
  const outcome = resolveHand(hand, 1.1); // crash before 1.25x ever opened
  assert.equal(outcome.winnerUserId, null);
  assert.deepEqual(outcome.activeAtCrash.sort(), [1, 2]);
  assert.equal(outcome.carryOver, hand.pot);
});

test("handFromEntries excludes a released (disconnected) player from the hand", () => {
  const hand = handFromEntries({
    round: {
      checkpointIndex: 0,
      requiredBet: 10,
      bettingOpen: true,
      smallBlind: 5,
      bigBlind: 10,
      dealerPosition: 0,
      handState: null,
    },
    entries: [
      { userId: 1, contributed: 5, isActive: true, foldedAtMultiplier: null, lastAction: "ante", result: "pending" },
      // Disconnect cleanup marked the entry "lost" but left isActive true.
      { userId: 2, contributed: 10, isActive: true, foldedAtMultiplier: null, lastAction: "bb", result: "lost" },
      { userId: 3, contributed: 5, isActive: false, foldedAtMultiplier: 1.25, lastAction: "fold", result: "pending" },
    ],
    carryOver: 0,
  });
  const p2 = hand.players.find((p) => p.userId === 2);
  assert.equal(p2.folded, false);
  assert.equal(p2.isActive, false);
  // User 1 is the only active player → they win the fold-out, NOT the
  // released player 2 (who was already refunded and marked left).
  const outcome = resolveHand(hand, 4.0);
  assert.equal(outcome.winnerUserId, 1);
  assert.equal(outcome.payoutGross, 20);
});

// ── Per-checkpoint action timers (stall guard) ─────────────────────────────

test("createHand opens checkpoint 0 with a future action deadline", () => {
  const hand = handAt({ bigBlind: 10 });
  assert.ok(hand.windowDeadlineAt > Date.now());
});

// ── Pause-aware crash curve (the flight stops at every 0.25x checkpoint) ──

test("curveMultiplierAt climbs exponentially from 1.00x before the first checkpoint", () => {
  const hand = freshHand({ bigBlind: 10 });
  // t=0 → 1.00x; after 1s → e^0.33 ≈ 1.39x (between 1.25 and 1.50).
  assert.ok(Math.abs(curveMultiplierAt(hand, hand.flightResumedAt) - 1.0) < 1e-6);
  const at = curveMultiplierAt(hand, hand.flightResumedAt + 1000);
  assert.ok(Math.abs(at - Math.exp(0.33)) < 1e-3);
});

test("the flight PAUSES at the open checkpoint multiplier while a window is open", () => {
  const hand = handAt({ bigBlind: 10 }); // checkpoint 0 open (1.25x)
  // Well past the arrival moment, the curve is HELD at 1.25x — it never
  // climbs during the betting window.
  for (const later of [1000, 5000, 30_000]) {
    assert.equal(curveMultiplierAt(hand, hand.flightResumedAt + later), 1.25);
  }
  assert.equal(isHandPausedLike(hand), true);
});

test("after a window closes the curve resumes from the checkpoint multiplier", () => {
  let hand = handAt({ bigBlind: 10 }); // paused at 1.25x
  // The window closes (everyone acted) → the flight resumes from the
  // checkpoint multiplier at the close moment.
  hand = { ...hand, bettingOpen: false };
  const resumeAt = hand.flightResumedAt + 10_000; // window stayed open 10s
  hand = resumeFlight(hand, resumeAt);
  assert.equal(hand.bettingOpen, false);
  assert.equal(hand.flightResumedAt, resumeAt);
  // The curve climbs from 1.25x at the resume moment — the paused time is
  // NOT counted.
  assert.ok(Math.abs(curveMultiplierAt(hand, resumeAt) - 1.25) < 1e-6);
  const later = curveMultiplierAt(hand, resumeAt + 1000);
  assert.ok(Math.abs(later - 1.25 * Math.exp(0.33)) < 1e-3);
});

test("hasCurveReachedNextCheckpoint opens the next window once the segment finishes", () => {
  const hand = freshHand({ bigBlind: 10 });
  assert.equal(hasCurveReachedNextCheckpoint(hand, hand.flightResumedAt), false);
  // After ~1.1s the curve crossed 1.25x — the next checkpoint is due.
  assert.equal(hasCurveReachedNextCheckpoint(hand, hand.flightResumedAt + 1100), true);
});

test("isCrashDueAt: the crash fires only when the UNPAUSED curve reaches the crash point", () => {
  const hand = freshHand({ bigBlind: 10 });
  const crashPoint = 2.0;
  // e^0.33 ≈ 1.39 < 2.0 at 1s → not due; e^0.99 ≈ 2.69 ≥ 2.0 at 3s → due.
  assert.equal(isCrashDueAt(hand, hand.flightResumedAt + 1000, crashPoint), false);
  assert.equal(isCrashDueAt(hand, hand.flightResumedAt + 3000, crashPoint), true);
  // While a betting window is open the flight is paused BELOW the crash
  // point — a paused hand is never "due" (the sweep would have crashed it
  // before opening a window beyond the crash point).
  const paused = handAt({ bigBlind: 10 });
  assert.equal(isCrashDueAt(paused, paused.flightResumedAt + 60_000, crashPoint), false);
});

// Helper: the local pause check (isHandPaused is exported below via the
// engine's isHandPaused — kept inline here to avoid re-deriving it).
function isHandPausedLike(hand) {
  return hand.bettingOpen && hand.checkpointIndex >= 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("openNextCheckpoint refreshes the action deadline", async () => {
  let hand = handAt({ bigBlind: 10 });
  // Everyone acts (calls; the BB checks) → checkpoint resolves.
  for (const id of [1, 2, 3, 4, 5, 6]) {
    const res = applyAction(hand, { userId: id, action: "call" });
    hand = res.hand;
  }
  assert.equal(hand.bettingOpen, false);
  const oldDeadline = hand.windowDeadlineAt;
  await sleep(2);
  hand = openNextCheckpoint(hand);
  assert.equal(hand.bettingOpen, true);
  assert.ok(hand.windowDeadlineAt > oldDeadline);
});

test("a raise refreshes the action deadline for the re-opened window", async () => {
  let hand = handAt({ bigBlind: 10 });
  const oldDeadline = hand.windowDeadlineAt;
  await sleep(2);
  const res = applyAction(hand, { userId: 5, action: "raise", raiseTo: 25 });
  hand = res.hand;
  assert.ok(hand.windowDeadlineAt > oldDeadline);
});

test("expireStaleActions is a no-op before the deadline", () => {
  let hand = handAt({ bigBlind: 10 });
  const outcome = expireStaleActions(hand, Date.now() - 1000);
  assert.deepEqual(outcome.autoFolded, []);
  assert.equal(outcome.handOver, false);
});

test("expireStaleActions auto-folds only overdue unmatched players", () => {
  // Dealer 0: SB user 2, BB user 3. Users 1, 2, 4, 5 call (matched); user 3
  // (BB $10) is matched from the opening. Only user 6 stalls — still owes
  // the ante call and never acted.
  let hand = handAt({ bigBlind: 10 });
  for (const id of [1, 2, 4, 5]) {
    const res = applyAction(hand, { userId: id, action: "call" });
    hand = res.hand;
  }
  // Deadline passed → user 6 (still unmatched, hasn't acted) auto-folds.
  const outcome = expireStaleActions(hand, hand.windowDeadlineAt + 1000);
  assert.deepEqual(outcome.autoFolded, [6]);
  // The matched-but-silent BB (user 3) is auto-CHECKED, not folded.
  assert.deepEqual(outcome.autoChecked, [3]);
  assert.equal(player(outcome.hand, 6).folded, true);
  assert.equal(player(outcome.hand, 6).foldedAtMultiplier, 1.25);
  // Matched (BB + callers) players are untouched.
  assert.equal(player(outcome.hand, 3).folded, false);
  assert.equal(player(outcome.hand, 3).actedThisCheckpoint, true);
  assert.equal(player(outcome.hand, 3).lastAction, "check");
  assert.equal(player(outcome.hand, 1).folded, false);
  assert.equal(player(outcome.hand, 4).folded, false);
  assert.equal(player(outcome.hand, 5).folded, false);
});

test("a check doesn't close the checkpoint — a late raiser can still act", () => {
  let hand = handAt({ bigBlind: 10 }); // dealer 0: SB user2, BB user3
  // P1 matches (call $5 → $10). Others haven't acted yet.
  let res = applyAction(hand, { userId: 1, action: "call" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  // Matching alone doesn't resolve the checkpoint.
  assert.equal(hand.bettingOpen, true);
  assert.equal(isCheckpointResolved(hand), false);
  // A player who hasn't acted yet can still raise at this checkpoint.
  res = applyAction(hand, { userId: 5, action: "raise", raiseTo: 25 });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(hand.requiredBet, 25);
  // The raise re-opened everyone else (including P1).
  assert.equal(player(hand, 1).actedThisCheckpoint, false);
  assert.equal(hand.bettingOpen, true);
});

test("a matched player who stalls is auto-checked, not folded", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  let hand = openNextCheckpoint(createHand({ players: two, bigBlind: 10, dealerPosition: 0 }));
  // A (SB $5) calls → matched. B (BB $10) is matched but hasn't acted.
  let res = applyAction(hand, { userId: 1, action: "call" });
  assert.ok(!res.error, res.error);
  hand = res.hand;
  assert.equal(hand.bettingOpen, true);
  // Deadline passes with B silent → B is auto-checked, never folded.
  const outcome = expireStaleActions(hand, hand.windowDeadlineAt + 1000);
  assert.deepEqual(outcome.autoChecked, [2]);
  assert.deepEqual(outcome.autoFolded, []);
  assert.equal(player(outcome.hand, 2).folded, false);
  assert.equal(player(outcome.hand, 2).actedThisCheckpoint, true);
  assert.equal(player(outcome.hand, 2).lastAction, "check");
  // The checkpoint is now fully resolved.
  assert.equal(outcome.hand.bettingOpen, false);
});

test("expireStaleActions never folds all-in players", () => {
  let hand = handAt({ bigBlind: 10 });
  // User 4 all-ins for $3 (total $8, below required $10) — committed.
  let res = applyAction(hand, { userId: 4, action: "call", stack: 3 });
  hand = res.hand;
  // Others act; user 5 stalls.
  for (const id of [1, 2, 6]) {
    res = applyAction(hand, { userId: id, action: "call" });
    hand = res.hand;
  }
  const outcome = expireStaleActions(hand, hand.windowDeadlineAt + 1000);
  assert.deepEqual(outcome.autoFolded, [5]);
  // The matched-but-silent BB (user 3) is auto-checked.
  assert.deepEqual(outcome.autoChecked, [3]);
  assert.equal(player(outcome.hand, 4).allIn, true);
  assert.equal(player(outcome.hand, 4).folded, false);
});

test("expireStaleActions never folds a sole survivor", () => {
  const two = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
  ];
  let hand = openNextCheckpoint(createHand({ players: two, bigBlind: 10, dealerPosition: 0 }));
  // B folds → A is the sole survivor (fold-out already determined).
  const fold = applyAction(hand, { userId: 2, action: "fold" });
  assert.equal(fold.handOver, true);
  const outcome = expireStaleActions(fold.hand, fold.hand.windowDeadlineAt + 1000);
  assert.deepEqual(outcome.autoFolded, []);
  assert.equal(player(outcome.hand, 1).folded, false);
});

test("expireStaleActions can end the hand (auto-fold fold-out)", () => {
  // Dealer 0: SB user 2, BB user 3. User 1 (dealer/ante) and user 2 fold;
  // user 3 (BB $10) is matched. User 4 (ante $5) stalls → auto-folded,
  // leaving user 3 as the sole survivor → hand over.
  const four = [
    { userId: 1, name: "A" },
    { userId: 2, name: "B" },
    { userId: 3, name: "C" },
    { userId: 4, name: "D" },
  ];
  let hand = openNextCheckpoint(createHand({ players: four, bigBlind: 10, dealerPosition: 0 }));
  let res = applyAction(hand, { userId: 1, action: "fold" });
  hand = res.hand;
  res = applyAction(hand, { userId: 2, action: "fold" });
  hand = res.hand;
  // Active: user 3 (matched BB), user 4 (unmatched, never acted).
  const outcome = expireStaleActions(hand, hand.windowDeadlineAt + 1000);
  assert.deepEqual(outcome.autoFolded, [4]);
  // User 4's auto-fold leaves exactly user 3 active → hand over, C wins.
  assert.equal(outcome.handOver, true);
  assert.equal(outcome.winnerUserId, 3);
});
