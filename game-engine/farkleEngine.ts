// ─── Farkle Game Engine ───
// Rules matching cardgames.io/farkle:
// - Three 1s = 1000, other three-of-a-kind = face × 100
// - Four of a kind = 1000, Five of a kind = 2000, Six of a kind = 3000
// - Three pairs = 1500, Straight (1-6) = 2500
// - No minimum banking threshold
// - First player to reach 10,000 wins immediately (no final round)
// - Hot dice: when all 6 score, player MAY re-roll all 6

/** Configurable winning score constant. */
export const WINNING_SCORE = 10_000;

/** Number of dice in play. */
export const DICE_COUNT = 6;

/** Rake rate applied to the pot before payout (5% house edge). */
export const RAKE_RATE = 0.05;

// ─── Types ───

export type ScoringCombo = { dice: number[]; score: number; description: string };

export type FarkleGameState = {
  id: string;
  game: "farkle";
  players: FarklePlayer[];
  ai: boolean;
  wager: number;
  pot: number;
  state: "waiting" | "playing" | "finished";
  currentTurn: string;
  turnNumber: number;
  /** Current roll values (length may be less than 6 as dice get scored and removed). */
  dice: number[];
  /** Total score accumulated during the current turn (unbanked). */
  turnScore: number;
  /** How many rolls have been made this turn. */
  rollsThisTurn: number;
  /** Banked (permanent) scores for each player. */
  scores: Record<string, number>;
  /** Whether the current player has a "hot dice" re-roll (all 6 scored). */
  hasHotDice: boolean;
  /** AI difficulty for the AI player (if applicable). */
  difficulty?: "easy" | "medium" | "hard";
};

type FarklePlayer = {
  userId: string;
  name: string;
  isAI?: boolean;
  difficulty?: "easy" | "medium" | "hard";
};

// ─── Scoring Engine ───

/** Count occurrences of each die value. */
export function countDice(dice: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const d of dice) counts.set(d, (counts.get(d) ?? 0) + 1);
  return counts;
}

/** Base score for three of a kind: 1s = 1000, others = face × 100. */
function threeOfAKindScore(val: number): number {
  return val === 1 ? 1000 : val * 100;
}

/**
 * Check if dice form a straight (1-2-3-4-5-6).
 */
function isStraight(dice: number[]): boolean {
  if (dice.length !== 6) return false;
  const sorted = [...dice].sort((a, b) => a - b);
  return sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3 &&
         sorted[3] === 4 && sorted[4] === 5 && sorted[5] === 6;
}

/**
 * Check if dice form three pairs.
 */
function isThreePairs(dice: number[]): boolean {
  if (dice.length !== 6) return false;
  const counts = countDice(dice);
  // Three distinct values, each appearing exactly twice
  // Also handles four-of-a-kind + pair: counts.size === 2, one count=4 one count=2
  // Cardgames.io says "Includes a four-of-a-kind and a pair"
  if (counts.size === 3) {
    return [...counts.values()].every(c => c === 2);
  }
  if (counts.size === 2) {
    const vals = [...counts.values()];
    return (vals[0] === 4 && vals[1] === 2) || (vals[0] === 2 && vals[1] === 4);
  }
  return false;
}

/**
 * Check if a set of dice forms a valid scoring combination.
 * Valid combos: individual 1/5, three-of-a-kind, four-of-a-kind, five-of-a-kind,
 * six-of-a-kind, three pairs, straight.
 */
function isScoringSubset(dice: number[]): boolean {
  const n = dice.length;
  if (n === 0) return false;
  if (n === 1) return dice[0] === 1 || dice[0] === 5;
  if (n === 2) return false; // no 2-dice combos besides individual 1s and 5s (handled separately)
  if (n === 3) {
    // Three of a kind
    const counts = countDice(dice);
    return counts.size === 1;
  }
  if (n === 4) {
    // Four of a kind
    const counts = countDice(dice);
    return counts.size === 1;
  }
  if (n === 5) {
    // Five of a kind
    const counts = countDice(dice);
    return counts.size === 1;
  }
  if (n === 6) {
    // Six of a kind, three pairs, or straight
    if (isStraight(dice)) return true;
    if (isThreePairs(dice)) return true;
    const counts = countDice(dice);
    return counts.size === 1;
  }
  return false;
}

/**
 * Score a valid scoring subset.
 */
