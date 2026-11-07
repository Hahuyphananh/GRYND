// standalone/solitaire-duel/src/match.ts
//
// The standalone match controller: ONE Klondike deal, TWO boards, NO server.
//
// This is the only part of the match lifecycle that had to be rewritten for a
// static build, and it is deliberately thin. Everything competitive still comes
// from the shared engine, so the standalone game and the GRYND game are the
// same game:
//
//   the deal              solvableDealFromSeed     (proven solvable, never laid out)
//   both starting boards  initialStateFromDeal     (two INDEPENDENT copies)
//   a player move         applyMove                (the server's own validator)
//   the bot               planAiMoves + aiMoveDelayMs (same heuristic, same pacing)
//   progress              progressOf / compareProgress
//   the winner            resolveRace over raceFromState
//   the dead-board rescue stateSolvableVerdict     (same "impossible" gate)
//
// There is NO second rules engine here and there must never be one: a move is
// legal exactly when `applyMove` says so.
//
// What is deliberately absent: no database, no auth, no `fetch`, no socket, no
// Elo/trophy/coin/trophy call, no persistence. `serverStore.ts` is not imported
// and must never be — it is the one module that would drag Postgres, Drizzle
// and the settlement stack into the bundle.
//
// Everything in this file is a pure function of (match, now, move): it never
// reads the clock itself unless the caller omits `nowMs`, and it never mutates
// the match it is handed.

import { coerceAiDifficulty, type AiDifficulty } from "../../../src/lib/aiDifficulty";
import {
  aiMoveDelayMs,
  legalMoves,
  planAiMoves,
  planAiSolution,
} from "../../../src/lib/solitaire-duel/ai";
import {
  MAX_MOVES_PER_SEAT,
  READY_COUNTDOWN_MS,
  SEAT,
} from "../../../src/lib/solitaire-duel/constants";
import {
  applyMove,
  compareProgress,
  failureOf,
  initialStateFromDeal,
  progressOf,
  raceFromState,
  resolveRace,
  viewForState,
} from "../../../src/lib/solitaire-duel/rules";
import {
  solvableDealFromSeed,
  solveDealLine,
  stateSolvableVerdict,
} from "../../../src/lib/solitaire-duel/solvable";
import type {
  SeatProgress,
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
  SolitaireView,
} from "../../../src/lib/solitaire-duel/types";
import { hashSeed } from "../../../src/lib/physics2d/deterministic";

/** Who won. The engine's own vocabulary, so the UI helpers accept it as-is. */
export type LocalResult = "player1" | "player2" | "draw";

/** How the match ended — the same three tokens the server writes. */
export type LocalResolution = "finish" | "forfeit" | "draw";

export type LocalMatch = {
  /** The seed this match was dealt from (kept for debugging and replays). */
  seed: number;
  difficulty: AiDifficulty;
  /** The one deal both seats race. */
  deal: SolitaireDeal;
  /** The human's own board. */
  player: SolitaireState;
  /** The bot's own board, from the same deal. */
  ai: SolitaireState;
  /** The instant the race starts. No move or AI step is allowed before it. */
  goAtMs: number;
  result: LocalResult | null;
  resolution: LocalResolution | null;
  /** When the result was reached (for the result screen's match time). */
  endedAtMs: number | null;
  /** Mid-match re-deals, per seat — the server keeps these too. */
  aiRedeals: number;
  playerRedeals: number;
};

// ──────────────────────────────────────────────────────────────────────────
// Creation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deal a fresh local match.
 *
 * The deal is the guarantee that matters: `solvableDealFromSeed` draws random
 * Klondike boards and keeps only one whose winning line a search proved, was
 * replayed through the engine, and which the naive foundation-only strategy
 * CANNOT solve. That search is bounded (measured ~40 ms typical, ~130 ms worst
 * case on a desktop), which is why this runs behind a "dealing" state on the
 * main thread rather than in a Worker.
 *
 * `initialStateFromDeal` is called TWICE on purpose: it builds new arrays for
 * every pile and the stock, so the two seats share the deal's contents but none
 * of its objects. That is the entire "same puzzle, separate boards" contract.
 */
