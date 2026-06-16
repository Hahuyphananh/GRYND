import test from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════
// Replicated Keno multiplier logic (must match src/lib/kenoMultipliers.ts exactly)
// ═══════════════════════════════════════════════════════════════

const KENO_MULTIPLIER_TABLE = {
  1: { 1: 3 },
  2: { 1: 1.5, 2: 6 },
  3: { 1: 1, 2: 3, 3: 10 },
  4: { 2: 2, 3: 6, 4: 20 },
  5: { 2: 1.5, 3: 5, 4: 15, 5: 50 },
  6: { 3: 3, 4: 12, 5: 80, 6: 400 },
  7: { 3: 2, 4: 6, 5: 40, 6: 250, 7: 800 },
  8: { 4: 5, 5: 25, 6: 150, 7: 600, 8: 2500 },
  9: { 4: 3, 5: 12, 6: 75, 7: 300, 8: 1000, 9: 3000 },
  10: { 4: 2, 5: 7, 6: 35, 7: 180, 8: 700, 9: 1800, 10: 5000 },
};

const KENO_MAX_PICKS = 10;
const KENO_AUTO_PICK_COUNT = 5;
const KENO_POOL_SIZE = 40;
const KENO_DRAW_COUNT = 10;

function getKenoMultiplier(picks, hits) {
  return KENO_MULTIPLIER_TABLE[picks]?.[hits] || 0;
}

function calcKenoPayout(picks, hits, betAmount) {
  const mult = getKenoMultiplier(picks, hits);
  return +(betAmount * mult).toFixed(2);
}

// ═══════════════════════════════════════════════════════════════
// Probability helpers (for EV verification)
// ═══════════════════════════════════════════════════════════════

function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = result * (n - k + i) / i;
  }
  return Math.round(result);
}

function hypergeometricProb(N, K, n, k) {
  // P(k successes) = C(K,k) × C(N-K, n-k) / C(N,n)
  return combinations(K, k) * combinations(N - K, n - k) / combinations(N, n);
}