function scoreSubset(dice: number[]): number {
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

// Memoization cache for findBestScoring
const _bestScoreCache = new Map<string, { score: number; combos: ScoringCombo[] }>();

/**
 * Find the best scoring combination for a set of dice using exhaustive search.
 * The "combinations from a single roll" rule means we look for valid subsets
 * within this set of dice (all from the same roll), recursively finding the
 * optimal partition into valid scoring combos.
 *
 * Returns all scoring combos that produce the maximum total score.
 */
function findBestScoring(dice: number[]): { score: number; combos: ScoringCombo[] } {
  const key = [...dice].sort((a, b) => a - b).join(",");
  const cached = _bestScoreCache.get(key);
  if (cached) return cached;

  if (dice.length === 0) {
    return { score: 0, combos: [] };
  }

  let bestScore = 0;
  let bestCombos: ScoringCombo[] = [];

  // Generate all non-empty subsets of dice using bitmask
  // For n dice, there are 2^n - 1 non-empty subsets
  const n = dice.length;
  const totalMasks = 1 << n;

  for (let mask = 1; mask < totalMasks; mask++) {
    const subset: number[] = [];
    const remaining: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.push(dice[i]);
      } else {
        remaining.push(dice[i]);
      }
    }

    let subScore: number;
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
      const desc = describeCombo(subset);
      bestCombos = [{ dice: [...subset], score: subScore, description: desc }, ...restCombos];
    }
  }

  const result = { score: bestScore, combos: bestCombos };
  _bestScoreCache.set(key, result);
  return result;
}

/**
 * Generate a human-readable description of a scoring combo.
 */
function describeCombo(dice: number[]): string {
  const n = dice.length;
  if (n === 1) {
    return dice[0] === 1 ? "One" : "Five";
  }
  if (n === 2 && dice[0] === 1 && dice[1] === 1) return "Two Ones";
  if (n === 2 && dice[0] === 5 && dice[1] === 5) return "Two Fives";
  if (n === 2) return "One + Five";
  if (n === 3) return `Three ${dice[0]}'s`;
  if (n === 4) return `Four ${dice[0]}'s`;
  if (n === 5) return `Five ${dice[0]}'s`;
  if (n === 6) {
    if (isStraight(dice)) return "Straight (1-6)";
    if (isThreePairs(dice)) return "Three Pairs";
    return `Six ${dice[0]}'s`;
  }
  return "Combo";
}

/**
 * Clear the scoring cache (call before each new scoring evaluation
 * to avoid stale results across different calls).
 */
function clearScoringCache() {
  _bestScoreCache.clear();
}

/**
 * Find ALL valid scoring combinations in a set of dice.
 * Uses exhaustive search to find the optimal partition.
 */
export function findScoringCombinations(dice: number[]): ScoringCombo[] {
  clearScoringCache();
  const { combos } = findBestScoring(dice);
  return combos;
}

/**
 * Compute the total score for a given set of dice.
 * Returns 0 if no scoring combination exists (Farkle).
 */
export function calculateScore(dice: number[]): number {
  clearScoringCache();
  const { score } = findBestScoring(dice);
  return score;
}

/**
 * Check if a roll is a Farkle (no scoring dice at all).
 */
export function isFarkle(dice: number[]): boolean {
  return calculateScore(dice) === 0;
}

/**
 * Check if all dice scored (hot dice — player gets to roll all 6 again).
 */
export function isHotDice(dice: number[]): boolean {
  const combos = findScoringCombinations(dice);
  const totalScored = combos.reduce((sum, c) => sum + c.dice.length, 0);
  return totalScored === dice.length && dice.length === DICE_COUNT;
}

/**
 * Get indices of all dice that are part of a valid scoring combination.
 * Used for highlighting selectable dice in the UI.
 * Returns ALL dice that could potentially be scored (1s, 5s, and
 * dice that are part of multi-die combos like three-of-a-kind).
 */
export function getScoringIndices(dice: number[]): number[] {
  const combos = findScoringCombinations(dice);
  if (combos.length === 0) return [];

  const used = new Set<number>();
  const indices: number[] = [];

  // For each combo, find the matching dice in the original array
  for (const combo of combos) {
    const remaining = combo.dice.slice();
    for (let i = 0; i < dice.length; i++) {
      if (used.has(i)) continue;
      const idxInRemaining = remaining.indexOf(dice[i]);
      if (idxInRemaining !== -1) {
        remaining.splice(idxInRemaining, 1);
        used.add(i);
        indices.push(i);
      }
    }
  }

  return indices.sort((a, b) => a - b);
}

// ─── Dice Rolling ───

/** Roll the current set of dice (or all 6 for hot dice). */
export function rollDice(state: FarkleGameState): FarkleGameState {
  const count = state.hasHotDice ? DICE_COUNT : state.dice.length;
  if (count <= 0) throw new Error("No dice to roll");

  const dice = Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);

  return {
    ...state,
    dice,
    rollsThisTurn: state.rollsThisTurn + 1,
    hasHotDice: false,
  };
}