export function createLocalMatch({
  difficulty,
  seed,
  nowMs = Date.now(),
  countdownMs = READY_COUNTDOWN_MS,
}: {
  difficulty?: unknown;
  seed: number;
  nowMs?: number;
  countdownMs?: number;
}): LocalMatch {
  const normalizedSeed = seed >>> 0;
  const tier = coerceAiDifficulty(difficulty);
  const deal = solvableDealFromSeed(normalizedSeed);

  return {
    seed: normalizedSeed,
    difficulty: tier,
    deal,
    player: initialStateFromDeal(deal),
    ai: initialStateFromDeal(deal),
    goAtMs: nowMs + Math.max(0, Math.trunc(countdownMs) || 0),
    result: null,
    resolution: null,
    endedAtMs: null,
    aiRedeals: 0,
    playerRedeals: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Reads the UI needs
// ──────────────────────────────────────────────────────────────────────────

/** The human's board, projected exactly as the server projects it. */
export function playerView(match: LocalMatch): SolitaireView {
  return viewForState(match.player);
}

export function playerProgress(match: LocalMatch): SeatProgress {
  return progressOf(match.player);
}

export function aiProgress(match: LocalMatch): SeatProgress {
  return progressOf(match.ai);
}

export function isOver(match: LocalMatch): boolean {
  return match.result !== null;
}

/** Milliseconds until GO, clamped at zero. */
export function countdownRemainingMs(match: LocalMatch, nowMs: number): number {
  return Math.max(0, match.goAtMs - nowMs);
}

// ──────────────────────────────────────────────────────────────────────────
// Resolution
// ──────────────────────────────────────────────────────────────────────────

/**
 * Decide the match from the two boards, using the server's own ladder.
 *
 * `resolveRace` gives the exact GRYND ordering: two forfeits are a draw, a
 * forfeit loses, a completion wins IMMEDIATELY, and two completions inside
 * 200 ms are a dead heat. It returns null while the race is still live, which
 * is why this can be called after every move and every AI step.
 */
export function settleMatch(match: LocalMatch, nowMs = Date.now()): LocalMatch {
  if (match.result) return match;
  const outcome = resolveRace({
    player1: raceFromState({ userId: SEAT.PLAYER1, seat: SEAT.PLAYER1, state: match.player }),
    player2: raceFromState({ userId: SEAT.PLAYER2, seat: SEAT.PLAYER2, state: match.ai }),
  });
  if (!outcome) return match;
  return {
    ...match,
    result: outcome.result,
    resolution: outcome.resolution,
    // Stamped once, by whoever ended the race; the clock is never re-read by a
    // later `settleMatch` call on a finished match.
    endedAtMs: match.endedAtMs ?? nowMs,
  };
}

/**
 * End a live race by progress — the human's "End match".
 *
 * The competitive metric is the engine's, never a local score: foundation
 * cards, then revealed tableau cards, then an exact tie is a draw. A player who
 * ends a race they are behind on loses it, which is why this records the same
 * `forfeit` resolution the server records for a concession.
 */
export function endMatchByProgress(match: LocalMatch, nowMs = Date.now()): LocalMatch {
  if (match.result) return match;
  const ahead = compareProgress(progressOf(match.player), progressOf(match.ai));
  const result: LocalResult = ahead > 0 ? SEAT.PLAYER1 : ahead < 0 ? SEAT.PLAYER2 : "draw";
  return {
    ...match,
    result,
    resolution: result === "draw" ? "draw" : "forfeit",
    endedAtMs: match.endedAtMs ?? nowMs,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Player moves
// ──────────────────────────────────────────────────────────────────────────

export type PlayerMoveResult = { match: LocalMatch; error: string | null };

/**
 * Apply one player move locally.
 *
 * The move is validated by `applyMove` — the same authority the API route calls
 * — so a move this accepts is a move GRYND would accept, and an illegal one
 * leaves the board untouched and comes back with the engine's own message.
 *
 * The completion instant is stamped HERE because the engine is deliberately
 * clock-free (`applyMove` sets `completed` but never a time), exactly as the
 * store does it on the server. That instant is what decides a photo finish.
 */
export function applyPlayerMove(
  match: LocalMatch,
  move: SolitaireMove,
  nowMs = Date.now(),
): PlayerMoveResult {
  if (match.result) return { match, error: "The match is already over" };
  if (nowMs < match.goAtMs) return { match, error: "Wait for the countdown" };

  const applied = applyMove({ state: match.player, move });
  const failure = failureOf(applied);
  if (failure) return { match, error: failure.error };

  let player = (applied as { state: SolitaireState }).state;
  if (player.completed && player.completedAtMs == null) {
    player = { ...player, completedAtMs: nowMs };
  }

  return { match: settleMatch({ ...match, player }, nowMs), error: null };
}

// ──────────────────────────────────────────────────────────────────────────
// The bot
// ──────────────────────────────────────────────────────────────────────────

/** A fresh board for one seat, from a new deal, without rewinding its ledger. */
function withFreshDeal(state: SolitaireState, deal: SolitaireDeal): SolitaireState {
  const fresh = initialStateFromDeal(deal);
  return {
    ...fresh,
    // The move cursor is the seat's ledger and is never rewound; the re-deal
    // count is what tells the UI the board beneath it was replaced.
    ply: state.ply,
    resetCount: (state.resetCount ?? 0) + 1,
    // Monotone: a re-deal must never lower a metric the settlement read.
    peakFoundation: state.peakFoundation ?? 0,
  };
}

/** The bot's replacement deal, derived from the match seed (deterministic). */
function botDeal(match: LocalMatch): SolitaireDeal {
  return solvableDealFromSeed(hashSeed(`${match.seed}:ai:${match.aiRedeals + 1}`));
}

/**
 * Advance the bot to `nowMs`.
 *
 * Solitaire Duel is SIMULTANEOUS, so the bot is paced by the clock, not by a
 * turn hand-off: at `nowMs` it has earned `floor((now - GO) / delay)` moves, and
 * this plays them until it has caught up. That is the store's exact rule (see
 * `advanceAiMatch` in serverStore.ts).
 *
 * WHAT IT PLAYS IS THE PROVEN LINE, not a per-move guess. The deal was served
 * only after a search found a winning line and the engine replayed it, so
 * following that line guarantees the bot finishes the puzzle; the tier decides
 * only WHEN, which is what makes Easy beatable instead of stuck. A board that is
 * off the line (an old match) falls back to the heuristic planner.
 *
 * The completion INSTANT is the simulated instant of the completing move
 * (`GO + ply × delay`), never the instant this tick happened to run — that is
 * what makes a photo finish decided by who actually solved the deal first.
 *
 * A stalled board (`stuck`: no legal move at all, or 72 moves that changed
 * nothing) is replaced with a fresh solvable deal for the BOT's seat only. The
 * player's board, the GO instant and both ledgers are untouched.
 */
export function advanceAi(match: LocalMatch, nowMs = Date.now()): LocalMatch {
  if (match.result) return match;
  if (nowMs < match.goAtMs) return match;
  if (match.ai.completed) return match;

  const delayMs = aiMoveDelayMs(match.difficulty);
  const allowedPly = Math.floor((nowMs - match.goAtMs) / delayMs);
  const maxMoves = Math.min(allowedPly - match.ai.ply, MAX_MOVES_PER_SEAT - match.ai.ply);
  if (maxMoves <= 0) return match;

  const startPly = match.ai.ply;
  const plan =
    planAiSolution({ state: match.ai, line: solveDealLine(match.deal), maxMoves }) ??
    planAiMoves({
      state: match.ai,
      difficulty: match.difficulty,
      maxMoves,
    });

  // `stuck` is the planner's "this board has nothing left to give", NOT the
  // mere absence of moves inside the time it was allowed.
  const stuck = !plan.completed && plan.stuck;
  if (plan.moves.length === 0 && !stuck) return match;

  let ai = plan.state;
  if (plan.completed && ai.completedAtMs == null) {
    ai = { ...ai, completedAtMs: match.goAtMs + (startPly + plan.moves.length) * delayMs };
  }

  let next: LocalMatch = { ...match, ai };
  if (stuck) {
    next = { ...next, ai: withFreshDeal(ai, botDeal(match)), aiRedeals: match.aiRedeals + 1 };
  }
  return settleMatch(next, nowMs);
}

/**
 * Re-deal the HUMAN's board when it can no longer be played — the server's
 * `seatPositionIsDead`, unchanged.
 *
 * Two gates, both required: the engine offers the seat no legal move at all,
 * and the complete search proves the position unwinnable. A board the player
 * can still act on is never taken away, and a search that ran out of budget
 * ("unknown") is never treated as a loss.
 *
 * The expensive verdict only runs when there is not a single legal move, so a
 * normal game never pays for it.
 */
export function redealPlayerIfDead(match: LocalMatch): LocalMatch {
  if (match.result || match.player.completed) return match;
  if (legalMoves(match.player).length > 0) return match;
  if (stateSolvableVerdict(match.player) !== "impossible") return match;

  const deal = solvableDealFromSeed(hashSeed(`${match.seed}:player:${match.playerRedeals + 1}`));
  return settleMatch({
    ...match,
    player: withFreshDeal(match.player, deal),
    playerRedeals: match.playerRedeals + 1,
  });
}

/** One clock tick: the bot moves, then a dead human board is rescued. */
export function tick(match: LocalMatch, nowMs = Date.now()): LocalMatch {
  return redealPlayerIfDead(advanceAi(match, nowMs));
}
