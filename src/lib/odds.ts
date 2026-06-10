export type OddsRound = {
  max: number;
  starter: "player1" | "player2"; // who is the starter (attacker) in this attempt
  player1Number: number;
  player2Number: number;
  matched: boolean;
};

export type OddsGameState = {
  rounds: OddsRound[];
  totalRounds: number;
  winner: "player1" | "player2";
  result: "player1_won" | "player2_won";
  payout: number;
  firstStarter: "player1" | "player2";
};

// ── Interactive AI Game Types ──────────────────────────────────────────────
export type InteractiveOddsState = {
  currentMax: number;
  currentStarter: "player1" | "player2";
  phase: "first_attempt" | "reverse_attempt";
  rounds: OddsRound[];
  winner: "player1" | "player2" | null;
  firstStarter: "player1" | "player2";
  gameOver: boolean;
  /** Counts iterations at currentMax=2 to prevent infinite loops */
  lowRangeIterations?: number;
};

export type PickResult = {
  round: OddsRound;
  updatedState: InteractiveOddsState;
  playerNumber: number;
  aiNumber: number;
  matched: boolean;
  isReverse: boolean;
  halved: boolean;
};

// ── Interactive PvP Game Types ─────────────────────────────────────────────
export type PvPInteractiveOddsState = {
  currentMax: number;
  currentStarter: "player1" | "player2";
  phase: "first_attempt" | "reverse_attempt";
  rounds: OddsRound[];
  winner: "player1" | "player2" | null;
  firstStarter: "player1" | "player2";
  gameOver: boolean;
  // PvP-specific: pending picks for the current phase
  player1Pick: number | null;
  player2Pick: number | null;
  // Timestamp (ms) when the current round started — used for timeout detection
  roundStartedAt: number;
  /** Counts iterations at currentMax=2 to prevent infinite loops */
  lowRangeIterations?: number;
};

const MAX_ITERATIONS_AT_TWO = 100;

// ── Interactive AI Game Functions ───────────────────────────────────────────

/** Initialize a new interactive AI game state */
export function initInteractiveOddsGame(): InteractiveOddsState {
  const firstStarter: "player1" | "player2" = Math.random() < 0.5 ? "player1" : "player2";
  return {
    currentMax: 100,
    currentStarter: firstStarter,
    phase: "first_attempt",
    rounds: [],
    winner: null,
    firstStarter,
    gameOver: false,
  };
}

/**
 * Process a player's pick for the current round.
 * @param state Current game state
 * @param playerNumber The number the player picked (1–state.currentMax)
 * @returns pick result with updated state
 */
export function processOddsPick(
  state: InteractiveOddsState,
  playerNumber: number,
): PickResult {
  const iterations = (state.lowRangeIterations ?? 0) + 1;

  // Safety: if stuck at currentMax=2 for too many rounds, force a match to end the game
  const FORCE_MATCH_AFTER = 50;
  let aiNumber: number;
  let matched: boolean;
  if (state.currentMax === 2 && iterations >= FORCE_MATCH_AFTER) {
    // Force the AI to match the player's pick, ending the game immediately
    aiNumber = playerNumber;
    matched = true;
  } else {
    aiNumber = Math.floor(Math.random() * state.currentMax) + 1;
    matched = playerNumber === aiNumber;
  }

  const round: OddsRound = {
    max: state.currentMax,
    starter: state.currentStarter,
    player1Number: playerNumber,
    player2Number: aiNumber,
    matched,
  };

  const newRounds = [...state.rounds, round];
  let isReverse = false;
  let halved = false;

  if (matched) {
    // Challenger matches → starter wins
    return {
      round,
      updatedState: {
        ...state,
        rounds: newRounds,
        winner: state.currentStarter,
        gameOver: true,
        lowRangeIterations: iterations,
      },
      playerNumber,
      aiNumber,
      matched: true,
      isReverse: false,
      halved: false,
    };
  }

  if (state.phase === "first_attempt") {
    // No match on first attempt → reverse roles, keep same max
    const newStarter: "player1" | "player2" =
      state.currentStarter === "player1" ? "player2" : "player1";
    isReverse = true;
    return {
      round,
      updatedState: {
        ...state,
        rounds: newRounds,
        currentStarter: newStarter,
        phase: "reverse_attempt",
        lowRangeIterations: state.currentMax === 2 ? iterations : 0,
      },
      playerNumber,
      aiNumber,
      matched: false,
      isReverse: true,
      halved: false,
    };
  }

  // No match on reverse attempt → halve range, back to first_attempt
  let newMax = Math.floor(state.currentMax / 2);
  if (newMax < 2) newMax = 2;
  halved = true;

  return {
    round,
    updatedState: {
      ...state,
      rounds: newRounds,
      currentMax: newMax,
      phase: "first_attempt",
      // starter stays the same (the person who was starter in reverse attempt)
      lowRangeIterations: newMax === 2 ? iterations : 0,
    },
    playerNumber,
    aiNumber,
    matched: false,
    isReverse: false,
    halved: true,
  };
}