/**
 * After a roll, check if the player Farkled. If so, they lose their turn score
 * and turn passes to the next player.
 */
export function processRollResult(state: FarkleGameState): FarkleGameState {
  if (isFarkle(state.dice)) {
    // Farkle! Lose turn score and pass turn.
    const idx = state.players.findIndex(p => p.userId === state.currentTurn);
    const next = state.players[(idx + 1) % state.players.length];
    return {
      ...state,
      turnScore: 0,
      currentTurn: next.userId,
      turnNumber: state.turnNumber + 1,
      rollsThisTurn: 0,
      dice: Array.from({ length: DICE_COUNT }, () => Math.floor(Math.random() * 6) + 1),
      hasHotDice: false,
    };
  }

  // Not a Farkle — check for hot dice
  if (isHotDice(state.dice)) {
    return {
      ...state,
      hasHotDice: true,
    };
  }

  return state;
}

// ─── Turn Management ───

/**
 * Bank the current turn score. Adds to the player's permanent score,
 * then passes turn to the next player.
 * No minimum threshold — any positive score can be banked.
 */
export function bankScore(state: FarkleGameState): FarkleGameState {
  if (state.turnScore <= 0) {
    throw new Error("No points to bank");
  }

  const currentScore = state.scores[state.currentTurn] ?? 0;
  const newTotal = currentScore + state.turnScore;

  const idx = state.players.findIndex(p => p.userId === state.currentTurn);
  const next = state.players[(idx + 1) % state.players.length];

  return {
    ...state,
    scores: { ...state.scores, [state.currentTurn]: newTotal },
    turnScore: 0,
    currentTurn: next.userId,
    turnNumber: state.turnNumber + 1,
    rollsThisTurn: 0,
    dice: Array.from({ length: DICE_COUNT }, () => Math.floor(Math.random() * 6) + 1),
    hasHotDice: false,
  };
}

/**
 * Mark selected scoring dice, add their score to turnScore, and prepare
 * remaining dice for re-roll. If all dice are selected and scored, trigger hot dice.
 */
export function selectScoringDice(
  state: FarkleGameState,
  selectedIndices: number[],
): FarkleGameState {
  if (selectedIndices.length === 0) throw new Error("Must select at least one scoring die");

  const selectedDice = selectedIndices.map(i => state.dice[i]);
  const comboScore = calculateScore(selectedDice);

  if (comboScore <= 0) throw new Error("Selected dice are not a valid scoring combination");

  // Determine which dice remain
  const remaining = state.dice.filter((_, i) => !selectedIndices.includes(i));

  const newTurnScore = state.turnScore + comboScore;

  // If all dice were selected (hot dice scenario)
  if (remaining.length === 0) {
    // Auto-roll all 6 for hot dice (player can choose to bank instead in the API)
    return {
      ...state,
      turnScore: newTurnScore,
      dice: Array.from({ length: DICE_COUNT }, () => Math.floor(Math.random() * 6) + 1),
      hasHotDice: true,
      rollsThisTurn: state.rollsThisTurn + 1,
    };
  }

  return {
    ...state,
    turnScore: newTurnScore,
    dice: remaining,
    hasHotDice: false,
  };
}

// ─── Win Condition ───

/**
 * Check if any player has reached the winning score.
 * Per cardgames.io rules: first player to finish their turn with
 * more than 10,000 points banked wins immediately.
 */
export function checkWinCondition(state: FarkleGameState): {
  ended: boolean;
  winnerId?: string;
  scores?: Record<string, number>;
} {
  for (const player of state.players) {
    const score = state.scores[player.userId] ?? 0;
    if (score >= WINNING_SCORE) {
      return {
        ended: true,
        winnerId: player.userId,
        scores: state.scores,
      };
    }
  }
  return { ended: false };
}

// ─── Move Validation ───

export function validateMove(
  state: FarkleGameState,
  userId: string,
  action: "roll_dice" | "bank_score" | "select_scoring_dice" | "resign",
  payload?: any,
): void {
  if (state.state !== "playing") throw new Error("Game is not active");
  if (state.currentTurn !== userId) throw new Error("Not your turn");

  if (action === "roll_dice") {
    if (state.dice.length === 0) throw new Error("No dice to roll — bank your score first");
  }

  if (action === "bank_score") {
    if (state.turnScore <= 0) throw new Error("No points to bank");
  }

  if (action === "select_scoring_dice") {
    if (!payload?.indices || !Array.isArray(payload.indices) || payload.indices.length === 0) {
      throw new Error("Must select at least one die");
    }
    // Validate indices are within bounds
    for (const idx of payload.indices) {
      if (idx < 0 || idx >= state.dice.length) throw new Error("Invalid die index");
    }
  }
}

