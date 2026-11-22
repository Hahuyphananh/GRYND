// src/lib/solitaire-duel/puzzleSession.ts
//
// THE PUZZLE SESSION — the pure state machine behind the strategic player.
//
// A session owns exactly what the player can see and do:
//
//   * `state`  the authoritative position (server-side shape, never rendered);
//   * `view`   the SAME projection the duel uses, with `nextStockCard` nulled:
//              a puzzle must never expose a stock identity the player has not
//              legitimately turned over;
//   * `stats`  what the player has actually done (moves, reveals, draws, stock
//              passes/recycles, foundation gain, columns opened, the path).
//
// Every move is applied by `./rules.ts`, so the session cannot accept a move
// the game would refuse. The session never searches, never looks ahead, and
// never reports a hidden card: it answers one question — did that legal move
// advance the objective, leave it where it was, or complete it?
//
// The distinction matters for feedback. A legal move that does not advance the
// objective is NOT a mistake; the copy for it says exactly that. Only the
// objective predicate (`objectiveReached`) is allowed to declare completion.
//
// Browser-safe and server-safe: pure engine imports only, no I/O.

import { SUITS } from "./constants";
import { applyMove, viewForState } from "./rules";
import {
  objectiveReached,
  puzzleMoveSignature,
  type PuzzleConstraints,
  type PuzzleObjective,
} from "./puzzleValidation";
import { puzzleCardText } from "./puzzleFeedback";
import type { Card, SolitaireMove, SolitaireState, SolitaireView } from "./types";

// ── Progress toward an objective ──────────────────────────────────────────

export type PuzzleProgress = {
  /** How much of the objective is done, in the objective's own units. */
  current: number;
  /** What "done" is, in the same units. */
  target: number;
  /** False only for objectives with no meaningful partial state. */
  measurable: boolean;
};

function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a && b && a.suit === b.suit && a.rank === b.rank);
}

function foundationTotal(state: SolitaireState): number {
  return SUITS.reduce((total, suit) => total + (state.foundations?.[suit]?.length ?? 0), 0);
}

function faceDownCount(state: SolitaireState): number {
  let total = 0;
  for (const column of state.tableau ?? []) {
    for (const pile of column) if (!pile.faceUp) total += 1;
  }
  return total;
}

function emptyColumnCount(state: SolitaireState): number {
  return (state.tableau ?? []).filter((column) => column.length === 0).length;
}

/**
 * Partial completion of an objective, for the progress meter and for telling
 * "advanced the position" apart from "legal but neutral".
 *
 * `reveal-cards` is counted from the session's own reveal counter because the
 * objective is about the PATH, not the final layout; every other family is a
 * pure function of the final state, exactly as `objectiveReached` defines it.
 */
export function objectiveProgress(
  objective: PuzzleObjective,
  state: SolitaireState,
  stats?: { revealed?: number; signatures?: string[] } | null,
): PuzzleProgress {
  if (!objective || !state) return { current: 0, target: 1, measurable: false };

  switch (objective.kind) {
    case "reveal-cards": {
      const target = Math.max(1, objective.count);
      return { current: Math.min(stats?.revealed ?? 0, target), target, measurable: true };
    }
    case "open-column": {
      const empty =
        objective.column === undefined
          ? emptyColumnCount(state) > 0
          : (state.tableau?.[objective.column]?.length ?? 1) === 0;
      return { current: empty ? 1 : 0, target: 1, measurable: true };
    }
    case "place-card":
      return {
        current: objectiveReached(objective, state, stats) ? 1 : 0,
        target: 1,
        measurable: true,
      };
    case "foundation-milestone": {
      const target = Math.max(1, objective.total ?? objective.rank ?? 0);
      const current =
        objective.suit && objective.rank !== undefined
          ? state.foundations?.[objective.suit]?.length ?? 0
          : foundationTotal(state);
      return { current: Math.min(current, target), target, measurable: true };
    }
    case "preserve-card": {
      const kept = (state.tableau ?? []).some((column) =>
        column.some((pile) => pile.faceUp && sameCard(pile.card, objective.card)),
      );
      return { current: kept ? 1 : 0, target: 1, measurable: true };
    }
    case "reach-state": {
      const target = objective.target ?? {};
      const checks: boolean[] = [];
      if (target.foundations) {
        for (const suit of SUITS) {
          const wanted = target.foundations[suit];
          if (wanted !== undefined) {
            checks.push((state.foundations?.[suit]?.length ?? 0) === wanted);
          }
        }
      }
      if (target.faceDown !== undefined) checks.push(faceDownCount(state) === target.faceDown);
      if (target.emptyColumns !== undefined) {
        checks.push(emptyColumnCount(state) === target.emptyColumns);
      }
      if (target.stockCount !== undefined) checks.push((state.stock?.length ?? 0) === target.stockCount);
      if (target.wasteCount !== undefined) checks.push((state.waste?.length ?? 0) === target.wasteCount);
      const total = Math.max(1, checks.length);
      return { current: checks.filter(Boolean).length, target: total, measurable: true };
    }
    case "best-move":
      // A single best move has no partial state; the objective is the answer.
      return { current: 0, target: 1, measurable: false };
    case "all": {
      const parts = (objective.objectives ?? []).map((child) =>
        objectiveProgress(child, state, stats),
      );
      if (parts.length === 0) return { current: 0, target: 1, measurable: false };
      return {
        current: parts.reduce((total, part) => total + part.current, 0),
        target: parts.reduce((total, part) => total + part.target, 0),
        measurable: parts.every((part) => part.measurable),
      };
    }
    default:
      return { current: 0, target: 1, measurable: false };
  }
}

