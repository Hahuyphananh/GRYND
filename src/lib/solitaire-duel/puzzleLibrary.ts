// src/lib/solitaire-duel/puzzleLibrary.ts
//
// THE STRATEGIC PUZZLE LIBRARY.
//
// The library is a CURATED, DATA-DRIVEN set of positions (see
// `puzzleLibraryData.ts`) rebuilt into validated `PuzzleSpec`s here. It exists
// to replace "one best move" practice with puzzles that ask for a short plan:
// reveal two buried cards, free a column while revealing, coordinate an
// endgame, or cycle the stock deliberately.
//
// WHAT MAKES AN ENTRY ACCEPTABLE (enforced when the data was selected, and
// re-checked here on every build):
//
//   * two or more moves, so there is a decision and a dependence between moves;
//   * the objective is not already true at the start, nor after all but the
//     final move — otherwise the puzzle is "make the obvious move";
//   * real alternatives exist: at least one productive distractor, and often a
//     greedier move that must be delayed;
//   * measurable progress (a reveal, a foundation gain, or a freed column);
//   * the whole path replays through `./rules.ts`, checked by the Phase 2
//     validator;
//   * no hidden card is named in an objective or hint.
//
// EVERY puzzle is validated by `./puzzleValidation.ts` before it is returned.
// An entry that fails is EXCLUDED and reported, never silently dropped.
//
// MULTIPLE SOLUTIONS: because the objectives here are state/path predicates,
// not "the one best move", a bounded breadth-first search looks for other
// legal lines that reach the same objective and adds them to the spec. The
// search is depth-capped at the curated solution's length and node-capped, so
// it can never become unbounded work. The search is a courtesy, not a proof:
// `verification.kind` stays `verified-set`, and the library never claims a
// solution is unique.
//
// HIDDEN INFORMATION: the library only ever names a card that is face-up in
// the starting position, and the public projection nulls `nextStockCard`. The
// encoded start states are authoring data and must stay server-side.
//
// LOCALIZATION: definitions store translation KEYS plus parameters (a visible
// card, a column, a count). No component needs English, and every key is
// present in English, French and Spanish (see puzzleLibraryTranslations.js).
//
// Browser-safe and server-safe: pure engine imports only, no I/O at import.

import { legalMoves, scoreMove } from "./ai";
import { SUITS, VARIANT, VARIANT_VERSION } from "./constants";
import { applyMove } from "./rules";
import type { Card, SolitaireMove, SolitaireState, Suit } from "./types";
import { puzzleCardText } from "./puzzleFeedback";
import { PUZZLE_LIBRARY_DATA } from "./puzzleLibraryData";
import {
  PUZZLE_CALIBRATION_MIN_ATTEMPTS,
  PUZZLE_DIFFICULTY_CALIBRATION,
  calibratedBandFor,
  type PuzzleCalibrationEntry,
  type PuzzleCalibrationSnapshot,
} from "./puzzleCalibration";
import {
  PUZZLE_LIBRARY_CATEGORIES,
  PUZZLE_LIBRARY_LEVELS,
  levelForBand,
  type PuzzleLibraryCategory,
  type PuzzleLibraryLevelId,
} from "./puzzleVocabulary";
import { PUZZLE_LIBRARY_TRANSLATIONS } from "../puzzleLibraryTranslations";
import {
  PUZZLE_LIMITS,
  PUZZLE_SPEC_VERSION,
  objectiveReached,
  puzzleMoveSignature,
  validatePuzzle,
  validatePuzzleSpec,
  type PuzzleCategory,
  type PuzzleHint,
  type PuzzleObjective,
  type PuzzleSpec,
  type PuzzleValidationResult,
} from "./puzzleValidation";

// ── Vocabulary ────────────────────────────────────────────────────────────

// The category/level vocabulary lives in a data-free module so a client can
// import it without pulling `puzzleLibraryData` (which contains solutions).
export {
  PUZZLE_LIBRARY_CATEGORIES,
  PUZZLE_LIBRARY_LEVELS,
  levelForBand,
  type PuzzleLibraryCategory,
  type PuzzleLibraryLevelId,
} from "./puzzleVocabulary";

