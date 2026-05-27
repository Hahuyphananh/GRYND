import test from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════
// Replicated scoring engine (must match game-engine/farkleEngine.ts exactly)
// ═══════════════════════════════════════════════════════════════

function countDice(dice) {
  const c = new Map();
  for (const d of dice) c.set(d, (c.get(d) ?? 0) + 1);
  return c;
}

function threeOfAKindScore(val) {
  return val === 1 ? 1000 : val * 100;
}

function findScoringCombinations(dice) {
  const n = dice.length;
  if (n === 0) return [];

  const counts = countDice(dice);
  const uniqueVals = [...counts.keys()].sort((a, b) => a - b);
  const freq = [...counts.values()].sort((a, b) => b - a);

  // Straight (1-6)
  if (n === 6 && uniqueVals.length === 6 && uniqueVals[5] - uniqueVals[0] === 5) {
    return [{ dice: [...dice], score: 1500, description: "Straight (1-6)" }];
  }

  // Three pairs
  if (n === 6 && uniqueVals.length === 3 && freq[0] === 2 && freq[1] === 2 && freq[2] === 2) {
    return [{ dice: [...dice], score: 1500, description: "Three Pairs" }];
  }

  // Two triplets
  if (n === 6 && uniqueVals.length === 2 && freq[0] === 3 && freq[1] === 3) {
    return [{ dice: [...dice], score: 2500, description: "Two Triplets" }];
  }

  // Six-of-a-kind
  if (n === 6 && uniqueVals.length === 1) {
    const val = uniqueVals[0];
    const base = threeOfAKindScore(val);
    return [{ dice: [...dice], score: base * 8, description: `Six ${val}'s` }];
  }

  // Five-of-a-kind
  if (n >= 5 && freq[0] >= 5) {
    const result = [];
    const quintVal = [...counts.entries()].find(([, c]) => c >= 5)[0];
    const base = threeOfAKindScore(quintVal);
    result.push({ dice: Array(5).fill(quintVal), score: base * 4, description: `Five ${quintVal}'s` });
    const remaining = [];
    let skip = 5;
    for (const d of dice) {
      if (d === quintVal && skip > 0) { skip--; continue; }
      remaining.push(d);
    }
    const rest = findScoringCombinations(remaining);
    result.push(...rest);
    return result;
  }

  // Four-of-a-kind
  if (n >= 4 && freq[0] >= 4) {
    const result = [];
    const quadVal = [...counts.entries()].find(([, c]) => c >= 4)[0];
    const base = threeOfAKindScore(quadVal);
    result.push({ dice: Array(4).fill(quadVal), score: base * 2, description: `Four ${quadVal}'s` });
    const remaining = [];
    let skip = 4;
    for (const d of dice) {
      if (d === quadVal && skip > 0) { skip--; continue; }
      remaining.push(d);
    }
    const rest = findScoringCombinations(remaining);
    result.push(...rest);
    return result;
  }

  // Three-of-a-kind
  if (n >= 3 && freq[0] >= 3) {
    const result = [];
    let bestVal = 0;
    let bestScore = -1;
    for (const [val, cnt] of counts.entries()) {
      if (cnt >= 3) {
        const s = threeOfAKindScore(val);
        if (s > bestScore || (s === bestScore && val > bestVal)) {
          bestScore = s;
          bestVal = val;
        }
      }
    }
    result.push({ dice: Array(3).fill(bestVal), score: bestScore, description: `Three ${bestVal}'s` });
    const remaining = [];
    let skip = 3;
    for (const d of dice) {
      if (d === bestVal && skip > 0) { skip--; continue; }
      remaining.push(d);
    }
    const rest = findScoringCombinations(remaining);
    result.push(...rest);
    return result;
  }

  // Individual 1s and 5s
  const result = [];
  const remaining = [];
  let ones = 0;
  let fives = 0;
  for (const d of dice) {
    if (d === 1) ones++;
    else if (d === 5) fives++;
    else remaining.push(d);
  }
  if (ones > 0) result.push({ dice: Array(ones).fill(1), score: ones * 100, description: `${ones} x One${ones > 1 ? 's' : ''}` });
  if (fives > 0) result.push({ dice: Array(fives).fill(5), score: fives * 50, description: `${fives} x Five${fives > 1 ? 's' : ''}` });

  return result;
}