// ── The session ───────────────────────────────────────────────────────────

/**
 * The only parts of a puzzle a session needs.
 *
 * A full `PuzzleSpec` satisfies this shape, and so does the solution-free player
 * payload — which is what keeps the accepted answer paths out of the client.
 */
export type PuzzleSessionSpec = {
  id: string;
  version: number;
  objective: PuzzleObjective;
  startState: SolitaireState;
  constraints?: PuzzleConstraints;
};

export type PuzzleSessionStats = {
  moves: number;
  revealed: number;
  draws: number;
  /** Draws that emptied the stock (a completed pass). */
  stockPasses: number;
  /** Draws that recycled the waste back into the stock. */
  stockRecycles: number;
  foundationGain: number;
  columnsOpened: number;
  path: readonly SolitaireMove[];
};

export type PuzzleSession = {
  spec: PuzzleSessionSpec;
  state: SolitaireState;
  view: SolitaireView;
  stats: PuzzleSessionStats;
};

/**
 * The public board for a puzzle.
 *
 * `viewForState` exposes the next stock card so a duel can paint a draw without
 * a round trip. A puzzle must not: drawing is part of the plan, and the identity
 * of the next card is hidden information. Nulling it here is the projection, not
 * a redaction — the player simply does not receive it.
 */
export function puzzleViewFor(state: SolitaireState): SolitaireView {
  return { ...viewForState(state), nextStockCard: null };
}

export function createPuzzleSession(spec: PuzzleSessionSpec): PuzzleSession {
  const state = spec.startState;
  return {
    spec,
    state,
    view: puzzleViewFor(state),
    stats: {
      moves: 0,
      revealed: 0,
      draws: 0,
      stockPasses: 0,
      stockRecycles: 0,
      foundationGain: 0,
      columnsOpened: 0,
      path: [],
    },
  };
}

export function puzzleSessionProgress(session: PuzzleSession): PuzzleProgress {
  return objectiveProgress(session.spec.objective, session.state, {
    revealed: session.stats.revealed,
    signatures: session.stats.path.map(puzzleMoveSignature),
  });
}

export type PuzzleMoveStatus = "illegal" | "no-progress" | "progress" | "complete";

export type PuzzleMoveOutcome = {
  status: PuzzleMoveStatus;
  /** The next session; the SAME object when the move was illegal. */
  session: PuzzleSession;
  /** Cards this move legitimately turned face-up. */
  revealed: readonly Card[];
  progress: PuzzleProgress;
};

/**
 * Apply one proposed move.
 *
 * The board only proposes moves the shared validators accept, but the session
 * re-checks anyway: an illegal move is reported, never silently applied. A legal
 * move that changes nothing is `no-progress` — the UI says so without calling it
 * a mistake, because the objective may still be reachable from there.
 */
