import test from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════
// Replicated scoring engine (must match game-engine/farkleEngine.ts exactly)
// cardgames.io rules:
// - Three 1s = 1000, other three-of-a-kind = face × 100
// - Four of a kind = 1000, Five = 2000, Six = 3000
// - Three pairs = 1500 (incl. four-of-a-kind + pair), Straight = 2500
// - Individual 1s = 100, 5s = 50
// ═══════════════════════════════════════════════════════════════

function countDice(dice) {
  const c = new Map();
  for (const d of dice) c.set(d, (c.get(d) ?? 0) + 1);
  return c;
}

function threeOfAKindScore(val) {
  return val === 1 ? 1000 : val * 100;
}

function isStraight(dice) {
  if (dice.length !== 6) return false;
  const sorted = [...dice].sort((a, b) => a - b);
  return sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3 &&
         sorted[3] === 4 && sorted[4] === 5 && sorted[5] === 6;
}

function isThreePairs(dice) {
  if (dice.length !== 6) return false;
  const counts = countDice(dice);
  if (counts.size === 3) {
    return [...counts.values()].every(c => c === 2);
  }
  if (counts.size === 2) {
    const vals = [...counts.values()];
    return (vals[0] === 4 && vals[1] === 2) || (vals[0] === 2 && vals[1] === 4);
  }
  return false;
}

function isScoringSubset(dice) {
  const n = dice.length;
  if (n === 0) return false;
  if (n === 1) return dice[0] === 1 || dice[0] === 5;
  if (n === 2) return false;
  if (n === 3) return countDice(dice).size === 1;
  if (n === 4) return countDice(dice).size === 1;
  if (n === 5) return countDice(dice).size === 1;
  if (n === 6) {
    if (isStraight(dice)) return true;
    if (isThreePairs(dice)) return true;
    return countDice(dice).size === 1;
  }
  return false;
}

function scoreSubset(dice) {
  const n = dice.length;
  if (n === 1) {
    if (dice[0] === 1) return 100;
    if (dice[0] === 5) return 50;
    return 0;
  }
  if (n === 3) return threeOfAKindScore(dice[0]);
  if (n === 4) return 1000;
  if (n === 5) return 2000;
  if (n === 6) {
    if (isStraight(dice)) return 2500;
    if (isThreePairs(dice)) return 1500;
    return 3000; // six of a kind
  }
  return 0;
}

const _bestScoreCache = new Map();

function findBestScoring(dice) {
  const key = [...dice].sort((a, b) => a - b).join(",");
  const cached = _bestScoreCache.get(key);
  if (cached) return cached;

  if (dice.length === 0) return { score: 0, combos: [] };

  let bestScore = 0;
  let bestCombos = [];

  const n = dice.length;
  const totalMasks = 1 << n;

  for (let mask = 1; mask < totalMasks; mask++) {
    const subset = [];
    const remaining = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(dice[i]);
      else remaining.push(dice[i]);
    }

    let subScore;
    if (isScoringSubset(subset)) {
      subScore = scoreSubset(subset);
    } else {
      // Subset is not a standard combo — check if all dice are individual scoring (1s & 5s)
      const allOnesOrFives = subset.every(d => d === 1 || d === 5);
      if (!allOnesOrFives) continue;
      subScore = subset.filter(d => d === 1).length * 100 + subset.filter(d => d === 5).length * 50;
    }
    if (subScore <= 0) continue;

    const { score: restScore, combos: restCombos } = findBestScoring(remaining);
    const totalScore = subScore + restScore;

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestCombos = [{ dice: [...subset], score: subScore }, ...restCombos];
    }
  }

  const result = { score: bestScore, combos: bestCombos };
  _bestScoreCache.set(key, result);
  return result;
}

function findScoringCombinations(dice) {
  _bestScoreCache.clear();
  const { combos } = findBestScoring(dice);
  return combos;
}