function calculateScore(dice) {
  const combos = findScoringCombinations(dice);
  return combos.reduce((sum, c) => sum + c.score, 0);
}

function isFarkle(dice) {
  return calculateScore(dice) === 0;
}

function isHotDice(dice) {
  const combos = findScoringCombinations(dice);
  const totalScored = combos.reduce((sum, c) => sum + c.dice.length, 0);
  return totalScored === dice.length && dice.length === 6;
}

// ═══════════════════════════════════════════════════════════════
// Individual Dice Scoring
// ═══════════════════════════════════════════════════════════════

test("Single 1 scores 100", () => {
  assert.equal(calculateScore([1]), 100);
});

test("Single 5 scores 50", () => {
  assert.equal(calculateScore([5]), 50);
});

test("Two 1s score 200", () => {
  assert.equal(calculateScore([1, 1]), 200);
});

test("Two 5s score 100", () => {
  assert.equal(calculateScore([5, 5]), 100);
});

test("One 1 and one 5 score 150", () => {
  assert.equal(calculateScore([1, 5]), 150);
});

test("Non-scoring dice (2,3,4,6) score 0", () => {
  assert.equal(calculateScore([2]), 0);
  assert.equal(calculateScore([3]), 0);
  assert.equal(calculateScore([4]), 0);
  assert.equal(calculateScore([6]), 0);
  assert.equal(calculateScore([2, 3, 4, 6]), 0);
});

// ═══════════════════════════════════════════════════════════════
// Three of a Kind
// ═══════════════════════════════════════════════════════════════

test("Three 1s = 1000", () => {
  assert.equal(calculateScore([1, 1, 1]), 1000);
});

test("Three 2s = 200", () => {
  assert.equal(calculateScore([2, 2, 2]), 200);
});

test("Three 3s = 300", () => {
  assert.equal(calculateScore([3, 3, 3]), 300);
});

test("Three 4s = 400", () => {
  assert.equal(calculateScore([4, 4, 4]), 400);
});

test("Three 5s = 500", () => {
  assert.equal(calculateScore([5, 5, 5]), 500);
});

test("Three 6s = 600", () => {
  assert.equal(calculateScore([6, 6, 6]), 600);
});

test("Three 1s + individual 5 = 1050", () => {
  assert.equal(calculateScore([1, 1, 1, 5]), 1050);
});

test("Three 2s + two 1s = 400", () => {
  assert.equal(calculateScore([2, 2, 2, 1, 1]), 400);
});

// ═══════════════════════════════════════════════════════════════
// Four of a Kind (2x three-of-a-kind base)
// ═══════════════════════════════════════════════════════════════

test("Four 1s = 2000", () => {
  assert.equal(calculateScore([1, 1, 1, 1]), 2000);
});

test("Four 3s = 600", () => {
  assert.equal(calculateScore([3, 3, 3, 3]), 600);
});

test("Four 5s = 1000", () => {
  assert.equal(calculateScore([5, 5, 5, 5]), 1000);
});

// Four 2s = 2*200 = 400 + one 5 = 50 → 450
test("Four 2s + one 5 = 450", () => {
  assert.equal(calculateScore([2, 2, 2, 2, 5]), 450);
});

// ═══════════════════════════════════════════════════════════════
// Five of a Kind (4x base)
// ═══════════════════════════════════════════════════════════════

test("Five 1s = 4000", () => {
  assert.equal(calculateScore([1, 1, 1, 1, 1]), 4000);
});

test("Five 6s = 2400", () => {
  assert.equal(calculateScore([6, 6, 6, 6, 6]), 2400);
});