export function applyPuzzleMove(session: PuzzleSession, move: SolitaireMove): PuzzleMoveOutcome {
  const before = puzzleSessionProgress(session);
  const stockBefore = session.state.stock?.length ?? 0;
  const foundationsBefore = foundationTotal(session.state);
  const emptyBefore = emptyColumnCount(session.state);

  const applied = applyMove({ state: session.state, move });
  if (!applied.ok) {
    return { status: "illegal", session, revealed: [], progress: before };
  }

  const state = applied.state;
  const foundationGain = Math.max(0, foundationTotal(state) - foundationsBefore);
  const columnsOpened = (state.tableau ?? []).filter(
    (column, index) => column.length === 0 && (session.state.tableau[index]?.length ?? 0) > 0,
  ).length;
  const stockAfter = state.stock?.length ?? 0;

  const stats: PuzzleSessionStats = {
    moves: session.stats.moves + 1,
    revealed: session.stats.revealed + (applied.revealed?.length ?? 0),
    draws: session.stats.draws + (move.kind === "draw" ? 1 : 0),
    stockPasses:
      session.stats.stockPasses +
      (move.kind === "draw" && stockBefore === 1 && stockAfter === 0 ? 1 : 0),
    stockRecycles:
      session.stats.stockRecycles +
      (move.kind === "draw" && stockBefore === 0 && stockAfter > 0 ? 1 : 0),
    foundationGain: session.stats.foundationGain + foundationGain,
    columnsOpened: session.stats.columnsOpened + columnsOpened,
    path: [...session.stats.path, move],
  };

  const next: PuzzleSession = { spec: session.spec, state, view: puzzleViewFor(state), stats };
  const progress = puzzleSessionProgress(next);
  const complete = objectiveReached(session.spec.objective, state, {
    revealed: stats.revealed,
    signatures: stats.path.map(puzzleMoveSignature),
  });
  const advanced =
    progress.current > before.current ||
    (applied.revealed?.length ?? 0) > 0 ||
    foundationGain > 0 ||
    columnsOpened > 0;

  return {
    status: complete ? "complete" : advanced ? "progress" : "no-progress",
    session: next,
    revealed: applied.revealed ?? [],
    progress,
  };
}

/** Back to the declared starting position, with a fresh counter. */
export function restartPuzzleSession(session: PuzzleSession): PuzzleSession {
  return createPuzzleSession(session.spec);
}

// ── Localized objective lines ─────────────────────────────────────────────

/**
 * A rendered objective, as a translation key plus its parameters.
 *
 * `destination` is kept separate because it is its own localized phrase ("its
 * foundation" / "column 3"); the component resolves it first and passes the
 * result into the parent template. No English sentence is stored here.
 */
export type PuzzleObjectiveLine = {
  key: string;
  params?: Record<string, string | number>;
  destination?: { key: string; params?: Record<string, string | number> };
};

/** Flat list of objective sentences; composite objectives become two lines. */
export function puzzleObjectiveLines(objective: PuzzleObjective): PuzzleObjectiveLine[] {
  if (!objective) return [];

  switch (objective.kind) {
    case "reveal-cards":
      return [{ key: "puzzleLibrary.objectives.reveal", params: { count: objective.count } }];
    case "open-column":
      return objective.column === undefined
        ? [{ key: "puzzlePlayer.objectives.openAnyColumn" }]
        : [
            {
              key: "puzzleLibrary.objectives.openColumn",
              params: { column: objective.column + 1 },
            },
          ];
    case "place-card":
      return [
        {
          key: "puzzleLibrary.objectives.placeCard",
          params: { card: puzzleCardText(objective.card) },
          destination:
            objective.destination.kind === "foundation"
              ? { key: "puzzleLibrary.objectives.destinationFoundation" }
              : {
                  key: "puzzleLibrary.objectives.destinationColumn",
                  params: { column: objective.destination.column + 1 },
                },
        },
      ];
    case "foundation-milestone":
      return [
        {
          key: "puzzleLibrary.objectives.foundationMilestone",
          params: { total: objective.total ?? objective.rank ?? 0 },
        },
      ];
    case "preserve-card":
      return [
        {
          key: "puzzleLibrary.objectives.preserve",
          params: { card: puzzleCardText(objective.card) },
        },
      ];
    case "reach-state":
      return [{ key: "puzzleLibrary.objectives.reachState" }];
    case "best-move":
      return [{ key: "puzzleLibrary.objectives.bestMove" }];
    case "all":
      return (objective.objectives ?? []).flatMap((child) => puzzleObjectiveLines(child));
    default:
      return [];
  }
}