// ── Encoded start positions ───────────────────────────────────────────────

const SUIT_BY_LETTER: Record<string, Suit> = {
  s: "spades",
  h: "hearts",
  d: "diamonds",
  c: "clubs",
};
const LETTER_BY_SUIT: Record<Suit, string> = {
  spades: "s",
  hearts: "h",
  diamonds: "d",
  clubs: "c",
};

function decodePileToken(token: string): { card: Card; faceUp: boolean } {
  const faceUp = !token.startsWith("~");
  const raw = faceUp ? token : token.slice(1);
  const suit = SUIT_BY_LETTER[raw[0]];
  const rank = Number(raw.slice(1));
  if (!suit || !Number.isInteger(rank) || rank < 1 || rank > 13) {
    throw new Error(`Malformed card token "${token}" in the puzzle library`);
  }
  return { card: { suit, rank: rank as Card["rank"] }, faceUp };
}

/**
 * Decode one library start position.
 *
 * Format: `tableau|stock|waste|foundations|ply`
 *   * tableau columns are `/`-separated, positions `,`-separated, bottom→top;
 *   * a `~` prefix marks a face-down position (identity kept — this is
 *     authoring data, never a client payload);
 *   * stock and waste are `,`-separated card lists (stock bottom→top);
 *   * foundations are four ascending counts in spades, hearts, diamonds, clubs
 *     order, so the pile identities are implied by the counts;
 *   * `ply` is the starting move counter.
 */
export function decodePuzzleStart(encoded: string): SolitaireState {
  const parts = String(encoded ?? "").split("|");
  if (parts.length !== 5) throw new Error("A library start position needs five fields");

  const [tableauPart, stockPart, wastePart, foundationsPart, plyPart] = parts;
  const tableau = tableauPart.split("/").map((column) =>
    column.length === 0 ? [] : column.split(",").map((token) => decodePileToken(token)),
  );
  if (tableau.length !== 7) throw new Error("A library start position needs seven columns");

  const stock = stockPart.length === 0 ? [] : stockPart.split(",").map((token) => decodePileToken(token).card);
  const waste = wastePart.length === 0 ? [] : wastePart.split(",").map((token) => decodePileToken(token).card);

  const counts = foundationsPart.split(",").map((value) => Number(value));
  if (counts.length !== SUITS.length || counts.some((count) => !Number.isInteger(count) || count < 0 || count > 13)) {
    throw new Error("A library start position has invalid foundation counts");
  }
  const foundations = {
    spades: [] as Card[],
    hearts: [] as Card[],
    diamonds: [] as Card[],
    clubs: [] as Card[],
  };
  SUITS.forEach((suit, index) => {
    for (let rank = 1; rank <= counts[index]; rank += 1) {
      foundations[suit].push({ suit, rank: rank as Card["rank"] });
    }
  });

  const ply = Number(plyPart);
  const foundationCards = counts.reduce((total, count) => total + count, 0);

  return {
    variant: VARIANT,
    variantVersion: VARIANT_VERSION,
    tableau,
    stock,
    waste,
    foundations,
    ply: Number.isInteger(ply) && ply >= 0 ? ply : 0,
    resetCount: 0,
    peakFoundation: foundationCards,
    completed: false,
    completedAtMs: null,
  };
}

/** The inverse of `decodePuzzleStart` — used by tests and the authoring pass. */
export function encodePuzzleStart(state: SolitaireState): string {
  const encodeCard = (card: Card) => `${LETTER_BY_SUIT[card.suit]}${card.rank}`;
  const tableau = state.tableau
    .map((column) =>
      column
        .map((pile) => (pile.card ? `${pile.faceUp ? "" : "~"}${encodeCard(pile.card)}` : "?"))
        .join(","),
    )
    .join("/");
  return [
    tableau,
    state.stock.map(encodeCard).join(","),
    state.waste.map(encodeCard).join(","),
    SUITS.map((suit) => state.foundations[suit]?.length ?? 0).join(","),
    state.ply,
  ].join("|");
}