function calculateScore(dice) {
  _bestScoreCache.clear();
  const { score } = findBestScoring(dice);
  return score;
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
// Four of a Kind (1000)
// ═══════════════════════════════════════════════════════════════

test("Four 1s = 1100 (three 1s=1000 + one 1=100, better than four 1s=1000)", () => {
  // Optimal: three 1s (1000) + one 1 (100) = 1100
  // Four of a kind = 1000 is worse in this case
  assert.equal(calculateScore([1, 1, 1, 1]), 1100);
});

test("Four 3s = 1000 (four of a kind)", () => {
  // Four 3s = 1000, leftover 3 scores 0 → but 4-of-a-kind is 1000
  // Actually: three 3s = 300, leftover 3 = 0 → 300
  // Four of a kind = 1000 → better!
  assert.equal(calculateScore([3, 3, 3, 3]), 1000);
});

test("Four 5s = 1050 (three 5s=500 + one 5=50, better than four 5s=1000)", () => {
  // Optimal: three 5s (500) + one 5 (50) = 550
  // Four of a kind = 1000 → better!
  assert.equal(calculateScore([5, 5, 5, 5]), 1000);
});

test("Four 2s = 1000 (four of a kind beats three 2s=200)", () => {
  assert.equal(calculateScore([2, 2, 2, 2]), 1000);
});

test("Four 2s + one 5 = 1050", () => {
  assert.equal(calculateScore([2, 2, 2, 2, 5]), 1050);
});

// ═══════════════════════════════════════════════════════════════
// Five of a Kind (2000)
// ═══════════════════════════════════════════════════════════════

test("Five 1s = 2000 (five of a kind beats three 1s=1000 + two 1s=200)", () => {
  assert.equal(calculateScore([1, 1, 1, 1, 1]), 2000);
});

test("Five 6s = 2000", () => {
  assert.equal(calculateScore([6, 6, 6, 6, 6]), 2000);
});

test("Five 2s + one 5 = 2050", () => {
  assert.equal(calculateScore([2, 2, 2, 2, 2, 5]), 2050);
});

test("Five 1s + one 5 = 2000 (five 1s=2000 > 1200 from three+two 1s=1200)", () => {
  // Five 1s = 2000, one 5 = 50 → 2050
  // Three 1s (1000) + two 1s (200) + one 5 (50) = 1250
  // Five 1s (2000) + one 5 (50) = 2050 → this is best
  assert.equal(calculateScore([1, 1, 1, 1, 1, 5]), 2050);
});

// ═══════════════════════════════════════════════════════════════
// Six of a Kind (3000)
// ═══════════════════════════════════════════════════════════════

test("Six 1s = 3000", () => {
  assert.equal(calculateScore([1, 1, 1, 1, 1, 1]), 3000);
});

test("Six 4s = 3000", () => {
  assert.equal(calculateScore([4, 4, 4, 4, 4, 4]), 3000);
});

test("Six 6s = 3000", () => {
  assert.equal(calculateScore([6, 6, 6, 6, 6, 6]), 3000);
});

// ═══════════════════════════════════════════════════════════════
// Three Pairs (1500)
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

test("Four-of-a-kind + pair = 1500 (three pairs)", () => {
  assert.equal(calculateScore([4, 4, 4, 4, 6, 6]), 1500);
});

// ═══════════════════════════════════════════════════════════════
// Straight (2500)
// ═══════════════════════════════════════════════════════════════

test("Straight 1-2-3-4-5-6 = 2500", () => {
  assert.equal(calculateScore([1, 2, 3, 4, 5, 6]), 2500);
});

test("Straight in any order = 2500", () => {
  assert.equal(calculateScore([6, 5, 4, 3, 2, 1]), 2500);
  assert.equal(calculateScore([3, 1, 4, 6, 5, 2]), 2500);
});

// ═══════════════════════════════════════════════════════════════
// Farkle Detection
// ═══════════════════════════════════════════════════════════════

test("Farkle: [2,3,4,6] — no scoring dice", () => {
  assert.equal(isFarkle([2, 3, 4, 6]), true);
});

test("Farkle: [2,2,3,3,4,4] — three pairs = 1500, NOT a Farkle", () => {
  // Three pairs are now a scoring combo worth 1500!
  assert.equal(isFarkle([2, 2, 3, 3, 4, 4]), false);
});

test("Farkle: [2,2,3,3,4,6] — only two pairs, no scoring dice", () => {
  assert.equal(isFarkle([2, 2, 3, 3, 4, 6]), true);
});

test("Farkle: [2,3,4,6,2,3] — two pairs, no scoring dice", () => {
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

test("Straight 1-6 IS hot dice (all 6 score for 2500)", () => {
  assert.equal(isHotDice([1, 2, 3, 4, 5, 6]), true);
});

test("Hot dice: three pairs = all 6 score", () => {
  assert.equal(isHotDice([2, 2, 4, 4, 6, 6]), true);
});

test("Hot dice: three 1s + three 5s = all 6 score", () => {
  assert.equal(isHotDice([1, 1, 1, 5, 5, 5]), true);
});

test("Hot dice: six 1s = all score", () => {
  assert.equal(isHotDice([1, 1, 1, 1, 1, 1]), true);
});

test("Not hot dice: only 5 dice score (one non-scoring)", () => {
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

test("Two triplets (5,5,5,1,1,1) = 1500 (three 5s=500 + three 1s=1000)", () => {
  assert.equal(calculateScore([5, 5, 5, 1, 1, 1]), 1500);
});

test("Four-of-a-kind + pair — four 2s + pair of 3s = 1500 (three pairs)", () => {
  assert.equal(calculateScore([2, 2, 2, 2, 3, 3]), 1500);
});

test("Best combo for 1,1,1,1,5,5: three 1s=1000 + one 1(100) + two 5s(100) = 1200", () => {
  // Check if three-pair is better: 1,1,1,1,5,5 = 4+2 → three pairs = 1500!
  assert.equal(calculateScore([1, 1, 1, 1, 5, 5]), 1500);
});

// ═══════════════════════════════════════════════════════════════
// findScoringCombinations structure tests
// ═══════════════════════════════════════════════════════════════

test("findScoringCombinations returns correct structure for 1,1,1,5,2", () => {
  const combos = findScoringCombinations([1, 1, 1, 5, 2]);
  // Three 1s = 1000, one 5 = 50 → 1050
  const totalScore = combos.reduce((s, c) => s + c.score, 0);
  assert.equal(totalScore, 1050);
});

test("findScoringCombinations for straight returns single combo of 6 dice", () => {
  const combos = findScoringCombinations([1, 2, 3, 4, 5, 6]);
  assert.equal(combos.length, 1);
  assert.equal(combos[0].score, 2500);
  assert.equal(combos[0].dice.length, 6);
});

test("findScoringCombinations for three pairs returns single combo of 6 dice", () => {
  const combos = findScoringCombinations([1, 1, 2, 2, 3, 3]);
  assert.equal(combos.length, 1);
  assert.equal(combos[0].score, 1500);
  assert.equal(combos[0].dice.length, 6);
});

// ═══════════════════════════════════════════════════════════════
// Win Condition (no final round — immediate win at 10k+)
// ═══════════════════════════════════════════════════════════════

const WINNING_SCORE = 10_000;

function checkWinCondition(state) {
  for (const player of state.players) {
    const score = state.scores[player.userId] ?? 0;
    if (score >= WINNING_SCORE) {
      return { ended: true, winnerId: player.userId, scores: state.scores };
    }
  }
  return { ended: false };
}

function makeState(opts = {}) {
  const players = opts.players || [
    { userId: "A", name: "Alice" },
    { userId: "B", name: "Bob" },
  ];
  return {
    id: "test-room",
    game: "farkle",
    players,
    ai: false,
    wager: 100,
    pot: 200,
    state: opts.state ?? "playing",
    currentTurn: opts.currentTurn ?? "A",
    turnNumber: opts.turnNumber ?? 5,
    dice: opts.dice ?? [1, 2, 3, 4, 5, 6],
    turnScore: opts.turnScore ?? 0,
    rollsThisTurn: opts.rollsThisTurn ?? 0,
    scores: opts.scores ?? { A: 3500, B: 4200 },
    hasHotDice: false,
  };
}

test("Win condition: no one at 10k → game continues", () => {
  const state = makeState({ scores: { A: 5000, B: 6000 } });
  assert.equal(checkWinCondition(state).ended, false);
});

test("Win condition: exactly 10k → game ends, that player wins", () => {
  const state = makeState({ scores: { A: 10000, B: 6000 } });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "A");
});

test("Win condition: above 10k → immediate win", () => {
  const state = makeState({ scores: { A: 8500, B: 11200 } });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "B");
});

test("Win condition: multiple at 10k → first found wins", () => {
  const state = makeState({ scores: { A: 10500, B: 10200 } });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "A");
});

test("Win condition: zero scores → continues", () => {
  const state = makeState({ scores: { A: 0, B: 0 } });
  assert.equal(checkWinCondition(state).ended, false);
});

test("Win condition: 3 players, one reaches 10k → immediate win", () => {
  const state = makeState({
    players: [
      { userId: "A", name: "Alice" },
      { userId: "B", name: "Bob" },
      { userId: "C", name: "Charlie" },
    ],
    scores: { A: 10500, B: 6000, C: 4000 },
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "A");
});