// ── Interactive PvP Game Functions ──────────────────────────────────────────

/** Initialize a new interactive PvP game state */
export function initPvPOddsGame(): PvPInteractiveOddsState {
  const firstStarter: "player1" | "player2" =
    Math.random() < 0.5 ? "player1" : "player2";
  return {
    currentMax: 100,
    currentStarter: firstStarter,
    phase: "first_attempt",
    rounds: [],
    winner: null,
    firstStarter,
    gameOver: false,
    player1Pick: null,
    player2Pick: null,
    roundStartedAt: Date.now(),
  };
}

/**
 * Process a PvP round when both players have picked.
 * Only call when state.player1Pick and state.player2Pick are both non-null.
 */
export function processPvPOddsRound(
  state: PvPInteractiveOddsState,
): PickResult {
  const iterations = (state.lowRangeIterations ?? 0) + 1;

  const player1Number = state.player1Pick!;
  const player2Number = state.player2Pick!;

  // Safety: if stuck at currentMax=2 for too many rounds, force a match
  const FORCE_MATCH_AFTER = 50;
  let matched: boolean;
  if (state.currentMax === 2 && iterations >= FORCE_MATCH_AFTER) {
    matched = true;
  } else {
    matched = player1Number === player2Number;
  }

  const round: OddsRound = {
    max: state.currentMax,
    starter: state.currentStarter,
    player1Number,
    player2Number,
    matched,
  };

  const baseState = {
    currentMax: state.currentMax,
    currentStarter: state.currentStarter,
    phase: state.phase,
    rounds: [...state.rounds, round],
    winner: state.winner,
    firstStarter: state.firstStarter,
    gameOver: state.gameOver,
    player1Pick: null as number | null,
    player2Pick: null as number | null,
    roundStartedAt: Date.now(),
  };

  if (matched) {
    // Numbers match → challenger loses, starter wins
    return {
      round,
      updatedState: {
        ...baseState,
        winner: state.currentStarter,
        gameOver: true,
        lowRangeIterations: iterations,
      },
      playerNumber: player1Number,
      aiNumber: player2Number,
      matched: true,
      isReverse: false,
      halved: false,
    };
  }

  if (state.phase === "first_attempt") {
    const newStarter: "player1" | "player2" =
      state.currentStarter === "player1" ? "player2" : "player1";
    return {
      round,
      updatedState: {
        ...baseState,
        currentStarter: newStarter,
        phase: "reverse_attempt",
        lowRangeIterations: state.currentMax === 2 ? iterations : 0,
      },
      playerNumber: player1Number,
      aiNumber: player2Number,
      matched: false,
      isReverse: true,
      halved: false,
    };
  }

  let newMax = Math.floor(state.currentMax / 2);
  if (newMax < 2) newMax = 2;

  return {
    round,
    updatedState: {
      ...baseState,
      currentMax: newMax,
      phase: "first_attempt",
      lowRangeIterations: newMax === 2 ? iterations : 0,
    },
    playerNumber: player1Number,
    aiNumber: player2Number,
    matched: false,
    isReverse: false,
    halved: true,
  };
  }

export function resolveOddsGame(wager: number): OddsGameState {
  const rounds: OddsRound[] = [];
  let max = 100;
  let winner: "player1" | "player2" | null = null;
  // Randomly choose who starts the game
  let starter: "player1" | "player2" = Math.random() < 0.5 ? "player1" : "player2";
  const firstStarter = starter;

  while (!winner) {
    // ── First attempt at this range ──
    const challenger: "player1" | "player2" = starter === "player1" ? "player2" : "player1";
    const p1a = Math.floor(Math.random() * max) + 1;
    const p2a = Math.floor(Math.random() * max) + 1;
    const matched1 = p1a === p2a;

    rounds.push({ max, starter, player1Number: p1a, player2Number: p2a, matched: matched1 });

    if (matched1) {
      // Challenger (receiver) loses, starter wins
      winner = starter;
      break;
    }

    // ── REVERSE: roles swap, same range ──
    starter = challenger;

    const newChallenger: "player1" | "player2" = starter === "player1" ? "player2" : "player1";
    const p1b = Math.floor(Math.random() * max) + 1;
    const p2b = Math.floor(Math.random() * max) + 1;
    const matched2 = p1b === p2b;

    rounds.push({ max, starter, player1Number: p1b, player2Number: p2b, matched: matched2 });

    if (matched2) {
      // New challenger loses, new starter wins
      winner = starter;
      break;
    }

    // ── Still no match after reverse: halve the range ──
    max = Math.floor(max / 2);
    if (max < 2) max = 2;

    // Safety cap at max=2
    if (max === 2 && rounds.length >= MAX_ITERATIONS_AT_TWO) {
      rounds.push({ max: 2, starter, player1Number: 1, player2Number: 1, matched: true });
      winner = starter;
    }
  }

  return {
    rounds,
    totalRounds: rounds.length,
    winner,
    result: winner === "player1" ? "player1_won" : "player2_won",
    payout: wager * 2,
    firstStarter,
  };
}
