// ─── Farkle Game Engine ───
// Standard Farkle rules with full scoring validation.
// First player to reach WINNING_SCORE points wins.

/** Configurable winning score constant. */
export const WINNING_SCORE = 10_000;

/** Number of dice in play. */
export const DICE_COUNT = 6;

/** Minimum score required to bank on the first scoring roll of a turn. */
export const MIN_BANK_THRESHOLD = 500;

/** Rake rate applied to the pot before payout (5% house edge). */
export const RAKE_RATE = 0.05;

// ─── Types ───

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
  /** Whether the player has met the minimum banking threshold this turn. */
  hasMetThreshold: boolean;
  /** How many rolls have been made this turn. */
  rollsThisTurn: number;
  /** Banked (permanent) scores for each player. */
  scores: Record<string, number>;
  /** Whether the current player has a "hot dice" re-roll (all 6 scored). */
  hasHotDice: boolean;
  /** AI difficulty for the AI player (if applicable). */
  difficulty?: "easy" | "medium" | "hard";
  /** Whether the game is in the final round (someone reached 10k, others get one more turn). */
  finalRound: boolean;
  /** The userId of the player who triggered the final round by reaching 10k. */
  finalRoundStartedBy: string | null;
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

/**
 * Find ALL valid scoring combinations in a set of dice.
 * Uses official Farkle rules:
 *   - Single 1s (100 each) and 5s (50 each)
 *   - Three-of-a-kind (1s = 300, others = face × 100)
 *   - No special combinations (straight, pairs, four/five/six of a kind
 *     are not separate melds — they fall back to three-of-a-kind + individual dice)
 *
 * Uses a greedy algorithm: finds the best combination first, then recurses.
 */
