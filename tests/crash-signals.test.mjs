import test from "node:test";
import assert from "node:assert/strict";
// tsx compiles import-free .ts files as CommonJS in this CJS package, so
// node exposes the named exports on the module's `default` slot — the
// namespace-fallback keeps the test working in either module format.
import * as signalsModule from "../src/lib/games/crash/signals.ts";
const {
  SIGNAL_TIER_ACCURACY,
  SIGNAL_TIER_WEIGHTS,
  BOT_SIGNAL_TIER_WEIGHTS,
  SIGNAL_CRASH_MIN,
  SIGNAL_CRASH_MAX,
  archetypeOf,
  archetypeClaim,
  randomTier,
  tierWeightsFor,
  dealSignal,
  dealSignals,
  signalContainsCrash,
} = signalsModule.default ?? signalsModule;
// Same interop note applies to the .js engine when the tsx loader is active.
import * as roundSystemModule from "../src/lib/crash-poker/roundSystem.js";
const { createHand, handFromEntries } = roundSystemModule.default ?? roundSystemModule;

const ARCHETYPES = ["low", "midLow", "midHigh", "high"];

test("archetype bounds map crash multipliers to the four zones", () => {
  assert.equal(archetypeOf(SIGNAL_CRASH_MIN), "low");
  assert.equal(archetypeOf(2.49), "low");
  assert.equal(archetypeOf(2.5), "midLow");
  assert.equal(archetypeOf(4.49), "midLow");
  assert.equal(archetypeOf(4.5), "midHigh");
  assert.equal(archetypeOf(6.49), "midHigh");
  assert.equal(archetypeOf(6.5), "high");
  assert.equal(archetypeOf(SIGNAL_CRASH_MAX), "high");
  assert.equal(archetypeOf(Number.NaN), "low");
});

test("every claim string matches its archetype", () => {
  assert.match(archetypeClaim("low"), /under 2\.5/);
  assert.match(archetypeClaim("midLow"), /2\.5.*4\.5/);
  assert.match(archetypeClaim("midHigh"), /4\.5.*6\.5/);
  assert.match(archetypeClaim("high"), /over 6\.5/);
});

test("human tier draws stay at the symmetric 30/40/30 odds", () => {
  const N = 20000;
  const counts = { strong: 0, medium: 0, weak: 0 };
  for (let i = 0; i < N; i += 1) counts[randomTier(SIGNAL_TIER_WEIGHTS)] += 1;
  for (const tier of ["strong", "medium", "weak"]) {
    const rate = counts[tier] / N;
    assert.ok(
      Math.abs(rate - SIGNAL_TIER_WEIGHTS[tier]) < 0.03,
      `human ${tier} rate ${rate.toFixed(3)} ≈ ${SIGNAL_TIER_WEIGHTS[tier]}`,
    );
  }
});

test("bots draw from the difficulty-gated tier distribution", () => {
  const N = 20000;
  for (const difficulty of ["easy", "medium", "hard"]) {
    const counts = { strong: 0, medium: 0, weak: 0 };
    for (let i = 0; i < N; i += 1) {
      counts[randomTier(tierWeightsFor({ isBot: true, aiDifficulty: difficulty }))] += 1;
    }
    const w = BOT_SIGNAL_TIER_WEIGHTS[difficulty];
    for (const tier of ["strong", "medium", "weak"]) {
      const rate = counts[tier] / N;
      assert.ok(
        Math.abs(rate - w[tier]) < 0.03,
        `${difficulty} ${tier} rate ${rate.toFixed(3)} ≈ ${w[tier]}`,
      );
    }
  }
  // Easy bots are the reliable tell — they should draw weak > half the time.
  const easyWeights = tierWeightsFor({ isBot: true, aiDifficulty: "easy" });
  assert.ok(easyWeights.weak > 0.5, "easy bots overweight weak tips");
  assert.ok(easyWeights.strong < 0.2, "easy bots rarely draw strong tips");
  // Humans ignore bot gating entirely.
  assert.deepEqual(tierWeightsFor({ isBot: false, aiDifficulty: "easy" }), SIGNAL_TIER_WEIGHTS);
});

