import { coerceAiDifficulty } from "./aiDifficulty";

// src/lib/odds.ts
//
// Pure game logic for the Odds PvP prediction game — no DB, no side
// effects, fully unit-testable. The API routes call these helpers to
// stay authoritative; the client imports the same types/helpers so its
// rendering and the server's scoring always agree.
//
// Game model (skill-based PvP prediction duel), two phases per round:
//   1. PICK YOUR NUMBER — both players independently lock in their own
//      hidden number in 1..currentMax ("Pick Your Number" modal). The
//      opponent's number is never sent to the other player.
//   2. PREDICT OPPONENT — once both numbers are locked in, each player
//      predicts the OPPONENT's number in 1..currentMax. Both
//      predictions stay hidden until both are submitted.
//   Then the round REVEALS both numbers, both predictions, and the
//   accuracy points each prediction earned from a FIXED band table
//   (identical every round — the shrinking range never changes it):
//      diff 0    → +100   diff 4–5  → +20
//      diff 1    → +80    diff 6–10 → +10
//      diff 2    → +60    diff >10  → +0
//      diff 3    → +40
//   The range only bounds what is a valid prediction (out-of-range
//   scores 0) and a prediction can never earn more than +100.
// The range follows a fixed shrinking schedule (pure halving, floored)
// — Round 1: 1–100, Round 2: 1–50, Round 3: 1–25, Round 4: 1–12,
// Round 5: 1–6, Round 6: 1–3. The shrinking range itself is the
// progression mechanic — scoring never scales with it. After
// TOTAL_ROUNDS (6) rounds the player with the higher cumulative score
// wins the pot; an exact tie is a DRAW (both stakes refunded).
//
// Every round is a simultaneous two-phase duel — both players lock in
// a hidden number, then both predict the opponent's — with no
// turn-taking, no roles, and no number-matching resolution.

export type OddsPhase = "pick" | "predict";

export type OddsRound = {
  // Range this round was played in.
  max: number;
  // Each player's OWN number (the value the opponent tried to predict).
  player1Number: number;
  player2Number: number;
  // Each player's PREDICTION of the opponent's number.
  player1Prediction: number;
  player2Prediction: number;
  // Accuracy points earned this round (closer prediction = more).
  player1Score: number;
  player2Score: number;
  // Display-only: who read the opponent better this round.
  roundWinner: "player1" | "player2" | "draw";
};

export type OddsGameState = {
  currentMax: number;
  // 1-based round currently being played (1..TOTAL_ROUNDS).
  currentRound: number;
  totalRounds: number;
  rounds: OddsRound[];
  // Cumulative accuracy scores.
  p1Score: number;
  p2Score: number;
  // Set once gameOver — null means the match ended in a DRAW (refund).
  winner: "player1" | "player2" | null;
  gameOver: boolean;
  // "pick" = waiting on both players' own numbers; "predict" = waiting
  // on both players' predictions of the opponent's number.
  phase: OddsPhase;
  // Pending submissions for the current round (null until submitted).
  player1Pick: number | null;
  player2Pick: number | null;
  player1Prediction: number | null;
  player2Prediction: number | null;
  // Timestamp (ms) when the current phase started — used for timeout
  // detection (a player who finishes their part then goes away gets
  // auto-forfeited once the other player submits).
  roundStartedAt: number;
};

// AI mode reuses the exact same shape — the player is always player1,
// the server-generated opponent is player2.
export type InteractiveOddsState = OddsGameState;
export type PvPInteractiveOddsState = OddsGameState;

export const INITIAL_MAX = 100;
// Smallest range in the fixed schedule (Round 6 plays in 1..3).
export const MIN_MAX = 3;
export const TOTAL_ROUNDS = 6;

// ── Init ──────────────────────────────────────────────────────────────

export function initPvPOddsGame(): PvPInteractiveOddsState {
  return {
    currentMax: INITIAL_MAX,
    currentRound: 1,
    totalRounds: TOTAL_ROUNDS,
    rounds: [],
    p1Score: 0,
    p2Score: 0,
    winner: null,
    gameOver: false,
    phase: "pick",
    player1Pick: null,
    player2Pick: null,
    player1Prediction: null,
    player2Prediction: null,
    roundStartedAt: Date.now(),
  };
}

export function initInteractiveOddsGame(): InteractiveOddsState {
  return initPvPOddsGame();
}

// ── Scoring ───────────────────────────────────────────────────────────

/**
 * Next range after a round resolves — pure halving floored at MIN_MAX
 * (100 → 50 → 25 → 12 → 6 → 3). The shrinking range is the progression
 * mechanic; it never affects scoring.
 */