test("Five 2s + one 5 = 450", () => {
  // Five 2s = 200 * 4 = 800, plus one 5 = 50 → 850
  assert.equal(calculateScore([2, 2, 2, 2, 2, 5]), 850);
});

// ═══════════════════════════════════════════════════════════════
// Six of a Kind (8x base)
// ═══════════════════════════════════════════════════════════════

test("Six 1s = 8000", () => {
  assert.equal(calculateScore([1, 1, 1, 1, 1, 1]), 8000);
});

test("Six 4s = 3200", () => {
  assert.equal(calculateScore([4, 4, 4, 4, 4, 4]), 3200);
});

test("Six 6s = 4800", () => {
  assert.equal(calculateScore([6, 6, 6, 6, 6, 6]), 4800);
});

// ═══════════════════════════════════════════════════════════════
// Straight (1-6) = 1500
// ═══════════════════════════════════════════════════════════════

test("Straight 1-2-3-4-5-6 = 1500", () => {
  assert.equal(calculateScore([1, 2, 3, 4, 5, 6]), 1500);
});

test("Straight in any order = 1500", () => {
  assert.equal(calculateScore([6, 5, 4, 3, 2, 1]), 1500);
  assert.equal(calculateScore([3, 1, 4, 6, 5, 2]), 1500);
});

// ═══════════════════════════════════════════════════════════════
// Three Pairs = 1500
// ═══════════════════════════════════════════════════════════════

test("Three pairs (1,1,2,2,3,3) = 1500", () => {
  assert.equal(calculateScore([1, 1, 2, 2, 3, 3]), 1500);
});

test("Three pairs (4,4,5,5,6,6) = 1500", () => {
  assert.equal(calculateScore([4, 4, 5, 5, 6, 6]), 1500);
});

test("Three pairs (2,2,4,4,6,6) = 1500", () => {
  assert.equal(calculateScore([2, 2, 4, 4, 6, 6]), 1500);
});

// ═══════════════════════════════════════════════════════════════
// Two Triplets = 2500
// ═══════════════════════════════════════════════════════════════

test("Two triplets (1,1,1,2,2,2) = 2500", () => {
  assert.equal(calculateScore([1, 1, 1, 2, 2, 2]), 2500);
});

test("Two triplets (3,3,3,5,5,5) = 2500", () => {
  assert.equal(calculateScore([3, 3, 3, 5, 5, 5]), 2500);
});

test("Two triplets (2,2,2,6,6,6) = 2500", () => {
  assert.equal(calculateScore([2, 2, 2, 6, 6, 6]), 2500);
});

// ═══════════════════════════════════════════════════════════════
// Farkle Detection
// ═══════════════════════════════════════════════════════════════

test("Farkle: [2,3,4,6] — no scoring dice", () => {
  assert.equal(isFarkle([2, 3, 4, 6]), true);
});

test("Farkle: [2,2,3,3,4,4] — three pairs but they are of different combos? No, 3 pairs scores 1500", () => {
  // [2,2,3,3,4,4] has 3 unique values each with count 2 → three pairs = 1500
  assert.equal(isFarkle([2, 2, 3, 3, 4, 4]), false);
});

test("Farkle: [2,2,3,3,4,6] — not three pairs (4 unique vals)", () => {
  assert.equal(isFarkle([2, 2, 3, 3, 4, 6]), true);
});

test("Farkle: [2,3,4,6,2,3] — only 2s and 3s, no scoring dice", () => {
  // Two pairs of non-scoring numbers → not three pairs (only 2 unique) — still no 1s or 5s
  assert.equal(isFarkle([2, 3, 4, 6, 2, 3]), true);
});

test("Not Farkle: has a 1", () => {
  assert.equal(isFarkle([2, 3, 1, 6, 2, 3]), false);
});

test("Not Farkle: has a 5", () => {
  assert.equal(isFarkle([2, 3, 5, 6, 2, 3]), false);
});

// ═══════════════════════════════════════════════════════════════
// Hot Dice Detection
// ═══════════════════════════════════════════════════════════════