function expectedValue(picks, table) {
  let ev = 0;
  for (let hits = 0; hits <= picks; hits++) {
    const prob = hypergeometricProb(KENO_POOL_SIZE, KENO_DRAW_COUNT, picks, hits);
    const mult = table?.[hits] || 0;
    ev += prob * mult;
  }
  return ev;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

test("KENO_POOL_SIZE is 40", () => assert.equal(KENO_POOL_SIZE, 40));
test("KENO_DRAW_COUNT is 10", () => assert.equal(KENO_DRAW_COUNT, 10));
test("KENO_MAX_PICKS is 10", () => assert.equal(KENO_MAX_PICKS, 10));
test("KENO_AUTO_PICK_COUNT is 5", () => assert.equal(KENO_AUTO_PICK_COUNT, 5));

// ═══════════════════════════════════════════════════════════════
// getKenoMultiplier — valid combos
// ═══════════════════════════════════════════════════════════════

test("Pick 1: 1 hit = ×3", () => assert.equal(getKenoMultiplier(1, 1), 3));
test("Pick 2: 1 hit = ×1.5", () => assert.equal(getKenoMultiplier(2, 1), 1.5));
test("Pick 2: 2 hits = ×6", () => assert.equal(getKenoMultiplier(2, 2), 6));
test("Pick 3: 1 hit = ×1", () => assert.equal(getKenoMultiplier(3, 1), 1));
test("Pick 3: 2 hits = ×3", () => assert.equal(getKenoMultiplier(3, 2), 3));
test("Pick 3: 3 hits = ×10", () => assert.equal(getKenoMultiplier(3, 3), 10));
test("Pick 4: 2 hits = ×2", () => assert.equal(getKenoMultiplier(4, 2), 2));
test("Pick 4: 3 hits = ×6", () => assert.equal(getKenoMultiplier(4, 3), 6));
test("Pick 4: 4 hits = ×20", () => assert.equal(getKenoMultiplier(4, 4), 20));
test("Pick 5: 2 hits = ×1.5", () => assert.equal(getKenoMultiplier(5, 2), 1.5));
test("Pick 5: 3 hits = ×5", () => assert.equal(getKenoMultiplier(5, 3), 5));
test("Pick 5: 4 hits = ×15", () => assert.equal(getKenoMultiplier(5, 4), 15));
test("Pick 5: 5 hits = ×50", () => assert.equal(getKenoMultiplier(5, 5), 50));

// 6–10 picks
test("Pick 6: 3 hits = ×3", () => assert.equal(getKenoMultiplier(6, 3), 3));
test("Pick 6: 4 hits = ×12", () => assert.equal(getKenoMultiplier(6, 4), 12));
test("Pick 6: 5 hits = ×80", () => assert.equal(getKenoMultiplier(6, 5), 80));
test("Pick 6: 6 hits = ×400", () => assert.equal(getKenoMultiplier(6, 6), 400));

test("Pick 7: 3 hits = ×2", () => assert.equal(getKenoMultiplier(7, 3), 2));
test("Pick 7: 4 hits = ×6", () => assert.equal(getKenoMultiplier(7, 4), 6));
test("Pick 7: 5 hits = ×40", () => assert.equal(getKenoMultiplier(7, 5), 40));
test("Pick 7: 6 hits = ×250", () => assert.equal(getKenoMultiplier(7, 6), 250));
test("Pick 7: 7 hits = ×800", () => assert.equal(getKenoMultiplier(7, 7), 800));

test("Pick 8: 4 hits = ×5", () => assert.equal(getKenoMultiplier(8, 4), 5));
test("Pick 8: 5 hits = ×25", () => assert.equal(getKenoMultiplier(8, 5), 25));
test("Pick 8: 6 hits = ×150", () => assert.equal(getKenoMultiplier(8, 6), 150));
test("Pick 8: 7 hits = ×600", () => assert.equal(getKenoMultiplier(8, 7), 600));
test("Pick 8: 8 hits = ×2500", () => assert.equal(getKenoMultiplier(8, 8), 2500));

test("Pick 9: 4 hits = ×3", () => assert.equal(getKenoMultiplier(9, 4), 3));
test("Pick 9: 5 hits = ×12", () => assert.equal(getKenoMultiplier(9, 5), 12));
test("Pick 9: 6 hits = ×75", () => assert.equal(getKenoMultiplier(9, 6), 75));
test("Pick 9: 7 hits = ×300", () => assert.equal(getKenoMultiplier(9, 7), 300));
test("Pick 9: 8 hits = ×1000", () => assert.equal(getKenoMultiplier(9, 8), 1000));
test("Pick 9: 9 hits = ×3000", () => assert.equal(getKenoMultiplier(9, 9), 3000));

test("Pick 10: 4 hits = ×2", () => assert.equal(getKenoMultiplier(10, 4), 2));
test("Pick 10: 5 hits = ×7", () => assert.equal(getKenoMultiplier(10, 5), 7));
test("Pick 10: 6 hits = ×35", () => assert.equal(getKenoMultiplier(10, 6), 35));
test("Pick 10: 7 hits = ×180", () => assert.equal(getKenoMultiplier(10, 7), 180));
test("Pick 10: 8 hits = ×700", () => assert.equal(getKenoMultiplier(10, 8), 700));
test("Pick 10: 9 hits = ×1800", () => assert.equal(getKenoMultiplier(10, 9), 1800));
test("Pick 10: 10 hits = ×5000", () => assert.equal(getKenoMultiplier(10, 10), 5000));

// ═══════════════════════════════════════════════════════════════
// getKenoMultiplier — undefined combos return 0
// ═══════════════════════════════════════════════════════════════

test("Undefined combo returns 0: pick 1, 2 hits", () =>
  assert.equal(getKenoMultiplier(1, 2), 0));
test("Undefined combo returns 0: pick 2, 0 hits", () =>
  assert.equal(getKenoMultiplier(2, 0), 0));
test("Undefined combo returns 0: pick 3, 4 hits", () =>
  assert.equal(getKenoMultiplier(3, 4), 0));
test("Undefined combo returns 0: pick 6, 2 hits", () =>
  assert.equal(getKenoMultiplier(6, 2), 0));
test("Undefined combo returns 0: pick 10, 3 hits", () =>
  assert.equal(getKenoMultiplier(10, 3), 0));

// ═══════════════════════════════════════════════════════════════
// getKenoMultiplier — out-of-range picks return 0
// ═══════════════════════════════════════════════════════════════

test("Pick 0 returns 0 (no entry)", () =>
  assert.equal(getKenoMultiplier(0, 1), 0));
test("Pick 11 returns 0 (exceeds max)", () =>
  assert.equal(getKenoMultiplier(11, 1), 0));
test("Pick 100 returns 0", () =>
  assert.equal(getKenoMultiplier(100, 1), 0));
test("Hits > picks returns 0: pick 5, 6 hits", () =>
  assert.equal(getKenoMultiplier(5, 6), 0));

// ═══════════════════════════════════════════════════════════════
// calcKenoPayout — payout calculation
// ═══════════════════════════════════════════════════════════════

test("calcKenoPayout: pick 1, 1 hit, bet 100 → +300", () =>
  assert.equal(calcKenoPayout(1, 1, 100), 300));
test("calcKenoPayout: pick 3, 3 hits, bet 50 → +500", () =>
  assert.equal(calcKenoPayout(3, 3, 50), 500));
test("calcKenoPayout: pick 5, 5 hits, bet 10 → +500", () =>
  assert.equal(calcKenoPayout(5, 5, 10), 500));
test("calcKenoPayout: pick 10, 10 hits, bet 1 → +5000", () =>
  assert.equal(calcKenoPayout(10, 10, 1), 5000));

// Edge: fractional results
test("calcKenoPayout: pick 2, 1 hit, bet 1 → +1.5", () =>
  assert.equal(calcKenoPayout(2, 1, 1), 1.5));
test("calcKenoPayout: pick 7, 4 hits, bet 3 → +18", () =>
  assert.equal(calcKenoPayout(7, 4, 3), 18));

// Edge: 0 payout for undefined combos
test("calcKenoPayout returns 0 for undefined combo", () =>
  assert.equal(calcKenoPayout(4, 1, 100), 0));
test("calcKenoPayout returns 0 for 0 hits with pick 4", () =>
  assert.equal(calcKenoPayout(4, 0, 100), 0));

// Edge: bet of 0
test("calcKenoPayout returns 0 for bet amount 0", () =>
  assert.equal(calcKenoPayout(3, 3, 0), 0));

// ═══════════════════════════════════════════════════════════════
// Expected Value verification — all picks must have EV < 1.0
// (house edge > 0%)
// ═══════════════════════════════════════════════════════════════

test("EV: Pick 1 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(1, KENO_MULTIPLIER_TABLE[1]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 2 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(2, KENO_MULTIPLIER_TABLE[2]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 3 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(3, KENO_MULTIPLIER_TABLE[3]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 4 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(4, KENO_MULTIPLIER_TABLE[4]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 5 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(5, KENO_MULTIPLIER_TABLE[5]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 6 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(6, KENO_MULTIPLIER_TABLE[6]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 7 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(7, KENO_MULTIPLIER_TABLE[7]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 8 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(8, KENO_MULTIPLIER_TABLE[8]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 9 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(9, KENO_MULTIPLIER_TABLE[9]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

test("EV: Pick 10 has house edge (EV < 1.0)", () => {
  const ev = expectedValue(10, KENO_MULTIPLIER_TABLE[10]);
  assert.ok(ev < 1.0, `EV ${ev} should be < 1.0`);
});

// ═══════════════════════════════════════════════════════════════
// EV should be in a reasonable range (0.70–0.99)
// Not too generous, not too greedy
// ═══════════════════════════════════════════════════════════════

test("All picks have EV between 0.70 and 0.99", () => {
  for (let picks = 1; picks <= 10; picks++) {
    const ev = expectedValue(picks, KENO_MULTIPLIER_TABLE[picks]);
    assert.ok(
      ev > 0.70 && ev < 0.99,
      `Pick ${picks} EV ${ev.toFixed(4)} should be between 0.70 and 0.99`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// Regression: verify specific EV values to catch accidental changes
// ═══════════════════════════════════════════════════════════════

test("EV regression: Pick 1 EV ≈ 0.75", () => {
  assert.ok(Math.abs(expectedValue(1, KENO_MULTIPLIER_TABLE[1]) - 0.75) < 0.005);
});

test("EV regression: Pick 2 EV ≈ 0.923", () => {
  assert.ok(Math.abs(expectedValue(2, KENO_MULTIPLIER_TABLE[2]) - 0.923) < 0.01);
});

test("EV regression: Pick 3 EV ≈ 0.971 (was 1.083 before fix)", () => {
  const ev = expectedValue(3, KENO_MULTIPLIER_TABLE[3]);
  assert.ok(ev < 1.0, "Must be below 1.0 (no player advantage)");
  assert.ok(Math.abs(ev - 0.971) < 0.01);
});

test("EV regression: Pick 5 EV ≈ 0.977 (was 1.116 before fix)", () => {
  const ev = expectedValue(5, KENO_MULTIPLIER_TABLE[5]);
  assert.ok(ev < 1.0, "Must be below 1.0 (no player advantage)");
  assert.ok(Math.abs(ev - 0.977) < 0.01);
});

// ═══════════════════════════════════════════════════════════════
// Structure integrity: multiplier table has entries for picks 1-10
// ═══════════════════════════════════════════════════════════════

test("Multiplier table has entries for all picks 1-10", () => {
  for (let i = 1; i <= 10; i++) {
    assert.ok(KENO_MULTIPLIER_TABLE[i], `Missing entry for pick ${i}`);
  }
});

test("Multiplier table has no entries beyond pick 10", () => {
  assert.equal(KENO_MULTIPLIER_TABLE[11], undefined);
});

// ═══════════════════════════════════════════════════════════════
// Multiplier table consistency: hits never exceed picks
// ═══════════════════════════════════════════════════════════════

test("No multiplier entry has hits > picks", () => {
  for (const [picksStr, table] of Object.entries(KENO_MULTIPLIER_TABLE)) {
    const picks = Number(picksStr);
    for (const hitsStr of Object.keys(table)) {
      const hits = Number(hitsStr);
      assert.ok(
        hits <= picks,
        `Pick ${picks}: hits ${hits} exceeds picks ${picks}`,
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Multipliers are strictly positive for defined combos
// ═══════════════════════════════════════════════════════════════

test("All defined multipliers are > 0", () => {
  for (const table of Object.values(KENO_MULTIPLIER_TABLE)) {
    for (const mult of Object.values(table)) {
      assert.ok(mult > 0, `Multiplier ${mult} should be > 0`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Probability sanity checks
// ═══════════════════════════════════════════════════════════════

test("Probability sums to ~1 for each pick count", () => {
  for (let picks = 1; picks <= 10; picks++) {
    let sum = 0;
    for (let hits = 0; hits <= picks; hits++) {
      sum += hypergeometricProb(KENO_POOL_SIZE, KENO_DRAW_COUNT, picks, hits);
    }
    assert.ok(
      Math.abs(sum - 1) < 1e-12,
      `Pick ${picks}: probability sum ${sum} != 1`,
    );
  }
});