// ─── AI Strategy Engine ───

/**
 * AI decision-making engine for Farkle.
 * Evaluates risk vs reward and decides whether to roll again or bank.
 *
 * Strategy overview:
 *   - Easy: Conservative — banks early, rarely pushes luck
 *   - Medium: Balanced — pushes when ahead, banks when risky
 *   - Hard: Aggressive — pushes more often, only banks when close to winning or high risk
 *
 * Returns the action the AI should take, and any associated data.
 */
export function aiDecide(
  state: FarkleGameState,
): { action: "bank" } | { action: "roll" } | { action: "select"; indices: number[] } {
  const aiPlayer = state.players.find(p => p.isAI && p.userId === state.currentTurn);
  if (!aiPlayer) throw new Error("Not AI's turn");

  const difficulty = aiPlayer.difficulty ?? "medium";

  // Find all scoring combinations
  const combos = findScoringCombinations(state.dice);
  if (combos.length === 0) {
    // This shouldn't happen since processRollResult handles Farkles
    return { action: "bank" };
  }

  // Select the best scoring dice
  const indices = selectBestDice(state.dice, combos, difficulty);

  return { action: "select", indices };
}

/**
 * Choose which scoring dice to keep.
 */
function selectBestDice(
  allDice: number[],
  combos: ScoringCombo[],
  difficulty: "easy" | "medium" | "hard",
): number[] {
  const used = new Set<number>();
  const indices: number[] = [];

  // Map each combo's dice back to indices in the original array
  for (const combo of combos) {
    const remaining = combo.dice.slice();
    for (let i = 0; i < allDice.length; i++) {
      if (used.has(i)) continue;
      const idxInRemaining = remaining.indexOf(allDice[i]);
      if (idxInRemaining !== -1) {
        remaining.splice(idxInRemaining, 1);
        used.add(i);
        indices.push(i);
      }
    }
  }

  return indices.sort((a, b) => a - b);
}

/**
 * Decides whether the AI should bank or roll after selecting scoring dice.
 *
 * @param state - Current game state (after dice selection)
 * @returns true if AI should bank
 */
export function aiShouldBank(state: FarkleGameState): boolean {
  const aiPlayer = state.players.find(p => p.isAI && p.userId === state.currentTurn);
  if (!aiPlayer) return true;

  const difficulty = aiPlayer.difficulty ?? "medium";
  const currentScore = state.scores[state.currentTurn] ?? 0;
  const turnScore = state.turnScore;
  const remainingDice = state.dice.length;

  // Always bank if we can win
  if (currentScore + turnScore >= WINNING_SCORE) return true;

  // Always bank if no dice remaining (shouldn't happen, hot dice handled elsewhere)
  if (remainingDice <= 0) return true;

  // Calculate risk of Farkle with remaining dice
  const farkleRisk = Math.pow(4 / 6, remainingDice);

  // Thresholds by difficulty
  const riskThresholds = {
    easy: 0.3,
    medium: 0.5,
    hard: 0.65,
  };

  const threshold = riskThresholds[difficulty];

  // Bank if the risk of losing everything is too high
  if (farkleRisk > threshold) return true;

  // Easy AI also banks earlier at lower turn scores
  if (difficulty === "easy" && turnScore >= 400) return true;

  // Medium AI banks at moderate turn scores
  if (difficulty === "medium" && turnScore >= 800 && remainingDice <= 2) return true;

  // Hard AI banks only at high turn scores with few remaining dice
  if (difficulty === "hard" && turnScore >= 1200 && remainingDice <= 1) return true;

  // If we're way behind, take more risks
  const opponentScore = Math.max(
    ...state.players.filter(p => !p.isAI).map(p => state.scores[p.userId] ?? 0),
  );

  if (opponentScore > currentScore + turnScore + 500) {
    // Trailing significantly — take more risk
    return remainingDice <= 1 && farkleRisk > 0.7;
  }

  return false;
}

// ─── Initial State Helper ───

export function createInitialState(
  roomId: string,
  creatorId: string,
  creatorName: string,
  wager: number,
): FarkleGameState {
  return {
    id: roomId,
    game: "farkle",
    players: [{ userId: creatorId, name: creatorName }],
    ai: false,
    wager,
    pot: wager,
    state: "waiting",
    currentTurn: creatorId,
    turnNumber: 1,
    dice: Array.from({ length: DICE_COUNT }, () => Math.floor(Math.random() * 6) + 1),
    turnScore: 0,
    rollsThisTurn: 0,
    scores: { [creatorId]: 0 },
    hasHotDice: false,
  };
}