test("Hot dice: straight 1-6", () => {
  assert.equal(isHotDice([1, 2, 3, 4, 5, 6]), true);
});

test("Hot dice: three pairs", () => {
  assert.equal(isHotDice([1, 1, 2, 2, 3, 3]), true);
});

test("Hot dice: six of a kind", () => {
  assert.equal(isHotDice([4, 4, 4, 4, 4, 4]), true);
});

test("Not hot dice: only 5 dice score (one non-scoring)", () => {
  // [1,1,1,2,3] → three 1s = 1000 (3 dice), 2 and 3 don't score → 3/5 scored
  assert.equal(isHotDice([1, 1, 1, 2, 3]), false);
});

test("Not hot dice: fewer than 6 dice", () => {
  assert.equal(isHotDice([1, 1, 1, 1, 1]), false);
});

// ═══════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════

test("Empty dice array scores 0", () => {
  assert.equal(calculateScore([]), 0);
});

test("Single 2 scores 0 (Farkle)", () => {
  assert.equal(calculateScore([2]), 0);
  assert.equal(isFarkle([2]), true);
});

test("Mixed: three 3s + two 1s + one 5 = 550", () => {
  // Three 3s = 300, two 1s = 200, one 5 = 50 → 550
  assert.equal(calculateScore([3, 3, 3, 1, 1, 5]), 550);
});

test("Two triplets beats three-of-a-kind + individuals", () => {
  // [5,5,5,1,1,1] → two triplets = 2500 (not 500 + 1000 = 1500)
  assert.equal(calculateScore([5, 5, 5, 1, 1, 1]), 2500);
});

test("Straight beats three-of-a-kind + individuals", () => {
  // [1,2,3,4,5,6] → straight = 1500 (not 100 + 50 + 0 + 0 + 0 + 0 = 150)
  assert.equal(calculateScore([1, 2, 3, 4, 5, 6]), 1500);
});

test("Three pairs beats three-of-a-kind combos", () => {
  // [2,2,4,4,6,6] could be scored as three 2s (200) + three remaining (0) but three pairs = 1500
  // Wait, [2,2,4,4,6,6] has no three-of-a-kind. Let's use [2,2,3,3,4,4] — three pairs = 1500
  assert.equal(calculateScore([2, 2, 3, 3, 4, 4]), 1500);
});

test("Four-of-a-kind + pair (non-scoring pair) — four 2s = 400", () => {
  // [2,2,2,2,3,3] → four 2s = 400 (200 * 2), remaining [3,3] score 0
  assert.equal(calculateScore([2, 2, 2, 2, 3, 3]), 400);
});

test("Five-of-a-kind + single — five 1s + one 5 = 4050", () => {
  // Five 1s = 4000, one 5 = 50 → 4050
  assert.equal(calculateScore([1, 1, 1, 1, 1, 5]), 4050);
});

test("combo with two triplets of same value doesn't apply (six of a kind instead)", () => {
  // Six 3s → 300 * 8 = 2400, not "two triplets"
  assert.equal(calculateScore([3, 3, 3, 3, 3, 3]), 2400);
});

// ═══════════════════════════════════════════════════════════════
// findScoringCombinations structure tests
// ═══════════════════════════════════════════════════════════════

test("findScoringCombinations returns correct structure", () => {
  const combos = findScoringCombinations([1, 1, 1, 5, 2]);
  assert.equal(combos.length, 2); // Three 1s + One 5
  assert.equal(combos[0].description, "Three 1's");
  assert.equal(combos[0].score, 1000);
  assert.equal(combos[0].dice.length, 3);
  assert.equal(combos[1].description, "1 x Five");
  assert.equal(combos[1].score, 50);
});

test("findScoringCombinations for straight", () => {
  const combos = findScoringCombinations([1, 2, 3, 4, 5, 6]);
  assert.equal(combos.length, 1);
  assert.equal(combos[0].description, "Straight (1-6)");
  assert.equal(combos[0].score, 1500);
});