// ── Strategic load and difficulty ─────────────────────────────────────────

/**
 * Difficulty thresholds over the strategic score.
 *
 * The score is deliberately dominated by DECISIONS (branching, productive
 * alternatives, a delayed greedy move) and only lightly by length: a four-move
 * line of obvious foundation moves stays near the bottom, and a two-move line
 * that requires delaying the greedy move rises. This is a structural
 * heuristic, not a measured pass rate — the library does not claim calibration.
 */
export const PUZZLE_LIBRARY_BANDS = Object.freeze({
  beginnerMax: 30,
  intermediateMax: 48,
  advancedMax: 64,
  expertMax: 80,
});

export function difficultyBandForScore(score: number): number {
  if (score <= PUZZLE_LIBRARY_BANDS.beginnerMax) return 1;
  if (score <= PUZZLE_LIBRARY_BANDS.intermediateMax) return 2;
  if (score <= PUZZLE_LIBRARY_BANDS.advancedMax) return 3;
  if (score <= PUZZLE_LIBRARY_BANDS.expertMax) return 4;
  return 5;
}

export type StrategicLoad = {
  moves: number;
  branching: number;
  productiveMoves: number;
  /** Productive first moves other than the solution's first move. */
  distractors: number;
  /** True when the greediest legal move is NOT the solution's first move. */
  delaysGreedyMove: boolean;
  reveals: number;
  foundationGain: number;
  columnsOpened: number;
  /** The columns the solution actually emptied, 0-based. */
  openedColumns: number[];
  /** Completed passes: a draw that moved the last stock card onto the waste. */
  stockPasses: number;
  /** Draws that RECYCLED the waste back into the stock (a pass boundary). */
  stockRecycles: number;
  hiddenCards: number;
  foundationCards: number;
  score: number;
  band: number;
  /** Recorded-human override applied to this position, or null. */
  calibration: PuzzleCalibrationEntry | null;
  level: (typeof PUZZLE_LIBRARY_LEVELS)[number];
};

function faceDownCount(state: SolitaireState): number {
  let total = 0;
  for (const column of state.tableau) for (const pile of column) if (!pile.faceUp) total += 1;
  return total;
}

function foundationTotal(state: SolitaireState): number {
  return SUITS.reduce((total, suit) => total + (state.foundations[suit]?.length ?? 0), 0);
}

function emptyColumnCount(state: SolitaireState): number {
  return state.tableau.filter((column) => column.length === 0).length;
}

/**
 * Measure how much strategy one position asks for.
 *
 * Uses the engine's own legal-move enumeration and the Perfect bot's move score
 * (the same objective the puzzle builder uses), then replays the curated
 * solution to count reveals, foundation gains, freed columns and stock passes.
 */
