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
  return val === 1 ? 300 : val * 100;
}

function findScoringCombinations(dice) {
  const n = dice.length;
  if (n === 0) return [];

  const counts = countDice(dice);
  const freq = [...counts.values()].sort((a, b) => b - a);

  // Three-of-a-kind (pick highest-value triplet first)
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

test("Three 1s = 300", () => {
  assert.equal(calculateScore([1, 1, 1]), 300);
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

test("Three 1s + individual 5 = 350", () => {
  assert.equal(calculateScore([1, 1, 1, 5]), 350);
});

test("Three 2s + two 1s = 400", () => {
  assert.equal(calculateScore([2, 2, 2, 1, 1]), 400);
});

// ═══════════════════════════════════════════════════════════════
// Four of a Kind (falls back to three-of-a-kind + leftover)
// ═══════════════════════════════════════════════════════════════

test("Four 1s = 400 (three 1s = 300 + one 1 = 100)", () => {
  assert.equal(calculateScore([1, 1, 1, 1]), 400);
});

test("Four 3s = 300 (three 3s = 300, leftover 3 = 0)", () => {
  assert.equal(calculateScore([3, 3, 3, 3]), 300);
});

test("Four 5s = 550 (three 5s = 500 + one 5 = 50)", () => {
  assert.equal(calculateScore([5, 5, 5, 5]), 550);
});

test("Four 2s = 200 (three 2s = 200, leftover 2 = 0)", () => {
  assert.equal(calculateScore([2, 2, 2, 2]), 200);
});

test("Four 2s + one 5 = 250", () => {
  assert.equal(calculateScore([2, 2, 2, 2, 5]), 250);
});

// ═══════════════════════════════════════════════════════════════
// Five of a Kind (falls back to three-of-a-kind + individual)
// ═══════════════════════════════════════════════════════════════

test("Five 1s = 500 (three 1s = 300 + two 1s = 200)", () => {
  assert.equal(calculateScore([1, 1, 1, 1, 1]), 500);
});

test("Five 6s = 600 (three 6s = 600, leftover 6s = 0)", () => {
  assert.equal(calculateScore([6, 6, 6, 6, 6]), 600);
});

test("Five 2s + one 5 = 250", () => {
  assert.equal(calculateScore([2, 2, 2, 2, 2, 5]), 250);
});

test("Five 1s + one 5 = 550", () => {
  assert.equal(calculateScore([1, 1, 1, 1, 1, 5]), 550);
});

// ═══════════════════════════════════════════════════════════════
// Six of a Kind (falls back to two three-of-a-kinds)
// ═══════════════════════════════════════════════════════════════

test("Six 1s = 600 (two sets of three 1s = 300+300)", () => {
  assert.equal(calculateScore([1, 1, 1, 1, 1, 1]), 600);
});

test("Six 4s = 800 (two sets of three 4s = 400+400)", () => {
  assert.equal(calculateScore([4, 4, 4, 4, 4, 4]), 800);
});

test("Six 6s = 1200 (two sets of three 6s = 600+600)", () => {
  assert.equal(calculateScore([6, 6, 6, 6, 6, 6]), 1200);
});

// ═══════════════════════════════════════════════════════════════
// Straight (1-6) — no special combo, just 1 and 5 score
// ═══════════════════════════════════════════════════════════════

test("Straight 1-2-3-4-5-6 = 150 (one 1 = 100 + one 5 = 50)", () => {
  assert.equal(calculateScore([1, 2, 3, 4, 5, 6]), 150);
});

test("Straight in any order = 150", () => {
  assert.equal(calculateScore([6, 5, 4, 3, 2, 1]), 150);
  assert.equal(calculateScore([3, 1, 4, 6, 5, 2]), 150);
});

// ═══════════════════════════════════════════════════════════════
// Three Pairs — no special combo, just individual 1s/5s score
// ═══════════════════════════════════════════════════════════════

test("Three pairs (1,1,2,2,3,3) = 200 (two 1s)", () => {
  assert.equal(calculateScore([1, 1, 2, 2, 3, 3]), 200);
});

test("Three pairs (4,4,5,5,6,6) = 100 (two 5s)", () => {
  assert.equal(calculateScore([4, 4, 5, 5, 6, 6]), 100);
});

test("Three pairs (2,2,4,4,6,6) = 0 (no 1s or 5s → Farkle!)", () => {
  assert.equal(calculateScore([2, 2, 4, 4, 6, 6]), 0);
  assert.equal(isFarkle([2, 2, 4, 4, 6, 6]), true);
});



// ═══════════════════════════════════════════════════════════════
// Farkle Detection
// ═══════════════════════════════════════════════════════════════

test("Farkle: [2,3,4,6] — no scoring dice", () => {
  assert.equal(isFarkle([2, 3, 4, 6]), true);
});

test("Farkle: [2,2,3,3,4,4] — no 1s or 5s, not a three-of-a-kind", () => {
  // No 1s or 5s, no three of a kind → Farkle
  assert.equal(isFarkle([2, 2, 3, 3, 4, 4]), true);
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

test("Straight 1-6 is NOT hot dice (only 1 and 5 score)", () => {
  // Under printed rules: straight has no special combo. Only 1 (100) and 5 (50) score.
  // Only 2 of 6 dice score → NOT hot dice.
  assert.equal(isHotDice([1, 2, 3, 4, 5, 6]), false);
});

test("Hot dice: three 1s + three 5s = all 6 score", () => {
  assert.equal(isHotDice([1, 1, 1, 5, 5, 5]), true);
});

test("Hot dice: six 1s = all score (two triplets)", () => {
  assert.equal(isHotDice([1, 1, 1, 1, 1, 1]), true);
});

test("Not hot dice: only 5 dice score (one non-scoring)", () => {
  // [1,1,1,2,3] → three 1s = 300 (3 dice), 2 and 3 don't score → 3/5 scored
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

test("Two triplets (5,5,5,1,1,1) = 800 (three 5s + three 1s)", () => {
  // Greedy picks best three-of-a-kind first: three 5s = 500, remaining three 1s = 300 → 800
  assert.equal(calculateScore([5, 5, 5, 1, 1, 1]), 800);
});

test("Straight now just individual scoring", () => {
  // [1,2,3,4,5,6] = one 1 (100) + one 5 (50) = 150
  assert.equal(calculateScore([1, 2, 3, 4, 5, 6]), 150);
});

test("Three pairs (2,2,3,3,4,4) = 0 — no 1s or 5s", () => {
  // No 1s, no 5s, no three-of-a-kind → Farkle (0)
  assert.equal(calculateScore([2, 2, 3, 3, 4, 4]), 0);
});

test("Four-of-a-kind + pair — four 2s = 200", () => {
  // [2,2,2,2,3,3] → three 2s = 200, remaining [2,3,3] → 0 → 200
  assert.equal(calculateScore([2, 2, 2, 2, 3, 3]), 200);
});

test("Five-of-a-kind + single — five 1s + one 5 = 550", () => {
  // Three 1s = 300, remaining [1,1,5] → two 1s (200) + one 5 (50) = 550
  assert.equal(calculateScore([1, 1, 1, 1, 1, 5]), 550);
});

test("Six of a kind: six 3s = 600 (two triplets)", () => {
  // Three 3s = 300, remaining three 3s = 300 → 600
  assert.equal(calculateScore([3, 3, 3, 3, 3, 3]), 600);
});

// ═══════════════════════════════════════════════════════════════
// findScoringCombinations structure tests
// ═══════════════════════════════════════════════════════════════

test("findScoringCombinations returns correct structure", () => {
  const combos = findScoringCombinations([1, 1, 1, 5, 2]);
  assert.equal(combos.length, 2); // Three 1s + One 5
  assert.equal(combos[0].description, "Three 1's");
  assert.equal(combos[0].score, 300);
  assert.equal(combos[0].dice.length, 3);
  assert.equal(combos[1].description, "1 x Five");
  assert.equal(combos[1].score, 50);
});

test("findScoringCombinations for straight (no special combo)", () => {
  const combos = findScoringCombinations([1, 2, 3, 4, 5, 6]);
  assert.equal(combos.length, 2); // 1 x One + 1 x Five
  assert.equal(combos[0].description, "1 x One");
  assert.equal(combos[0].score, 100);
  assert.equal(combos[1].description, "1 x Five");
  assert.equal(combos[1].score, 50);
});

// ═══════════════════════════════════════════════════════════════
// Final Round Logic
// ═══════════════════════════════════════════════════════════════

const WINNING_SCORE = 10_000;

/**
 * Replicated checkFinalRoundTrigger — detects when a player hits 10k.
 * Must match game-engine/farkleEngine.ts exactly.
 */
function checkFinalRoundTrigger(state) {
  if (state.finalRound) return null;
  for (const player of state.players) {
    const score = state.scores[player.userId] ?? 0;
    if (score >= WINNING_SCORE) {
      return player.userId;
    }
  }
  return null;
}

/**
 * Replicated checkWinCondition — determines if the game should end.
 * Must match game-engine/farkleEngine.ts exactly.
 */
function checkWinCondition(state) {
  if (state.finalRound) {
    if (state.finalRoundStartedBy === state.currentTurn) {
      let bestId = "";
      let bestScore = -1;
      for (const [uid, score] of Object.entries(state.scores)) {
        if (score > bestScore) {
          bestScore = score;
          bestId = uid;
        }
      }
      return { ended: true, winnerId: bestId, scores: state.scores };
    }
    return { ended: false };
  }

  for (const player of state.players) {
    const score = state.scores[player.userId] ?? 0;
    if (score >= WINNING_SCORE) {
      return { ended: false };
    }
  }
  return { ended: false };
}

/** Helper to build a minimal game state for final round testing. */
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
    hasMetThreshold: opts.hasMetThreshold ?? false,
    rollsThisTurn: opts.rollsThisTurn ?? 0,
    scores: opts.scores ?? { A: 3500, B: 4200 },
    hasHotDice: false,
    finalRound: opts.finalRound ?? false,
    finalRoundStartedBy: opts.finalRoundStartedBy ?? null,
  };
}

// ─── checkFinalRoundTrigger ───

test("Final round trigger: no one at 10k → null", () => {
  const state = makeState({ scores: { A: 5000, B: 6000 } });
  assert.equal(checkFinalRoundTrigger(state), null);
});

test("Final round trigger: exactly 10k → triggers", () => {
  const state = makeState({ scores: { A: 10000, B: 6000 } });
  assert.equal(checkFinalRoundTrigger(state), "A");
});

test("Final round trigger: above 10k → triggers", () => {
  const state = makeState({ scores: { A: 8500, B: 11200 } });
  assert.equal(checkFinalRoundTrigger(state), "B");
});

test("Final round trigger: multiple at 10k → returns first found", () => {
  const state = makeState({ scores: { A: 10500, B: 10200 } });
  assert.equal(checkFinalRoundTrigger(state), "A");
});

test("Final round trigger: already in final round → null (even if someone at 10k)", () => {
  const state = makeState({
    scores: { A: 10500, B: 6000 },
    finalRound: true,
    finalRoundStartedBy: "A",
  });
  assert.equal(checkFinalRoundTrigger(state), null);
});

test("Final round trigger: zero scores → null", () => {
  const state = makeState({ scores: { A: 0, B: 0 } });
  assert.equal(checkFinalRoundTrigger(state), null);
});

// ─── checkWinCondition: Normal Play (not in final round) ───

test("Win condition: normal play, no one at 10k → game continues", () => {
  const state = makeState({ scores: { A: 5000, B: 6000 } });
  const result = checkWinCondition(state);
  assert.equal(result.ended, false);
});

test("Win condition: normal play, someone at 10k → still continues (API enters final round)", () => {
  const state = makeState({ scores: { A: 10000, B: 6000 } });
  const result = checkWinCondition(state);
  // Game does NOT end yet — the API layer detects this via checkFinalRoundTrigger
  // and enters final round mode instead.
  assert.equal(result.ended, false);
});

test("Win condition: normal play, both at 10k → still continues", () => {
  const state = makeState({ scores: { A: 10500, B: 11000 } });
  const result = checkWinCondition(state);
  assert.equal(result.ended, false);
});

// ─── checkWinCondition: Final Round Active ───

test("Win condition: final round, not back to trigger player → continues", () => {
  // A reached 10k, B's turn now
  const state = makeState({
    scores: { A: 10000, B: 6000 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "B",
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, false);
});

test("Win condition: final round, wrapped back to trigger player → game ends, trigger wins (if higher)", () => {
  // A reached 10k, B had their final turn and banked, turn wraps to A
  const state = makeState({
    scores: { A: 10500, B: 8000 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "A",
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "A");
  assert.deepEqual(result.scores, { A: 10500, B: 8000 });
});

test("Win condition: final round, opponent overtakes and wins", () => {
  // A reached 10k, B had final turn and scored higher, turn wraps to A
  const state = makeState({
    scores: { A: 10000, B: 11200 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "A",
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "B");
});

test("Win condition: final round, tied scores → first highest wins", () => {
  const state = makeState({
    scores: { A: 10000, B: 10000 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "A",
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  // A comes first in iteration, so A wins the tie
  assert.equal(result.winnerId, "A");
});

// ─── checkWinCondition: 3-Player Final Round ───

test("Win condition: 3 players, final round, middle player → continues", () => {
  const state = makeState({
    players: [
      { userId: "A", name: "Alice" },
      { userId: "B", name: "Bob" },
      { userId: "C", name: "Charlie" },
    ],
    scores: { A: 10500, B: 6000, C: 4000 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "B",
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, false);
});

test("Win condition: 3 players, final round, last opponent → continues", () => {
  // B played, now C's turn
  const state = makeState({
    players: [
      { userId: "A", name: "Alice" },
      { userId: "B", name: "Bob" },
      { userId: "C", name: "Charlie" },
    ],
    scores: { A: 10500, B: 8000, C: 4000 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "C",
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, false);
});

test("Win condition: 3 players, final round, wraps to trigger → ends, C overtakes", () => {
  const state = makeState({
    players: [
      { userId: "A", name: "Alice" },
      { userId: "B", name: "Bob" },
      { userId: "C", name: "Charlie" },
    ],
    scores: { A: 10000, B: 8200, C: 11300 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "A",
  });
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "C");
});

// ─── Final Round Edge Cases ───

test("Win condition: finished game state still reports ended", () => {
  const state = makeState({
    state: "finished",
    scores: { A: 12000, B: 8000 },
    finalRound: true,
    finalRoundStartedBy: "A",
    currentTurn: "A",
  });
  const result = checkWinCondition(state);
  // Even in finished state, if finalRound logic triggers, it would end again.
  // But in production, checkWinCondition is only called when state is "playing".
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "A");
});

test("Win condition: finalRoundStartedBy set but not in final round → ignores", () => {
  // Edge case: finalRoundStartedBy was set but finalRound flag is false (shouldn't happen but be robust)
  const state = makeState({
    scores: { A: 10000, B: 5000 },
    finalRound: false,
    finalRoundStartedBy: "A",
    currentTurn: "A",
  });
  const result = checkWinCondition(state);
  // Not in final round, someone at 10k → doesn't end (API handles final round entry)
  assert.equal(result.ended, false);
});

test("Full final round flow simulation: 2 players", () => {
  // Step 1: Normal play — both below 10k
  let state = makeState({ scores: { A: 9500, B: 8000 } });
  assert.equal(checkFinalRoundTrigger(state), null);
  assert.equal(checkWinCondition(state).ended, false);

  // Step 2: A banks, reaches 10,500 — API detects trigger, enters final round
  state = { ...state, scores: { ...state.scores, A: 10500 } };
  const trigger = checkFinalRoundTrigger(state);
  assert.equal(trigger, "A");
  // API sets finalRound = true, finalRoundStartedBy = "A", passes turn to B
  state.finalRound = true;
  state.finalRoundStartedBy = "A";
  state.currentTurn = "B";

  // Step 3: B's turn — still in final round, not ended
  assert.equal(checkWinCondition(state).ended, false);

  // Step 4: B banks, reaches 9,500 — turn passes to A
  state = {
    ...state,
    scores: { ...state.scores, B: 9500 },
    currentTurn: "A",
  };

  // Step 5: Wrapped back to A — game ends, A wins
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "A");
});

test("Full final round flow simulation: opponent overtakes", () => {
  // Step 1: Normal play
  let state = makeState({ scores: { A: 9800, B: 8500 } });

  // Step 2: A banks, reaches 10,200 — triggers final round
  state = { ...state, scores: { ...state.scores, A: 10200 } };
  const trigger = checkFinalRoundTrigger(state);
  assert.equal(trigger, "A");
  state.finalRound = true;
  state.finalRoundStartedBy = "A";
  state.currentTurn = "B";

  // Step 3: B's final turn — scores big, reaches 11,000
  state = {
    ...state,
    scores: { ...state.scores, B: 11000 },
    currentTurn: "A",
  };

  // Step 4: Wrapped to A — game ends, B wins
  const result = checkWinCondition(state);
  assert.equal(result.ended, true);
  assert.equal(result.winnerId, "B");
});