test("each tier hits its published calibration (±2% over a large sample)", () => {
  const N = 30000;
  for (const tier of ["strong", "medium", "weak"]) {
    let hits = 0;
    for (let i = 0; i < N; i += 1) {
      const crashPoint =
        SIGNAL_CRASH_MIN + Math.random() * (SIGNAL_CRASH_MAX - SIGNAL_CRASH_MIN);
      const signal = dealSignal(crashPoint, tier);
      assert.equal(signal.tier, tier);
      assert.ok(ARCHETYPES.includes(signal.archetype));
      assert.ok(signal.claim.length > 0);
      assert.equal(signal.text, `Insight: ${signal.claim} · ${tier}`);
      assert.equal(signal.accuracy, SIGNAL_TIER_ACCURACY[tier]);
      if (signalContainsCrash(signal, crashPoint)) hits += 1;
    }
    const rate = hits / N;
    assert.ok(
      Math.abs(rate - SIGNAL_TIER_ACCURACY[tier]) < 0.02,
      `${tier} calibration ${rate.toFixed(3)} ≈ ${SIGNAL_TIER_ACCURACY[tier]}`,
    );
  }
});

test("claims are drawn independently — distinct reads across seats", () => {
  // Same crash point, many seats: each seat gets its own differently-drawn
  // claim (never identical across the whole table, even for the same tier).
  const crashPoint = 2.4; // low zone
  const claims = [];
  for (let i = 0; i < 20; i += 1) {
    claims.push(dealSignal(crashPoint, "strong").archetype);
  }
  const distinct = new Set(claims);
  assert.ok(
    distinct.size >= 2,
    `expected distinct reads across seats, got ${distinct.size} unique of ${claims.length}`,
  );
});

test("dealSignals covers every entered human/bot target", () => {
  const targets = [
    { userId: 1, isBot: false },
    { userId: 2, isBot: false },
    { userId: 3, isBot: true, aiDifficulty: "easy" },
    { userId: 4, isBot: true, aiDifficulty: "hard" },
  ];
  const byUser = dealSignals(targets, 5.8);
  assert.equal(byUser.size, 4);
  for (const t of targets) {
    const sig = byUser.get(t.userId);
    assert.ok(sig, `signal for user ${t.userId}`);
    assert.ok(sig.claim.length > 0);
    assert.ok(sig.accuracy > 0 && sig.accuracy <= 1);
  }
});

test("createHand attaches signals only to entered players, handFromEntries restores them", () => {
  const players = [
    { userId: 1, name: "a" },
    { userId: 2, name: "b" },
    { userId: 3, name: "c" },
  ];
  const signalsByUser = new Map([
    [1, dealSignal(3.3, "strong")],
    [3, dealSignal(3.3, "weak")],
  ]);
  const hand = createHand({
    players,
    wager: 10,
    stackByUser: new Map([
      [1, 100],
      [2, 100],
      [3, 100],
    ]),
    signalsByUser,
  });
  assert.deepEqual(hand.players[0].signal, signalsByUser.get(1));
  assert.equal(hand.players[1].signal, null); // not dealt
  assert.deepEqual(hand.players[2].signal, signalsByUser.get(3));

  const round = { id: 99, bigBlind: "10.00", handState: hand };
  const entries = hand.players.map((p) => ({
    userId: p.userId,
    contributed: String(p.contributed),
    isActive: p.isActive,
    allIn: p.allIn,
    foldedAtMultiplier: p.foldedAtMultiplier,
    lastAction: "ante",
    result: "pending",
  }));
  const rebuilt = handFromEntries({ round, entries, carryOver: 0 });
  assert.deepEqual(rebuilt.players[0].signal, signalsByUser.get(1));
  assert.equal(rebuilt.players[1].signal, null);
  assert.deepEqual(rebuilt.players[2].signal, signalsByUser.get(3));

  // A player under the ante floor sits the hand out and gets no signal.
  const handSitout = createHand({
    players,
    wager: 10,
    stackByUser: new Map([
      [1, 100],
      [2, 100],
      [3, 0.009],
    ]),
    signalsByUser: new Map([
      [1, dealSignal(3.3, "strong")],
      [3, dealSignal(3.3, "weak")],
    ]),
  });
  assert.equal(handSitout.players[2].isActive, false);
  assert.equal(handSitout.players[2].signal, null);
});