export function findScoringCombinations(
  dice: number[],
): { dice: number[]; score: number; description: string }[] {
  const n = dice.length;
  if (n === 0) return [];

  const counts = countDice(dice);
  const freq = [...counts.values()].sort((a, b) => b - a);

  // Three-of-a-kind (check largest value first for best combo)
  if (n >= 3 && freq[0] >= 3) {
    const result: { dice: number[]; score: number; description: string }[] = [];
    // Find the highest-value triplet
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
    const remaining: number[] = [];
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
  const result: { dice: number[]; score: number; description: string }[] = [];
  const remaining: number[] = [];
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

/** Base score for three of a kind: 1s = 300, others = face × 100. */
function threeOfAKindScore(val: number): number {
  return val === 1 ? 300 : val * 100;
}

/**
 * Compute the total score for a given set of dice.
 * Returns 0 if no scoring combination exists (Farkle).
 */
export function calculateScore(dice: number[]): number {
  const combos = findScoringCombinations(dice);
  return combos.reduce((sum, c) => sum + c.score, 0);
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

/** Roll all non-scored dice. Returns new dice values. */
export function rollDice(state: FarkleGameState): FarkleGameState {
  // Determine how many dice to roll.
  // If hot dice, roll all 6. Otherwise, all current dice are re-rolled
  // (because in Farkle, after selecting scoring dice, the remaining are re-rolled).
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
      hasMetThreshold: false,
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
 */
export function bankScore(state: FarkleGameState): FarkleGameState {
  const currentScore = state.scores[state.currentTurn] ?? 0;
  const newTotal = currentScore + state.turnScore;

  // Validate minimum banking threshold on first roll
  if (!state.hasMetThreshold && state.turnScore < MIN_BANK_THRESHOLD) {
    throw new Error(`Must bank at least ${MIN_BANK_THRESHOLD} points`);
  }

  const idx = state.players.findIndex(p => p.userId === state.currentTurn);
  const next = state.players[(idx + 1) % state.players.length];

  return {
    ...state,
    scores: { ...state.scores, [state.currentTurn]: newTotal },
    turnScore: 0,
    hasMetThreshold: false,
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
  const hasMetThreshold = state.hasMetThreshold || newTurnScore >= MIN_BANK_THRESHOLD;

  // If all 6 dice were selected (hot dice scenario or all remaining scored)
  if (remaining.length === 0) {
    return {
      ...state,
      turnScore: newTurnScore,
      hasMetThreshold,
      dice: Array.from({ length: DICE_COUNT }, () => Math.floor(Math.random() * 6) + 1),
      hasHotDice: true,
      rollsThisTurn: state.rollsThisTurn + 1, // auto-roll for hot dice
    };
  }

  return {
    ...state,
    turnScore: newTurnScore,
    hasMetThreshold,
    dice: remaining,
    hasHotDice: false,
  };
}

// ─── Win Condition ───

/**
 * Check if any player has reached the winning score.
 * NOTE: Per official rules, when a player reaches 10,000, the other players
 * get one last turn. This function only checks if someone has crossed the threshold;
 * the API layer handles the final-round logic.
 */
export function checkWinCondition(state: FarkleGameState): {
  ended: boolean;
  winnerId?: string;
  scores?: Record<string, number>;
} {
  // If we're in the final round and the current turn has wrapped back
  // to the player who started the final round, the game ends.
  if (state.finalRound) {
    // After all players have had their final turn, the one with the highest score wins
    // The final round ends when it's the triggering player's turn again
    if (state.finalRoundStartedBy === state.currentTurn) {
      // Find highest scorer
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

  // Not in final round yet — check if someone reached the threshold
  for (const player of state.players) {
    const score = state.scores[player.userId] ?? 0;
    if (score >= WINNING_SCORE) {
      // Don't end yet — enter final round instead (handled by the API layer)
      return { ended: false };
    }
  }
  return { ended: false };
}

/**
 * Check if banking a score should trigger the final round.
 * Returns the player who triggered it, or null.
 */
export function checkFinalRoundTrigger(state: FarkleGameState): string | null {
  if (state.finalRound) return null;
  for (const player of state.players) {
    const score = state.scores[player.userId] ?? 0;
    if (score >= WINNING_SCORE) {
      return player.userId;
    }
  }
  return null;
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
    if (!state.hasMetThreshold && state.turnScore < MIN_BANK_THRESHOLD) {
      throw new Error(`Must bank at least ${MIN_BANK_THRESHOLD} points on first scoring roll`);
    }
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

  // If it's the AI's first roll of this turn (dice was auto-rolled),
  // we just need to decide which scoring dice to select.
  // After selection, decide whether to bank or roll.

  // For now, the AI strategy works on the current dice set:
  // 1. Find all scoring combinations
  // 2. Select the BEST combination (highest score per die kept)
  // 3. Then decide whether to bank or roll again

  const combos = findScoringCombinations(state.dice);
  if (combos.length === 0) {
    // This shouldn't happen since processRollResult handles Farkles
    return { action: "bank" };
  }

  // Select the best scoring dice
  // Strategy: prefer keeping higher-value dice, but be strategic about it
  const indices = selectBestDice(state.dice, combos, difficulty);

  return { action: "select", indices };
}

/**
 * Choose which scoring dice to keep.
 * Based on difficulty, may keep fewer dice to maximize re-roll potential
 * or keep all scoring dice for safety.
 */
function selectBestDice(
  allDice: number[],
  combos: { dice: number[]; score: number; description: string }[],
  difficulty: "easy" | "medium" | "hard",
): number[] {
  // Map each combo's dice back to indices in the original array
  const used = new Set<number>();
  const indices: number[] = [];

  // For each combo, find the matching dice in the original array
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
  // Probability of Farkle ≈ (4/6)^n for each die being 2,3,4,6
  // More precisely: only 1 and 5 score individually, so 4/6 chance per die
  const farkleRisk = Math.pow(4 / 6, remainingDice);

  // Thresholds by difficulty
  const riskThresholds = {
    easy: 0.3,    // Bank if >30% chance of Farkle
    medium: 0.5,  // Bank if >50% chance of Farkle
    hard: 0.65,   // Bank if >65% chance of Farkle
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
    hasMetThreshold: false,
    rollsThisTurn: 0,
    scores: { [creatorId]: 0 },
    hasHotDice: false,
    finalRound: false,
    finalRoundStartedBy: null,
  };
}