export function nextMax(currentMax: number): number {
  const m = Number(currentMax);
  if (!Number.isFinite(m) || m < 1) return MIN_MAX;
  return Math.max(MIN_MAX, Math.floor(m / 2));
}

/**
 * Accuracy points for one prediction based on the absolute difference
 * between the prediction and the opponent's ACTUAL number within the
 * current range 1..max. Fixed bands, identical every round — `max` only
 * bounds what is a valid prediction, it never scales the points, and a
 * prediction can never earn more than +100.
 *   diff 0    → 100     diff 4–5  → 20
 *   diff 1    → 80      diff 6–10 → 10
 *   diff 2    → 60      diff >10  → 0
 *   diff 3    → 40
 * Out-of-range inputs (e.g. a prediction outside 1..max) score 0 — the
 * API routes already reject them; this is a defensive backstop. In small
 * ranges the band for the actual absolute difference still applies: a
 * diff of 1 in a 1..2 range earns +80, an exact hit still +100.
 */
export function scorePrediction(
  prediction: number,
  actual: number,
  max: number,
): number {
  const p = Number(prediction);
  const a = Number(actual);
  const m = Number(max);
  if (!Number.isFinite(p) || !Number.isFinite(a) || !Number.isFinite(m) || m < 1) {
    return 0;
  }
  // Impossible/out-of-range predictions are never rewarded.
  if (p < 1 || p > m || a < 1 || a > m) return 0;
  const d = Math.abs(p - a);
  let points: number;
  if (d === 0) points = 100;
  else if (d === 1) points = 80;
  else if (d === 2) points = 60;
  else if (d === 3) points = 40;
  else if (d <= 5) points = 20;
  else if (d <= 10) points = 10;
  else points = 0;
  // Hard invariant: never award more than +100 for a prediction.
  return Math.min(100, points);
}

/** Winner of the MATCH by cumulative score; null = exact tie (draw). */
export function decideMatchWinner(
  p1Score: number,
  p2Score: number,
): "player1" | "player2" | null {
  const s1 = Number(p1Score) || 0;
  const s2 = Number(p2Score) || 0;
  if (s1 > s2) return "player1";
  if (s2 > s1) return "player2";
  return null;
}

// ── Phase 1: pick your number ─────────────────────────────────────────
//
// Records one player's locked-in number. When BOTH numbers are in the
// round moves to the prediction phase (phaseComplete = true) and the
// phase clock restarts so both players get a fresh prediction timer.

export function submitPick(
  state: OddsGameState,
  player: "player1" | "player2",
  number: number,
): { updatedState: OddsGameState; phaseComplete: boolean } {
  const next: OddsGameState = {
    ...state,
    player1Pick: player === "player1" ? number : state.player1Pick,
    player2Pick: player === "player2" ? number : state.player2Pick,
  };

  const bothPicked = next.player1Pick !== null && next.player2Pick !== null;
  if (bothPicked) {
    return {
      updatedState: {
        ...next,
        phase: "predict",
        roundStartedAt: Date.now(),
      },
      phaseComplete: true,
    };
  }
  return { updatedState: next, phaseComplete: false };
}

// ── Phase 2: predict your opponent ────────────────────────────────────
//
// Records one player's prediction of the OPPONENT's number. The round
// only resolves (reveal) once BOTH predictions are in — the caller then
// runs resolvePvPRound on the returned state.

export function submitPrediction(
  state: OddsGameState,
  player: "player1" | "player2",
  prediction: number,
): { updatedState: OddsGameState; phaseComplete: boolean } {
  const next: OddsGameState = {
    ...state,
    player1Prediction: player === "player1" ? prediction : state.player1Prediction,
    player2Prediction: player === "player2" ? prediction : state.player2Prediction,
  };

  const bothPredicted =
    next.player1Prediction !== null && next.player2Prediction !== null;
  return { updatedState: next, phaseComplete: bothPredicted };
}

// ── Round resolution ──────────────────────────────────────────────────
//
// Call ONLY when all four submissions (both picks + both predictions)
// are present. Scores the round, appends it to history, accumulates
// scores, halves the range, and either opens the next round (phase back
// to "pick") or ends the match (gameOver with winner = null on an exact
// tie).