export function assessStrategicLoad(
  spec: PuzzleSpec,
  category: PuzzleLibraryCategory,
  calibration: PuzzleCalibrationSnapshot = PUZZLE_DIFFICULTY_CALIBRATION,
): StrategicLoad {
  const state = spec.startState;
  const unique = new Map<string, SolitaireMove>();
  for (const move of legalMoves(state)) {
    const signature = puzzleMoveSignature(move);
    if (!unique.has(signature)) unique.set(signature, move);
  }
  const moves = [...unique.values()];
  const scored = moves
    .map((move) => ({ move, score: scoreMove(state, move) }))
    .sort((a, b) => b.score - a.score);
  const productiveMoves = scored.filter((entry) => entry.score > 0).length;

  const primary = spec.solutions[0] ?? [];
  const firstSignature = primary[0] ? puzzleMoveSignature(primary[0]) : "";
  const greedySignature = scored[0] ? puzzleMoveSignature(scored[0].move) : "";
  const distractors = scored.filter(
    (entry) => entry.score > 0 && puzzleMoveSignature(entry.move) !== firstSignature,
  ).length;

  let cursor = state;
  let reveals = 0;
  let foundationGain = 0;
  let columnsOpened = 0;
  const openedColumns: number[] = [];
  let stockPasses = 0;
  let stockRecycles = 0;
  for (const move of primary) {
    const stockBefore = cursor.stock.length;
    const foundationsBefore = foundationTotal(cursor);
    const emptyBefore = emptyColumnCount(cursor);
    const wasEmpty = cursor.tableau.map((column) => column.length === 0);
    const applied = applyMove({ state: cursor, move });
    if (!applied.ok) break;
    cursor = applied.state;
    reveals += applied.revealed?.length ?? 0;
    foundationGain += Math.max(0, foundationTotal(cursor) - foundationsBefore);
    columnsOpened += Math.max(0, emptyColumnCount(cursor) - emptyBefore);
    cursor.tableau.forEach((column, index) => {
      if (!wasEmpty[index] && column.length === 0) openedColumns.push(index);
    });
    if (move.kind === "draw" && stockBefore === 1 && cursor.stock.length === 0) stockPasses += 1;
    if (move.kind === "draw" && stockBefore === 0 && cursor.stock.length > 0) stockRecycles += 1;
  }

  const score = Math.round(
    Math.min(primary.length, 5) * 6 +
      Math.min(moves.length, 10) * 2 +
      Math.min(distractors, 6) * 4 +
      (greedySignature !== firstSignature ? 12 : 0) +
      (category === "endgame" ? 8 : 0) +
      (reveals >= 2 ? 6 : 0) +
      (columnsOpened > 0 ? 4 : 0),
  );
  const structuralBand = difficultyBandForScore(score);
  // Calibration can only correct a LEARNING tier, and only with a sample that
  // meets the minimum. A stale or malformed entry is ignored, so the structural
  // rating is always the safe fallback.
  const applied =
    (structuralBand === 1 || structuralBand === 2) &&
    calibration[spec.id] &&
    calibration[spec.id].attempts >= PUZZLE_CALIBRATION_MIN_ATTEMPTS
      ? calibration[spec.id]
      : null;
  const band = calibratedBandFor(spec.id, structuralBand, calibration);

  return {
    moves: primary.length,
    branching: moves.length,
    productiveMoves,
    distractors,
    delaysGreedyMove: greedySignature !== firstSignature,
    reveals,
    foundationGain,
    columnsOpened,
    openedColumns,
    stockPasses,
    stockRecycles,
    hiddenCards: faceDownCount(state),
    foundationCards: foundationTotal(state),
    score,
    band,
    calibration: applied,
    level: levelForBand(band),
  };
}

// ── Copy ──────────────────────────────────────────────────────────────────

const EN = PUZZLE_LIBRARY_TRANSLATIONS.en;

function format(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

function cardText(card: Card): string {
  return puzzleCardText(card);
}

/** A card is fair to name only when it is face-up in the starting position. */
function isVisibleCard(state: SolitaireState, card: Card): boolean {
  const same = (other: Card | null | undefined) =>
    Boolean(other && other.suit === card.suit && other.rank === card.rank);
  for (const column of state.tableau) {
    for (const pile of column) if (pile.faceUp && same(pile.card)) return true;
  }
  if (state.waste.some(same)) return true;
  for (const suit of SUITS) if (state.foundations[suit].some(same)) return true;
  return false;
}

function destinationText(objective: Extract<PuzzleObjective, { kind: "place-card" }>): string {
  return objective.destination.kind === "foundation"
    ? EN.objectives.destinationFoundation
    : format(EN.objectives.destinationColumn, { column: objective.destination.column + 1 });
}

/** The player-facing objective sentence (English source for the spec field). */
export function objectiveTextFor(objective: PuzzleObjective): string {
  switch (objective.kind) {
    case "reveal-cards":
      return format(EN.objectives.reveal, { count: objective.count });
    case "open-column":
      return format(EN.objectives.openColumn, { column: (objective.column ?? 0) + 1 });
    case "place-card":
      return format(EN.objectives.placeCard, {
        card: cardText(objective.card),
        destination: destinationText(objective),
      });
    case "foundation-milestone":
      return format(EN.objectives.foundationMilestone, { total: objective.total ?? objective.rank ?? 0 });
    case "preserve-card":
      return format(EN.objectives.preserve, { card: cardText(objective.card) });
    case "reach-state":
      return EN.objectives.reachState;
    case "best-move":
      return EN.objectives.bestMove;
    case "all":
      return EN.objectives.composite;
    default:
      return EN.objectives.reachState;
  }
}

export type LibraryHint = {
  key: string;
  params?: Record<string, string | number>;
  card?: Card;
  column?: number;
};

export type LibraryExplanation = {
  whyKey: string;
  noticeKey: string;
  alternativeKey: string;
  delayedKey?: string;
  detailKey: string;
  params: Record<string, string | number>;
};

/**
 * Up to three progressive hints, from principle to direction.
 *
 * Hint 2 is only emitted when there is a VISIBLE card or column to point at; a
 * puzzle never gets a hint that names something the player cannot see. The
 * tactical hint still stops short of playing the move.
 */
export function hintsFor(
  objective: PuzzleObjective,
  solution: readonly SolitaireMove[],
  startState: SolitaireState,
  category: PuzzleLibraryCategory,
): LibraryHint[] {
  const hints: LibraryHint[] = [{ key: `puzzleLibrary.hints.${category}.1` }];

  const focus = focusFor(objective, solution, startState);
  if (focus) {
    // Only carry the parameters this category's template actually renders, so a
    // hint never ships an unused value (and the copy stays locale-neutral).
    const template = (EN.hints as unknown as Record<string, Record<string, string>>)[category]?.["2"] ?? "";
    const params = Object.fromEntries(
      Object.entries(focus.params).filter(([name]) => template.includes(`{${name}}`)),
    );
    hints.push({
      key: `puzzleLibrary.hints.${category}.2`,
      params,
      ...(focus.card ? { card: focus.card } : {}),
      ...(focus.column !== undefined ? { column: focus.column } : {}),
    });
  }

  hints.push({ key: `puzzleLibrary.hints.${category}.3` });
  return hints.slice(0, 3);
}

function focusFor(
  objective: PuzzleObjective,
  solution: readonly SolitaireMove[],
  startState: SolitaireState,
): { params: Record<string, string | number>; card?: Card; column?: number } | null {  if (objective.kind === "place-card" && isVisibleCard(startState, objective.card)) {
    const destination = objective.destination;
    // `strict` is off in this repo, so a discriminant check does not narrow the
    // union for the compiler; narrow it explicitly for the column access.
    const tableauDestination =
      destination.kind === "tableau" ? (destination as { column: number }) : null;
    const column = tableauDestination ? tableauDestination.column + 1 : undefined;
    return {
      params: { card: cardText(objective.card), ...(column ? { column } : {}) },
      card: objective.card,
      ...(tableauDestination ? { column: tableauDestination.column } : {}),
    };
  }

  for (const move of solution) {
    if (move.kind !== "tableau-to-tableau" && move.kind !== "tableau-to-foundation") continue;
    if (!isVisibleCard(startState, move.card)) continue;
    const column = move.fromColumn + 1;
    return {
      params: { card: cardText(move.card), column },
      card: move.card,
      column: move.fromColumn,
    };
  }

  const wasteTop = startState.waste[startState.waste.length - 1];
  if (wasteTop) {
    return { params: { card: cardText(wasteTop) }, card: wasteTop };
  }
  return null;
}

/** The post-solve explanation, as keys plus the facts the copy needs. */
export function explanationFor(
  objective: PuzzleObjective,
  load: StrategicLoad,
  solution: readonly SolitaireMove[],
  startState: SolitaireState,
  category: PuzzleLibraryCategory,
): LibraryExplanation {
  const focus = focusFor(objective, solution, startState);
  const baseParams = { ...(focus ? focus.params : {}) };

  let detailKey = "puzzleLibrary.explanations.progress";
  let params = baseParams;
  if (category === "stock") {
    detailKey = "puzzleLibrary.explanations.stockPlan";
  } else if (load.reveals > 0) {
    detailKey = "puzzleLibrary.explanations.revealedCount";
    params = { ...baseParams, count: load.reveals };
  } else if (load.foundationGain > 0) {
    detailKey = "puzzleLibrary.explanations.foundationGain";
    params = { ...baseParams, count: load.foundationGain };
  } else if (load.openedColumns.length > 0) {
    detailKey = "puzzleLibrary.explanations.openedColumn";
    params = { ...baseParams, column: load.openedColumns[0] + 1 };
  }

  return {
    whyKey: "puzzleLibrary.explanations.why",
    noticeKey: "puzzleLibrary.explanations.notice",
    alternativeKey: "puzzleLibrary.explanations.alternative",
    ...(load.delaysGreedyMove ? { delayedKey: "puzzleLibrary.explanations.delayed" } : {}),
    detailKey,
    params,
  };
}

// ── Alternative accepted solutions ────────────────────────────────────────

type AlternativeSearch = {
  paths: SolitaireMove[][];
  nodes: number;
  capped: boolean;
};

/**
 * Find other legal lines that reach the same objective.
 *
 * Bounded twice: depth to the curated solution's length, and a node budget
 * (`PUZZLE_LIMITS.maxMoves` × 4). Deterministic (the engine's legal-move order),
 * so a rebuild finds the same alternatives. No state memoisation: a reveal
 * objective depends on the path, so two paths to one state are not equivalent.
 */
export function findAlternativeSolutions(
  spec: PuzzleSpec,
  options: { maxExtra?: number; maxNodes?: number } = {},
): AlternativeSearch {
  const maxExtra = options.maxExtra ?? 2;
  const maxNodes = options.maxNodes ?? PUZZLE_LIMITS.maxMoves * 4;
  const depth = spec.solutions[0]?.length ?? 0;
  const primary = (spec.solutions[0] ?? []).map(puzzleMoveSignature).join(">");
  const paths: SolitaireMove[][] = [];
  let nodes = 0;
  let capped = false;

  const walk = (
    state: SolitaireState,
    path: SolitaireMove[],
    revealed: number,
  ): void => {
    if (paths.length >= maxExtra || capped) return;
    nodes += 1;
    if (nodes > maxNodes) {
      capped = true;
      return;
    }
    if (path.length > 0) {
      const signatures = path.map(puzzleMoveSignature);
      if (objectiveReached(spec.objective, state, { revealed, signatures })) {
        if (signatures.join(">") !== primary) paths.push(path.slice());
        // A shorter line that already satisfies the objective is the end of this
        // branch; extending it would produce a near-duplicate solution.
        return;
      }
    }
    if (path.length >= depth) return;
    for (const move of legalMoves(state)) {
      const applied = applyMove({ state, move });
      if (!applied.ok) continue;
      walk(applied.state, [...path, move], revealed + (applied.revealed?.length ?? 0));
    }
  };

  walk(spec.startState, [], 0);
  return { paths, nodes, capped };
}

// ── Building the library ──────────────────────────────────────────────────

type LibraryDataEntry = (typeof PUZZLE_LIBRARY_DATA)[number];

function specCategoryFor(objective: PuzzleObjective): PuzzleCategory {
  switch (objective.kind) {
    case "reveal-cards":
      return "reveal";
    case "open-column":
      return "open-column";
    case "place-card":
      return "place-card";
    case "foundation-milestone":
      return "foundation";
    case "preserve-card":
      return "preserve";
    case "reach-state":
      return "reach-state";
    case "best-move":
      return "best-move";
    default:
      return "composite";
  }
}

function hintText(hint: LibraryHint): string {
  const [, , category, index] = hint.key.split(".");
  const template =
    (EN.hints as unknown as Record<string, Record<string, string>>)[category]?.[index] ??
    "Look at the board again.";
  return format(template, hint.params ?? {});
}

function toPuzzleHints(hints: LibraryHint[]): PuzzleHint[] {
  return hints.map((hint) => ({
    text: hintText(hint),
    ...(hint.card ? { card: { suit: hint.card.suit, rank: hint.card.rank } } : {}),
    ...(hint.column !== undefined ? { column: hint.column } : {}),
  }));
}

export type LibraryPuzzle = {
  id: string;
  category: PuzzleLibraryCategory;
  level: PuzzleLibraryLevelId;
  levelNumber: number;
  levelKey: string;
  spec: PuzzleSpec;
  load: StrategicLoad;
  hints: LibraryHint[];
  explanation: LibraryExplanation;
  /** Solutions that were actually replayed and accepted. */
  solutionCount: number;
};

export type PuzzleLibraryReport = {
  total: number;
  byCategory: Record<PuzzleLibraryCategory, number>;
  byLevel: Record<PuzzleLibraryLevelId, number>;
  /** Puzzles whose accepted solution needs two or more moves. */
  multiDecision: number;
  /** Puzzles with more than one accepted, verified solution. */
  multipleSolutions: number;
  /** Puzzles that carry all three hints. */
  withThreeHints: number;
  rejected: number;
  rejectedIds: string[];
  legacy: {
    /** Recorded puzzle IDs are untouched by this library. */
    removed: number;
    revised: number;
    replaced: number;
    note: string;
  };
  gaps: string[];
};

export type PuzzleLibraryBuild = {
  puzzles: LibraryPuzzle[];
  rejected: { id: string; issues: PuzzleValidationResult["issues"] }[];
  report: PuzzleLibraryReport;
};

let cache: PuzzleLibraryBuild | null = null;

function buildEntry(entry: LibraryDataEntry): LibraryPuzzle {
  const category = entry.category as PuzzleLibraryCategory;
  const objective = entry.objective as unknown as PuzzleObjective;
  const startState = decodePuzzleStart(entry.start);
  const solution = entry.solution as unknown as SolitaireMove[];

  const hints = hintsFor(objective, solution, startState, category);
  const spec: PuzzleSpec = {
    id: entry.id,
    version: PUZZLE_SPEC_VERSION,
    category: specCategoryFor(objective),
    difficulty: 3,
    objective,
    objectiveText: objectiveTextFor(objective),
    concept: EN.concepts[category],
    startState,
    constraints: { maxMoves: solution.length, maxStockPasses: PUZZLE_LIMITS.maxStockPasses },
    solutions: [solution],
    hints: toPuzzleHints(hints),
    verification: {
      kind: "verified-set",
      checkedSolutions: 1,
      maxMoves: solution.length,
    },
  };

  const load = assessStrategicLoad(spec, category);
  spec.difficulty = load.band as PuzzleSpec["difficulty"];

  // The bounded alternative search can miss a short answer when the start has
  // more moves than its node budget, so check every one-move finish directly.
  for (const move of legalMoves(startState)) {
    const applied = applyMove({ state: startState, move });
    if (!applied.ok) continue;
    if (
      objectiveReached(objective, applied.state, {
        revealed: applied.revealed.length,
        signatures: [puzzleMoveSignature(move)],
      })
    ) {
      throw new Error(
        "A one-move alternative solves this puzzle; it is not a multi-decision position.",
      );
    }
  }

  const alternatives = findAlternativeSolutions(spec, { maxExtra: 2 });
  // A different LEGAL line that finishes in one move would mean the puzzle is a
  // one-move task wearing a longer solution. That fails the quality bar, so the
  // entry is rejected rather than shipped with the easier line hidden.
  if (alternatives.paths.some((path) => path.length < 2)) {
    throw new Error("A one-move alternative solves this puzzle; it is not a multi-decision position.");
  }
  for (const path of alternatives.paths) {
    spec.solutions = [...spec.solutions, path];
  }
  spec.verification = {
    kind: "verified-set",
    checkedSolutions: spec.solutions.length,
    maxMoves: spec.solutions.reduce((max, path) => Math.max(max, path.length), 0),
  };

  return {
    id: entry.id,
    category,
    level: load.level.id,
    levelNumber: load.level.level,
    levelKey: load.level.key,
    spec,
    load,
    hints,
    explanation: explanationFor(objective, load, solution, startState, category),
    solutionCount: spec.solutions.length,
  };
}

/**
 * Build (and memoise) the validated library.
 *
 * Each entry is rebuilt from its encoded start, measured, given its derived
 * difficulty and validated with every accepted solution. An entry that fails
 * validation is reported, not shipped. The memoised value is safe to reuse: the
 * library is immutable data plus pure functions.
 */
export function buildPuzzleLibrary(): PuzzleLibraryBuild {
  if (cache) return cache;

  const puzzles: LibraryPuzzle[] = [];
  const rejected: PuzzleLibraryBuild["rejected"] = [];
  const seenStarts = new Set<string>();

  for (const entry of PUZZLE_LIBRARY_DATA) {
    if (seenStarts.has(entry.start)) continue;
    seenStarts.add(entry.start);
    try {
      const built = buildEntry(entry);
      const result = validatePuzzle(built.spec);
      if (!result.ok) {
        rejected.push({ id: built.id, issues: result.issues });
        continue;
      }
      // The static spec was checked with the derived difficulty; make sure no
      // hidden-information or objective issue slipped in with the hints.
      const staticCheck = validatePuzzleSpec(built.spec);
      if (staticCheck.issues.length > 0) {
        rejected.push({ id: built.id, issues: staticCheck.issues });
        continue;
      }
      puzzles.push(built);
    } catch (error) {
      rejected.push({
        id: entry.id,
        issues: [
          {
            code: "INVALID_SPEC",
            message: error instanceof Error ? error.message : "The entry could not be rebuilt.",
          },
        ],
      });
    }
  }

  cache = { puzzles, rejected, report: makeReport(puzzles, rejected) };
  return cache;
}

function makeReport(
  puzzles: LibraryPuzzle[],
  rejected: PuzzleLibraryBuild["rejected"],
): PuzzleLibraryReport {
  const byCategory = Object.fromEntries(
    PUZZLE_LIBRARY_CATEGORIES.map((category) => [category.id, 0]),
  ) as Record<PuzzleLibraryCategory, number>;
  const byLevel = Object.fromEntries(
    PUZZLE_LIBRARY_LEVELS.map((level) => [level.id, 0]),
  ) as Record<PuzzleLibraryLevelId, number>;

  for (const puzzle of puzzles) {
    byCategory[puzzle.category] += 1;
    byLevel[puzzle.level] += 1;
  }

  const gaps: string[] = [];
  for (const category of PUZZLE_LIBRARY_CATEGORIES) {
    if (byCategory[category.id] === 0) gaps.push(`No puzzle covers ${category.id}.`);
  }
  for (const level of PUZZLE_LIBRARY_LEVELS) {
    if (byLevel[level.id] === 0) gaps.push(`No puzzle is rated ${level.id}.`);
  }

  return {
    total: puzzles.length,
    byCategory,
    byLevel,
    multiDecision: puzzles.filter((puzzle) => puzzle.spec.solutions.every((path) => path.length >= 2)).length,
    multipleSolutions: puzzles.filter((puzzle) => puzzle.solutionCount > 1).length,
    withThreeHints: puzzles.filter((puzzle) => puzzle.hints.length === 3).length,
    rejected: rejected.length,
    rejectedIds: rejected.map((entry) => entry.id),
    legacy: {
      removed: 0,
      revised: 0,
      replaced: 0,
      note:
        "Existing daily and practice puzzle IDs are untouched and remain addressable through specFromBestMovePuzzle; this library is additive, so no player progress is reset.",
    },
    gaps,
  };
}

/** Convenience: the library without the report, memoised with it. */
export function puzzleLibraryPuzzles(): LibraryPuzzle[] {
  return buildPuzzleLibrary().puzzles;
}