export function resolvePvPRound(
  state: PvPInteractiveOddsState,
): { round: OddsRound; updatedState: PvPInteractiveOddsState } {
  if (state.player1Pick === null || state.player2Pick === null) {
    throw new Error(
      "Both players must submit their number before the round can resolve",
    );
  }
  if (state.player1Prediction === null || state.player2Prediction === null) {
    throw new Error(
      "Both players must submit their prediction before the round can resolve",
    );
  }

  const max = state.currentMax;
  const p1RoundScore = scorePrediction(
    state.player1Prediction,
    state.player2Pick,
    max,
  );
  const p2RoundScore = scorePrediction(
    state.player2Prediction,
    state.player1Pick,
    max,
  );

  const round: OddsRound = {
    max,
    player1Number: state.player1Pick,
    player2Number: state.player2Pick,
    player1Prediction: state.player1Prediction,
    player2Prediction: state.player2Prediction,
    player1Score: p1RoundScore,
    player2Score: p2RoundScore,
    roundWinner:
      p1RoundScore > p2RoundScore
        ? "player1"
        : p2RoundScore > p1RoundScore
          ? "player2"
          : "draw",
  };

  const p1Score = state.p1Score + p1RoundScore;
  const p2Score = state.p2Score + p2RoundScore;
  const nextRound = state.currentRound + 1;
  const gameOver = nextRound > state.totalRounds;

  return {
    round,
    updatedState: {
      ...state,
      rounds: [...state.rounds, round],
      p1Score,
      p2Score,
      // Keep the last range for display when the match is over.
      currentMax: gameOver ? max : nextMax(max),
      currentRound: gameOver ? state.currentRound : nextRound,
      winner: gameOver ? decideMatchWinner(p1Score, p2Score) : null,
      gameOver,
      phase: "pick",
      player1Pick: null,
      player2Pick: null,
      player1Prediction: null,
      player2Prediction: null,
      roundStartedAt: Date.now(),
    },
  };
}

// ── AI resolution ─────────────────────────────────────────────────────
//
// AI mode: the player (always player1) submits their number, the server
// immediately locks in the AI's hidden number and moves to the predict
// phase; when the player submits their prediction the server generates
// the AI's prediction and resolves the round with the same rules as PvP.
// The AI's number is never exposed until the reveal.

export function submitAIPick(
  state: InteractiveOddsState,
  playerNumber: number,
  _difficulty?: unknown,
): { updatedState: InteractiveOddsState } {
  // The bot's own number stays uniform at every tier — random is already
  // the least predictable pick, so the tier only shapes its PREDICTION (see
  // `submitAIPrediction`).
  const aiNumber = Math.floor(Math.random() * state.currentMax) + 1;
  const updatedState: InteractiveOddsState = {
    ...state,
    player1Pick: playerNumber,
    player2Pick: aiNumber,
    phase: "predict",
    roundStartedAt: Date.now(),
  };
  return { updatedState };
}

export function submitAIPrediction(
  state: InteractiveOddsState,
  playerPrediction: number,
  difficulty?: unknown,
): { round: OddsRound; updatedState: InteractiveOddsState } {
  // The bot's prediction is scored against the human's locked-in number, and
  // it can see that number here. A hard bot reads it most of the time; the
  // other tiers guess at random, which is what makes them beatable.
  const tier = coerceAiDifficulty(difficulty);
  const readChance = tier === "hard" ? 0.7 : 0;
  const aiPrediction =
    state.player1Pick != null && Math.random() < readChance
      ? state.player1Pick
      : Math.floor(Math.random() * state.currentMax) + 1;
  const withAi: InteractiveOddsState = {
    ...state,
    player1Prediction: playerPrediction,
    player2Prediction: aiPrediction,
  };
  const { round, updatedState } = resolvePvPRound(withAi);
  return { round, updatedState };
}

// ── Per-player view ───────────────────────────────────────────────────
//
// The full gameState jsonb holds BOTH players' numbers/predictions while
// a round is in progress. A player must never receive the OPPONENT's
// current-round submissions (that would let them copy the number they
// have to predict). Sanitize the state before sending it to any client:
// each player sees only their own submissions plus two booleans telling
// the UI whether the opponent has completed the current phase.

export type OddsPlayerView = OddsGameState & {
  opponentPicked: boolean;
  opponentPredicted: boolean;
};

export function viewForPlayer(
  state: OddsGameState,
  isPlayer1: boolean,
): OddsPlayerView {
  // Once the match is over everything is public (the rounds history
  // already carries every revealed round, and the current-round fields
  // are reset to null by resolvePvPRound anyway).
  const reveal = state.gameOver;
  return {
    ...state,
    player1Pick: reveal || isPlayer1 ? state.player1Pick : null,
    player2Pick: reveal || !isPlayer1 ? state.player2Pick : null,
    player1Prediction: reveal || isPlayer1 ? state.player1Prediction : null,
    player2Prediction: reveal || !isPlayer1 ? state.player2Prediction : null,
    opponentPicked: isPlayer1
      ? state.player2Pick !== null
      : state.player1Pick !== null,
    opponentPredicted: isPlayer1
      ? state.player2Prediction !== null
      : state.player1Prediction !== null,
  };
}
