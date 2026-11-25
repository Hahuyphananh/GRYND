// src/lib/solitaire-duel/puzzleValidation.ts
//
// THE PUZZLE VALIDATION ENGINE.
//
// A puzzle here is a SPEC, not a side effect of a seed: a stable id, a spec
// version, a complete starting Klondike state, a declared objective, optional
// move / stock-pass constraints, and one or more solution paths that have been
// replayed through the SAME engine the game uses (`./rules.ts`).
//
// WHAT THIS MODULE GUARANTEES (all checked, not assumed):
//
//   * every accepted solution starts from the exact declared state and is
//     replayed move by move through `applyMove`, so an illegal move is refused
//     at its index instead of being counted as a solution;
//   * a path only counts as solved when the OBJECTIVE is reached — a legal move
//     that changes nothing is `OBJECTIVE_NOT_MET`, never "correct";
//   * the objective is evaluated at the end of the path (or, for `best-move`,
//     on the final move), so objectives and constraints cannot be satisfied by
//     the starting position (that is `OBJECTIVE_ALREADY_MET`);
//   * objectives that refer to a card may only refer to a card the player can
//     SEE in the starting position. A hidden card in an objective, a hint or a
//     public payload is `HIDDEN_INFO_LEAK`;
//   * validation is pure and bounded: no search, no clock, no I/O. Replaying a
//     path is O(moves × 52); every collection is capped by `PUZZLE_LIMITS`, so a
//     hostile spec cannot make validation expensive. Complexity metrics are
//     computed from one `legalMoves` pass, never a search;
//   * the public payload is a projection, not a redaction: face-down slots
//     carry no identity, `nextStockCard` is nulled (the duel exposes it for an
//     optimistic draw; a puzzle must not), and solution moves are absent.
//
// WHAT IT DOES NOT CLAIM: that a solution is unique, optimal, or the only one.
// `verification.kind` records exactly what the author actually proved —
// `verified-set` means "these paths were replayed and they reach the objective",
// never "no other path exists". Uniqueness requires an exhaustive proof this
// module deliberately does not run.
//
// A PARALLEL RULES ENGINE IS NOT INTRODUCED. Moves are built by the caller and
// applied by `./rules.ts`; this file only decides whether a path is legal and
// whether the objective it names is true. Hidden-card identities are never
// produced here: the only cards this module ever returns are cards that are
// face-up in the declared starting position.
//
// Browser-safe and server-safe: pure engine imports only.

import { legalMoves, scoreMove } from "./ai";
import {
  DECK_SIZE,
  MAX_MOVES_PER_SEAT,
  SUITS,
  TABLEAU_COLUMNS,
} from "./constants";
import { cardKey } from "./deck";
import { applyMove, isComplete, viewForState } from "./rules";
import type {
  Card,
  SolitaireMove,
  SolitaireState,
  SolitaireView,
  Suit,
} from "./types";
import type { Puzzle } from "./puzzleCore";

/** The spec version this module can read and write. Bump on ANY shape change. */
export const PUZZLE_SPEC_VERSION = 1;

/**
 * Hard bounds on a spec.
 *
 * `maxMoves` reuses the game's own per-seat cap (`MAX_MOVES_PER_SEAT`) so a
 * puzzle can never demand a longer line than a real match allows. The other
 * caps exist so validation can never be turned into unbounded work by a spec.
 */
export const PUZZLE_LIMITS = Object.freeze({
  maxMoves: MAX_MOVES_PER_SEAT,
  maxStockPasses: 48,
  maxSolutions: 8,
  maxHints: 4,
  maxObjectives: 4,
  maxHintLength: 280,
});

/** Objective families this engine can actually verify. */
export const PUZZLE_OBJECTIVE_KINDS = Object.freeze([
  "reveal-cards",
  "open-column",
  "place-card",
  "foundation-milestone",
  "preserve-card",
  "reach-state",
  "best-move",
  "all",
] as const);

export type PuzzleObjectiveKind = (typeof PUZZLE_OBJECTIVE_KINDS)[number];

/**
 * Objective families that are deliberately NOT supported, and why.
 *
 * Exported so a UI, an author tool or a test can state the limit instead of
 * implying the engine checks something it does not.
 */
export const UNSUPPORTED_OBJECTIVE_KINDS = Object.freeze([
  {
    kind: "move-sequence-to-location",
    reason:
      "A single card can be required at a location (place-card); an ordered RUN of several cards cannot, because a destination only checks its top card and a 'sequence preserved elsewhere' claim would not be verifiable from the final state alone.",
  },
  {
    kind: "exact-board-layout",
    reason:
      "reach-state verifies a bounded summary (foundation counts, face-down count, empty columns, stock/waste counts). Requiring every card's exact slot would need the full hidden layout in the spec and in the author tooling; indistinguishable summaries would then validate as equal.",
  },
  {
    kind: "no-wasted-foundation-moves",
    reason:
      "Whether a foundation move was 'wasted' depends on the hidden continuation. It can only be judged by a solver, and this engine never runs one during validation.",
  },
  {
    kind: "preserve-card-while-winning",
    reason:
      "preserve-card is verifiable on its own; combining it with 'still win the whole board' would require a proof of the continuation, which is a solver claim, not a state predicate.",
  },
] as const);

// ── Types ─────────────────────────────────────────────────────────────────

export type PuzzleCategory =
  | "reveal"
  | "open-column"
  | "place-card"
  | "foundation"
  | "reach-state"
  | "preserve"
  | "best-move"
  | "composite";

/** 1 = gentle, 5 = expert. A band, never a claim of measured pass rate. */
export type PuzzleDifficulty = 1 | 2 | 3 | 4 | 5;

export type PuzzlePlaceDestination =
  | { kind: "foundation"; suit?: Suit }
  | { kind: "tableau"; column: number };

/** A reach-state target is a SUMMARY of counts — never a hidden layout. */
export type PuzzleStateTarget = {
  foundations?: Partial<Record<Suit, number>>;
  faceDown?: number;
  emptyColumns?: number;
  stockCount?: number;
  wasteCount?: number;
};

export type PuzzleObjective =
  /** Reveal at least `count` face-down tableau cards across the solution path. */
  | { kind: "reveal-cards"; count: number }
  /** Leave `column` empty (or any column, when omitted) at the end of the path. */
  | { kind: "open-column"; column?: number }
  /** The card is the top of its foundation pile / of `column` at the end. */
  | { kind: "place-card"; card: Card; destination: PuzzlePlaceDestination }
  /** Foundation total (or one suit) reaches a milestone. */
  | { kind: "foundation-milestone"; total?: number; suit?: Suit; rank?: number }
  /** The card is still face-up in the tableau at the end (composite use only). */
  | { kind: "preserve-card"; card: Card; in: "tableau" }
  /** The end state matches every field that is specified. */
  | { kind: "reach-state"; target: PuzzleStateTarget }
  /**
   * Legacy one-move puzzle: the FINAL move of the path must be one of
   * `acceptedMoves`. This is what the shipped daily/practice puzzles are, and
   * the only objective whose answer must stay off the wire.
   */
  | { kind: "best-move"; acceptedMoves: readonly SolitaireMove[] }
  /** All children must hold at the end. This is how preserve-card is used. */
  | { kind: "all"; objectives: readonly PuzzleObjective[] };

export type PuzzleHint = {
  /** A principle-level sentence. Never the hidden layout. */
  text: string;
  /** Optional visible card to focus on; rejected when it is hidden. */
  card?: Card;
  /** Optional visible column to focus on. */
  column?: number;
};

export type PuzzleConstraints = {
  /** Maximum accepted moves in a solution path. */
  maxMoves?: number;
  /** Maximum completed stock passes (a draw that empties the stock). */
  maxStockPasses?: number;
};

export type PuzzleVerification = {
  /** What was actually proved — never upgraded to "unique" implicitly. */
  kind: "verified-set" | "exhaustive";
  /** How many paths were replayed when the puzzle was accepted. */
  checkedSolutions: number;
  /** The longest accepted path, in moves. */
  maxMoves: number;
};

export type PuzzleSpec = {
  /** Stable identity — an existing `Puzzle.key` when migrating. */
  id: string;
  version: number;
  category: PuzzleCategory;
  difficulty: PuzzleDifficulty;
  objective: PuzzleObjective;
  /** One sentence the player reads. Must not name a hidden card. */
  objectiveText: string;
  /** One or two sentences on the strategic idea. */
  concept: string;
  /** The authoritative starting position (server-side; never serialised). */
  startState: SolitaireState;
  constraints?: PuzzleConstraints;
  /** One or more paths, each replayed from `startState`. */
  solutions: readonly (readonly SolitaireMove[])[];
  hints?: readonly PuzzleHint[];
  verification: PuzzleVerification;
};

export type PuzzleIssueCode =
  | "INVALID_SPEC"
  | "UNSUPPORTED_VERSION"
  | "INVALID_STATE"
  | "INVALID_OBJECTIVE"
  | "CONTRADICTORY_OBJECTIVES"
  | "OBJECTIVE_ALREADY_MET"
  | "OBJECTIVE_NOT_MET"
  | "ILLEGAL_MOVE"
  | "MOVE_LIMIT_EXCEEDED"
  | "STOCK_PASS_LIMIT_EXCEEDED"
  | "NO_SOLUTIONS"
  | "HIDDEN_INFO_LEAK"
  | "LIMIT_EXCEEDED"
  | "DIFFICULTY_MISMATCH";

export type PuzzleIssue = {
  code: PuzzleIssueCode;
  message: string;
  /** Index into `solutions`, when the issue belongs to one path. */
  pathIndex?: number;
  /** Index into that path's moves. */
  moveIndex?: number;
};

export type PuzzlePathStats = {
  moves: number;
  /** Face-down cards turned over along the path. */
  revealed: number;
  /** Draws that emptied the stock (a completed pass through the stock). */
  stockPasses: number;
  draws: number;
  /** Cards added to the foundations along the path. */
  foundationGain: number;
  /** Columns that became empty along the path. */
  columnsOpened: number;
  /** Move signatures, in order — `best-move` reads the last one. */
  signatures: string[];
};

export type PuzzleComplexity = {
  branching: number;
  productiveMoves: number;
  hiddenCards: number;
  foundationCards: number;
  emptyColumns: number;
  stockCount: number;
  /** Distinct first moves across all accepted solutions. */
  distinctFirstMoves: number;
  movesToGoal: number | null;
  stockPassesToGoal: number | null;
  /** Uncalibrated 0..100 structural score. */
  score: number;
  suggestedDifficulty: PuzzleDifficulty;
};

export type PuzzleSpecValidation = {
  issues: PuzzleIssue[];
  warnings: PuzzleIssue[];
};

export type PuzzleValidationResult = PuzzleSpecValidation & {
  ok: boolean;
  finalStates?: SolitaireState[];
  stats?: PuzzlePathStats[];
  metrics?: PuzzleComplexity;
};

// ── Small pure helpers ────────────────────────────────────────────────────

const RANK_TEXT = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUIT_GLYPH: Record<Suit, string> = {
  spades: "\u2660",
  hearts: "\u2665",
  diamonds: "\u2666",
  clubs: "\u2663",
};
const SUIT_LETTER: Record<Suit, string> = {
  spades: "S",
  hearts: "H",
  diamonds: "D",
  clubs: "C",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isSuit(value: unknown): value is Suit {
  return typeof value === "string" && (SUITS as readonly string[]).includes(value);
}

function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  const rank = value.rank;
  return isSuit(value.suit) && typeof rank === "number" && Number.isInteger(rank) && rank >= 1 && rank <= 13;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a && b && a.suit === b.suit && a.rank === b.rank);
}

function issue(code: PuzzleIssueCode, message: string, extra: Partial<PuzzleIssue> = {}): PuzzleIssue {
  return { code, message, ...extra };
}

/** Stable identity for a move, mirroring `puzzleCore.moveSignature`. */
export function puzzleMoveSignature(move: SolitaireMove): string {
  switch (move?.kind) {
    case "tableau-to-tableau":
      return `t2t:${move.fromColumn}:${move.toColumn}:${move.card?.suit}:${move.card?.rank}`;
    case "tableau-to-foundation":
      return `t2f:${move.fromColumn}:${move.card?.suit}:${move.card?.rank}:${move.suit}`;
    case "waste-to-tableau":
      return `w2t:${move.toColumn}`;
    case "waste-to-foundation":
      return `w2f:${move.suit}`;
    case "foundation-to-tableau":
      return `f2t:${move.suit}:${move.toColumn}`;
    default:
      return "draw";
  }
}

function foundationCountOf(state: SolitaireState): number {
  let total = 0;
  for (const suit of SUITS) total += state.foundations?.[suit]?.length ?? 0;
  return total;
}

function faceDownCount(state: SolitaireState): number {
  let total = 0;
  for (const column of state.tableau ?? []) {
    for (const pile of column) if (!pile?.faceUp) total += 1;
  }
  return total;
}

function emptyColumnCount(state: SolitaireState): number {
  let total = 0;
  for (const column of state.tableau ?? []) if (column.length === 0) total += 1;
  return total;
}

/** Every card a player can see (or already holds): face-up tableau, waste, foundations. */
function visibleCards(state: SolitaireState): Card[] {
  const cards: Card[] = [];
  for (const column of state.tableau ?? []) {
    for (const pile of column) if (pile.faceUp && pile.card) cards.push(pile.card);
  }
  for (const card of state.waste ?? []) if (card) cards.push(card);
  for (const suit of SUITS) {
    for (const card of state.foundations?.[suit] ?? []) if (card) cards.push(card);
  }
  return cards;
}

/** Cards the player cannot see yet: face-down tableau positions and the stock. */
function hiddenCards(state: SolitaireState): Card[] {
  const cards: Card[] = [];
  for (const column of state.tableau ?? []) {
    for (const pile of column) if (!pile.faceUp && pile.card) cards.push(pile.card);
  }
  for (const card of state.stock ?? []) if (card) cards.push(card);
  return cards;
}

function isVisibleCard(state: SolitaireState, card: Card): boolean {
  return visibleCards(state).some((visible) => sameCard(visible, card));
}

/**
 * True when `text` spells out a card the player cannot see.
 *
 * A structured `card` reference is checked exactly; this scan is the safety net
 * for prose ("the KS in column 4"). It only recognises the compact notations
 * (`KS`, `K♠`), not English names, because a looser pattern would refuse
 * legitimate copy like "3 stock cards". That limit is deliberate and tested.
 */
function textNamesHiddenCard(text: string, hidden: readonly Card[]): Card | null {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const card of hidden) {
    const rank = RANK_TEXT[card.rank] ?? String(card.rank);
    const glyph = SUIT_GLYPH[card.suit];
    const letter = SUIT_LETTER[card.suit];
    const patterns = [
      new RegExp(`(^|[^A-Za-z0-9])${rank}\\s?${glyph}(?![A-Za-z0-9])`, "iu"),
      new RegExp(`(^|[^A-Za-z0-9])${rank}${letter}(?![A-Za-z0-9])`),
    ];
    if (patterns.some((pattern) => pattern.test(text))) return card;
  }
  return null;
}

// ── Starting-state integrity ──────────────────────────────────────────────

/**
 * Validate the declared starting position.
 *
 * A puzzle is only meaningful on a COMPLETE, internally consistent board: 52
 * unique cards, seven columns, valid foundations, hidden-before-face-up in every
 * column, and no already-finished board. Anything else is `INVALID_STATE` and
 * no path is replayed against it.
 */
export function validateStartState(state: unknown): PuzzleIssue[] {
  const issues: PuzzleIssue[] = [];
  const invalid = (message: string) => issues.push(issue("INVALID_STATE", message));

  if (!isRecord(state)) return [issue("INVALID_STATE", "The starting position is missing.")];

  const tableau = (state as SolitaireState).tableau;
  if (!Array.isArray(tableau) || tableau.length !== TABLEAU_COLUMNS) {
    return [issue("INVALID_STATE", `The tableau must have exactly ${TABLEAU_COLUMNS} columns.`)];
  }

  const seen = new Set<string>();
  const addCard = (card: unknown, where: string) => {
    if (!isCard(card)) {
      invalid(`${where} does not hold a valid card.`);
      return;
    }
    const key = cardKey(card);
    if (seen.has(key)) invalid(`${where} repeats ${key}; a board must hold 52 unique cards.`);
    seen.add(key);
  };

  for (let column = 0; column < tableau.length; column += 1) {
    const piles = tableau[column];
    if (!Array.isArray(piles)) {
      invalid(`Column ${column + 1} is not a pile.`);
      continue;
    }
    // Bottom→top: `tableauTop` is the LAST element, so every hidden card must
    // sit below every face-up one. A face-down card found after a face-up card
    // is what makes a column unreadable by the engine.
    let faceUpSeen = false;
    for (let index = 0; index < piles.length; index += 1) {
      const pile = piles[index] as { card?: unknown; faceUp?: unknown };
      if (!isRecord(pile) || typeof pile.faceUp !== "boolean") {
        invalid(`Column ${column + 1}, position ${index + 1} has no face-up flag.`);
        continue;
      }
      if (pile.faceUp) {
        faceUpSeen = true;
        addCard(pile.card, `Column ${column + 1}, position ${index + 1}`);
      } else {
        if (faceUpSeen) {
          invalid(`Column ${column + 1} has a face-down card above a face-up one.`);
        }
        // A hidden position may carry the deal's identity (server-side state) or
        // nothing at all — both are legal; a malformed card is not.
        if (pile.card !== null && pile.card !== undefined) {
          if (!isCard(pile.card)) {
            invalid(`Column ${column + 1}, position ${index + 1} has a malformed hidden card.`);
          } else {
            addCard(pile.card, `Column ${column + 1}, position ${index + 1}`);
          }
        }
      }
    }
  }

  if (!Array.isArray(state.stock)) invalid("The stock is missing.");
  else state.stock.forEach((card, index) => addCard(card, `Stock card ${index + 1}`));

  if (!Array.isArray(state.waste)) invalid("The waste is missing.");
  else state.waste.forEach((card, index) => addCard(card, `Waste card ${index + 1}`));

  const foundations = isRecord(state.foundations) ? state.foundations : null;
  if (!foundations) invalid("The foundations are missing.");
  else {
    for (const suit of SUITS) {
      const pile = (foundations as Record<string, unknown>)[suit];
      if (!Array.isArray(pile)) {
        invalid(`The ${suit} foundation is missing.`);
        continue;
      }
      for (let index = 0; index < pile.length; index += 1) {
        const card = pile[index];
        addCard(card, `The ${suit} foundation`);
        if (isCard(card) && (card.suit !== suit || card.rank !== index + 1)) {
          invalid(`The ${suit} foundation is not an ascending Ace-first pile.`);
        }
      }
    }
  }

  if (seen.size !== DECK_SIZE) {
    invalid(`The board holds ${seen.size} unique cards; a Klondike position holds ${DECK_SIZE}.`);
  }

  if (!isIntegerInRange(state.ply, 0, PUZZLE_LIMITS.maxMoves * 4)) {
    invalid("The starting position has no valid move counter.");
  }
  if ((state as SolitaireState).resetCount !== undefined && !isIntegerInRange(state.resetCount, 0, 1000)) {
    invalid("The starting position has an invalid re-deal counter.");
  }

  try {
    if (isComplete(state as SolitaireState)) invalid("A finished board cannot be a puzzle start.");
  } catch {
    invalid("The starting position cannot be read by the rules engine.");
  }

  return issues;
}

// ── Objective shape and contradictions ────────────────────────────────────

function objectiveIssues(objective: unknown, depth = 0): PuzzleIssue[] {
  if (!isRecord(objective)) return [issue("INVALID_OBJECTIVE", "The objective is missing.")];
  const kind = objective.kind;
  const issues: PuzzleIssue[] = [];

  switch (kind) {
    case "reveal-cards": {
      if (!isIntegerInRange(objective.count, 1, 28)) {
        issues.push(issue("INVALID_OBJECTIVE", "reveal-cards needs a count between 1 and 28."));
      }
      break;
    }
    case "open-column": {
      if (objective.column !== undefined && !isIntegerInRange(objective.column, 0, TABLEAU_COLUMNS - 1)) {
        issues.push(issue("INVALID_OBJECTIVE", "open-column names a column outside the tableau."));
      }
      break;
    }
    case "place-card": {
      if (!isCard(objective.card)) {
        issues.push(issue("INVALID_OBJECTIVE", "place-card needs a card."));
      }
      const destination = objective.destination;
      if (!isRecord(destination)) {
        issues.push(issue("INVALID_OBJECTIVE", "place-card needs a destination."));
      } else if (destination.kind === "tableau") {
        if (!isIntegerInRange(destination.column, 0, TABLEAU_COLUMNS - 1)) {
          issues.push(issue("INVALID_OBJECTIVE", "place-card names a column outside the tableau."));
        }
      } else if (destination.kind === "foundation") {
        if (destination.suit !== undefined && !isSuit(destination.suit)) {
          issues.push(issue("INVALID_OBJECTIVE", "place-card names an unknown foundation suit."));
        }
        if (isCard(objective.card) && destination.suit && destination.suit !== objective.card.suit) {
          issues.push(issue("INVALID_OBJECTIVE", "place-card sends a card to another suit's foundation."));
        }
      } else {
        issues.push(issue("INVALID_OBJECTIVE", "place-card has an unknown destination kind."));
      }
      break;
    }
    case "foundation-milestone": {
      const hasTotal = objective.total !== undefined;
      const hasSuit = objective.suit !== undefined || objective.rank !== undefined;
      if (hasTotal === hasSuit) {
        issues.push(
          issue("INVALID_OBJECTIVE", "foundation-milestone needs either a total or a suit and rank."),
        );
      }
      if (hasTotal && !isIntegerInRange(objective.total, 1, DECK_SIZE)) {
        issues.push(issue("INVALID_OBJECTIVE", "foundation-milestone total must be 1-52."));
      }
      if (hasSuit) {
        if (!isSuit(objective.suit)) {
          issues.push(issue("INVALID_OBJECTIVE", "foundation-milestone names an unknown suit."));
        }
        if (!isIntegerInRange(objective.rank, 1, 13)) {
          issues.push(issue("INVALID_OBJECTIVE", "foundation-milestone rank must be 1-13."));
        }
      }
      break;
    }
    case "preserve-card": {
      if (!isCard(objective.card)) {
        issues.push(issue("INVALID_OBJECTIVE", "preserve-card needs a card."));
      }
      if (objective.in !== "tableau") {
        issues.push(issue("INVALID_OBJECTIVE", "preserve-card can only mean the tableau."));
      }
      break;
    }
    case "reach-state": {
      const target = objective.target;
      if (!isRecord(target)) {
        issues.push(issue("INVALID_OBJECTIVE", "reach-state needs a target."));
        break;
      }
      const keys = Object.keys(target);
      if (keys.length === 0) {
        issues.push(issue("INVALID_OBJECTIVE", "reach-state needs at least one target field."));
      }
      const foundations = target.foundations;
      if (foundations !== undefined) {
        if (!isRecord(foundations)) {
          issues.push(issue("INVALID_OBJECTIVE", "reach-state foundations must be a count map."));
        } else {
          for (const suit of Object.keys(foundations)) {
            if (!isSuit(suit)) {
              issues.push(issue("INVALID_OBJECTIVE", "reach-state names an unknown suit."));
            } else if (!isIntegerInRange((foundations as Record<string, unknown>)[suit], 0, 13)) {
              issues.push(issue("INVALID_OBJECTIVE", `reach-state ${suit} count must be 0-13.`));
            }
          }
        }
      }
      for (const field of ["faceDown", "emptyColumns", "stockCount", "wasteCount"] as const) {
        if (target[field] !== undefined && !isIntegerInRange(target[field], 0, DECK_SIZE)) {
          issues.push(issue("INVALID_OBJECTIVE", `reach-state ${field} must be 0-${DECK_SIZE}.`));
        }
      }
      if (keys.some((key) => !["foundations", "faceDown", "emptyColumns", "stockCount", "wasteCount"].includes(key))) {
        issues.push(issue("INVALID_OBJECTIVE", "reach-state has an unknown target field."));
      }
      break;
    }
    case "best-move": {
      const moves = objective.acceptedMoves;
      if (!Array.isArray(moves) || moves.length === 0) {
        issues.push(issue("INVALID_OBJECTIVE", "best-move needs at least one accepted move."));
      } else if (moves.length > 16) {
        issues.push(issue("LIMIT_EXCEEDED", "best-move accepts at most 16 moves."));
      }
      break;
    }
    case "all": {
      const children = objective.objectives;
      if (!Array.isArray(children) || children.length < 2) {
        issues.push(issue("INVALID_OBJECTIVE", "all needs at least two objectives."));
        break;
      }
      if (children.length > PUZZLE_LIMITS.maxObjectives) {
        issues.push(issue("LIMIT_EXCEEDED", `all accepts at most ${PUZZLE_LIMITS.maxObjectives} objectives.`));
      }
      if (depth > 1) {
        issues.push(issue("INVALID_OBJECTIVE", "all cannot be nested."));
      }
      for (const child of children) issues.push(...objectiveIssues(child, depth + 1));
      break;
    }
    default:
      issues.push(
        issue("INVALID_OBJECTIVE", `Unknown objective kind "${String(kind)}".`),
      );
  }

  return issues;
}

/** Bounds a `reach-state` target implies for the foundation total, if any. */
function targetFoundationBounds(objective: PuzzleObjective): { exact?: number; min?: number } {
  if (objective.kind === "foundation-milestone") {
    if (objective.total !== undefined) return { min: objective.total };
    if (objective.rank !== undefined) return { min: objective.rank };
    return {};
  }
  if (objective.kind === "reach-state" && objective.target.foundations) {
    let exact = 0;
    for (const suit of SUITS) exact += Number(objective.target.foundations[suit] ?? 0);
    return { exact };
  }
  return {};
}

/**
 * Detect objectives that cannot both be true, and objectives already true at
 * the start. This is deliberately partial (documented): it compares the counts
 * each objective pins, not a general theorem prover.
 */
function contradictionIssues(objective: PuzzleObjective, startState: SolitaireState): PuzzleIssue[] {
  const issues: PuzzleIssue[] = [];
  const children = objective.kind === "all" ? objective.objectives : [objective];

  const foundationObjectives = children
    .map((child) => targetFoundationBounds(child))
    .filter((bounds) => bounds.exact !== undefined || bounds.min !== undefined);

  const exacts = foundationObjectives.filter((bounds) => bounds.exact !== undefined);
  const minimums = foundationObjectives.filter((bounds) => bounds.min !== undefined);
  if (exacts.length > 1) {
    const first = exacts[0].exact as number;
    if (exacts.some((bounds) => bounds.exact !== first)) {
      issues.push(
        issue(
          "CONTRADICTORY_OBJECTIVES",
          "Two objectives require different exact foundation totals.",
        ),
      );
    }
  }
  for (const exact of exacts) {
    for (const min of minimums) {
      if ((exact.exact as number) < (min.min as number)) {
        issues.push(
          issue(
            "CONTRADICTORY_OBJECTIVES",
            "One objective pins a foundation total below another's minimum.",
          ),
        );
      }
    }
  }

  // The same card cannot be both kept in the tableau and sent to a foundation.
  const preserved = children
    .filter((child): child is Extract<PuzzleObjective, { kind: "preserve-card" }> => child.kind === "preserve-card")
    .map((child) => child.card);
  for (const child of children) {
    if (child.kind === "place-card" && child.destination.kind === "foundation") {
      if (preserved.some((card) => sameCard(card, child.card))) {
        issues.push(
          issue(
            "CONTRADICTORY_OBJECTIVES",
            "A card cannot be both preserved in the tableau and played to a foundation.",
          ),
        );
      }
    }
  }

  // Duplicate exact targets of the same kind with different values.
  const openColumns = children
    .filter(
      (child) =>
        isRecord(child) && child.kind === "open-column" && (child as { column?: unknown }).column !== undefined,
    )
    .map((child) => (child as Extract<PuzzleObjective, { kind: "open-column" }>).column);
  const distinctColumns = new Set(openColumns);
  if (
    distinctColumns.size > 1 &&
    children.every((child) => isRecord(child) && child.kind === "open-column")
  ) {
    issues.push(
      issue("CONTRADICTORY_OBJECTIVES", "Two open-column objectives pin different columns."),
    );
  }

  if (children.some((child) => child.kind === "best-move") && children.length > 1) {
    issues.push(
      issue("INVALID_OBJECTIVE", "best-move cannot be combined with other objectives."),
    );
  }

  return issues;
}

/**
 * Cheap, state-only objective check.
 *
 * This is what a route should call after an ordinary move: it reads the
 * position and the path counters, never a search. `stats` is optional so a
 * live caller can pass the counters it already keeps.
 */
export function objectiveReached(
  objective: PuzzleObjective,
  state: SolitaireState,
  stats?: Partial<PuzzlePathStats> | null,
): boolean {
  if (!objective || !state) return false;

  switch (objective.kind) {
    case "reveal-cards":
      return Number(stats?.revealed ?? 0) >= objective.count;
    case "open-column":
      if (objective.column === undefined) return emptyColumnCount(state) > 0;
      return (state.tableau?.[objective.column]?.length ?? 1) === 0;
    case "place-card": {
      const { card, destination } = objective;
      if (!card || !destination) return false;
      if (destination.kind === "foundation") {
        const suit = destination.suit ?? card.suit;
        const pile = state.foundations?.[suit] ?? [];
        return sameCard(pile[pile.length - 1], card);
      }
      const column = state.tableau?.[destination.column] ?? [];
      const top = column[column.length - 1];
      return Boolean(top?.faceUp && sameCard(top.card, card));
    }
    case "foundation-milestone": {
      if (objective.total !== undefined) return foundationCountOf(state) >= objective.total;
      if (!objective.suit || objective.rank === undefined) return false;
      return (state.foundations?.[objective.suit]?.length ?? 0) >= objective.rank;
    }
    case "preserve-card": {
      if (!objective.card) return false;
      for (const column of state.tableau ?? []) {
        for (const pile of column) {
          if (pile.faceUp && sameCard(pile.card, objective.card)) return true;
        }
      }
      return false;
    }
    case "reach-state": {
      const target = objective.target ?? {};
      if (target.foundations) {
        for (const suit of SUITS) {
          const wanted = target.foundations[suit];
          if (wanted === undefined) continue;
          if ((state.foundations?.[suit]?.length ?? 0) !== wanted) return false;
        }
      }
      if (target.faceDown !== undefined && faceDownCount(state) !== target.faceDown) return false;
      if (target.emptyColumns !== undefined && emptyColumnCount(state) !== target.emptyColumns) return false;
      if (target.stockCount !== undefined && (state.stock?.length ?? 0) !== target.stockCount) return false;
      if (target.wasteCount !== undefined && (state.waste?.length ?? 0) !== target.wasteCount) return false;
      return true;
    }
    case "best-move": {
      const signatures = stats?.signatures ?? [];
      if (signatures.length === 0) return false;
      const last = signatures[signatures.length - 1];
      return objective.acceptedMoves.some((move) => puzzleMoveSignature(move) === last);
    }
    case "all":
      return objective.objectives.every((child) => objectiveReached(child, state, stats));
    default:
      return false;
  }
}

/** The number of moves a `best-move` puzzle tolerates (a single move). */
function objectiveMaxMoves(objective: PuzzleObjective): number | undefined {
  return objective.kind === "best-move" ? 1 : undefined;
}

// ── Path replay ───────────────────────────────────────────────────────────

type AppliedOk = { ok: true; state: SolitaireState; revealed?: readonly Card[] };
type AppliedFailure = { ok: false; code?: string; error?: string };

export type PuzzleReplay = {
  ok: boolean;
  issues: PuzzleIssue[];
  state: SolitaireState;
  stats: PuzzlePathStats;
};

/**
 * Replay a path from the declared state through the authoritative engine.
 *
 * The move counter, stock passes and reveal count are measured from the actual
 * `applyMove` results, never inferred. A refused move stops the replay at its
 * index with `ILLEGAL_MOVE`, so a path can never be "partly valid" and count.
 */
export function replayPuzzlePath(
  startState: SolitaireState,
  moves: readonly SolitaireMove[],
  limits: PuzzleConstraints = {},
): PuzzleReplay {
  const issues: PuzzleIssue[] = [];
  const maxMoves = limits.maxMoves ?? PUZZLE_LIMITS.maxMoves;
  const maxStockPasses = limits.maxStockPasses ?? PUZZLE_LIMITS.maxStockPasses;

  let state = startState;
  const stats: PuzzlePathStats = {
    moves: 0,
    revealed: 0,
    stockPasses: 0,
    draws: 0,
    foundationGain: 0,
    columnsOpened: 0,
    signatures: [],
  };

  if (!Array.isArray(moves) || moves.length === 0) {
    return {
      ok: false,
      issues: [issue("OBJECTIVE_NOT_MET", "A solution path cannot be empty.")],
      state,
      stats,
    };
  }
  if (moves.length > PUZZLE_LIMITS.maxMoves) {
    return {
      ok: false,
      issues: [
        issue(
          "LIMIT_EXCEEDED",
          `A solution path may hold at most ${PUZZLE_LIMITS.maxMoves} moves.`,
        ),
      ],
      state,
      stats,
    };
  }

  for (let index = 0; index < moves.length; index += 1) {
    if (stats.moves >= maxMoves) {
      issues.push(
        issue("MOVE_LIMIT_EXCEEDED", `The puzzle allows at most ${maxMoves} move(s).`, {
          moveIndex: index,
        }),
      );
      return { ok: false, issues, state, stats };
    }

    const stockBefore = state.stock?.length ?? 0;
    const foundationsBefore = foundationCountOf(state);
    const emptyBefore = emptyColumnCount(state);

    const applied = applyMove({ state, move: moves[index] }) as AppliedOk | AppliedFailure;
    if (!applied.ok) {
      issues.push(
        issue("ILLEGAL_MOVE", `Move ${index + 1} is not legal in this position.`, {
          moveIndex: index,
        }),
      );
      return { ok: false, issues, state, stats };
    }

    state = applied.state;
    stats.moves += 1;
    stats.signatures.push(puzzleMoveSignature(moves[index]));
    stats.revealed += applied.revealed?.length ?? 0;
    if (moves[index]?.kind === "draw") stats.draws += 1;
    if (moves[index]?.kind === "draw" && stockBefore === 1 && (state.stock?.length ?? 0) === 0) {
      stats.stockPasses += 1;
    }
    const foundationGain = foundationCountOf(state) - foundationsBefore;
    if (foundationGain > 0) stats.foundationGain += foundationGain;
    const opened = emptyColumnCount(state) - emptyBefore;
    if (opened > 0) stats.columnsOpened += opened;

    if (stats.stockPasses > maxStockPasses) {
      issues.push(
        issue(
          "STOCK_PASS_LIMIT_EXCEEDED",
          `The puzzle allows at most ${maxStockPasses} stock pass(es).`,
          { moveIndex: index },
        ),
      );
      return { ok: false, issues, state, stats };
    }
  }

  return { ok: true, issues, state, stats };
}

// ── Spec validation ───────────────────────────────────────────────────────

const CATEGORIES: readonly PuzzleCategory[] = [
  "reveal",
  "open-column",
  "place-card",
  "foundation",
  "reach-state",
  "preserve",
  "best-move",
  "composite",
];

export function isSupportedPuzzleVersion(version: unknown): boolean {
  return version === PUZZLE_SPEC_VERSION;
}

/**
 * Static validation: everything that can be checked without replaying a path.
 *
 * Includes the hidden-information boundary — any objective or hint that names a
 * card the player cannot see is refused here, before a puzzle can be stored.
 */
export function validatePuzzleSpec(spec: unknown): PuzzleSpecValidation {
  const issues: PuzzleIssue[] = [];
  const warnings: PuzzleIssue[] = [];

  if (!isRecord(spec)) {
    return { issues: [issue("INVALID_SPEC", "The puzzle spec is missing.")], warnings };
  }
  const value = spec as unknown as PuzzleSpec;

  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    issues.push(issue("INVALID_SPEC", "A puzzle needs a non-empty stable id."));
  } else if (value.id.length > 80) {
    issues.push(issue("INVALID_SPEC", "A puzzle id may be at most 80 characters."));
  }

  if (!isSupportedPuzzleVersion(value.version)) {
    issues.push(
      issue(
        "UNSUPPORTED_VERSION",
        `Puzzle version ${String(value.version)} is not supported; this engine reads version ${PUZZLE_SPEC_VERSION}.`,
      ),
    );
  }

  if (!CATEGORIES.includes(value.category)) {
    issues.push(issue("INVALID_SPEC", `Unknown puzzle category "${String(value.category)}".`));
  }
  if (!isIntegerInRange(value.difficulty, 1, 5)) {
    issues.push(issue("INVALID_SPEC", "Difficulty must be an integer from 1 to 5."));
  }

  if (typeof value.objectiveText !== "string" || value.objectiveText.trim().length === 0) {
    issues.push(issue("INVALID_SPEC", "A puzzle needs player-facing objective text."));
  }
  if (typeof value.concept !== "string" || value.concept.trim().length === 0) {
    issues.push(issue("INVALID_SPEC", "A puzzle needs a one-line strategic concept."));
  }

  const stateIssues = validateStartState(value.startState);
  issues.push(...stateIssues);
  const stateUsable = stateIssues.length === 0;

  const objectiveProblems = objectiveIssues(value.objective);
  issues.push(...objectiveProblems);

  // Semantic checks read the objective's fields directly, so they only run on a
  // shape-valid objective. A malformed spec must produce errors, never a throw.
  if (stateUsable && objectiveProblems.length === 0) {
    issues.push(...contradictionIssues(value.objective, value.startState));

    // A puzzle must not be solved before it starts.
    if (value.objective && objectiveReached(value.objective, value.startState, { revealed: 0, signatures: [] })) {
      issues.push(
        issue("OBJECTIVE_ALREADY_MET", "The objective is already true in the starting position."),
      );
    }

    // Hidden-information boundary for objective card references.
    const hidden = hiddenCards(value.startState);
    for (const card of objectiveCards(value.objective)) {
      if (hidden.some((entry) => sameCard(entry, card))) {
        issues.push(
          issue("HIDDEN_INFO_LEAK", "An objective names a card the player cannot see."),
        );
      }
    }
  }

  const constraints = value.constraints ?? {};
  if (constraints.maxMoves !== undefined && !isIntegerInRange(constraints.maxMoves, 1, PUZZLE_LIMITS.maxMoves)) {
    issues.push(
      issue("INVALID_SPEC", `maxMoves must be an integer from 1 to ${PUZZLE_LIMITS.maxMoves}.`),
    );
  }
  if (
    constraints.maxStockPasses !== undefined &&
    !isIntegerInRange(constraints.maxStockPasses, 0, PUZZLE_LIMITS.maxStockPasses)
  ) {
    issues.push(
      issue("INVALID_SPEC", `maxStockPasses must be an integer from 0 to ${PUZZLE_LIMITS.maxStockPasses}.`),
    );
  }

  const hints = value.hints ?? [];
  if (!Array.isArray(hints)) {
    issues.push(issue("INVALID_SPEC", "Hints must be an array."));
  } else {
    if (hints.length > PUZZLE_LIMITS.maxHints) {
      issues.push(issue("LIMIT_EXCEEDED", `At most ${PUZZLE_LIMITS.maxHints} hints are supported.`));
    }
    hints.forEach((hint, index) => {
      if (!isRecord(hint) || typeof hint.text !== "string" || hint.text.trim().length === 0) {
        issues.push(issue("INVALID_SPEC", `Hint ${index + 1} needs text.`, { moveIndex: index }));
        return;
      }
      if (hint.text.length > PUZZLE_LIMITS.maxHintLength) {
        issues.push(issue("INVALID_SPEC", `Hint ${index + 1} is too long.`));
      }
      if (hint.card !== undefined && !isCard(hint.card)) {
        issues.push(issue("INVALID_SPEC", `Hint ${index + 1} has a malformed card.`));
      }
      if (hint.column !== undefined && !isIntegerInRange(hint.column, 0, TABLEAU_COLUMNS - 1)) {
        issues.push(issue("INVALID_SPEC", `Hint ${index + 1} names a column outside the tableau.`));
      }
      if (stateUsable) {
        const hidden = hiddenCards(value.startState);
        if (hint.card !== undefined && isCard(hint.card) && hidden.some((entry) => sameCard(entry, hint.card as Card))) {
          issues.push(issue("HIDDEN_INFO_LEAK", `Hint ${index + 1} names a card the player cannot see.`));
        }
        const leaked = textNamesHiddenCard(hint.text, hidden);
        if (leaked) {
          issues.push(
            issue(
              "HIDDEN_INFO_LEAK",
              `Hint ${index + 1} spells out the hidden card ${RANK_TEXT[leaked.rank]}${SUIT_GLYPH[leaked.suit]}.`,
            ),
          );
        }
      }
    });
  }

  const solutions = value.solutions;
  if (!Array.isArray(solutions)) {
    issues.push(issue("INVALID_SPEC", "Solutions must be an array."));
  } else {
    if (solutions.length === 0) {
      issues.push(issue("NO_SOLUTIONS", "A puzzle needs at least one verified solution path."));
    }
    if (solutions.length > PUZZLE_LIMITS.maxSolutions) {
      issues.push(issue("LIMIT_EXCEEDED", `At most ${PUZZLE_LIMITS.maxSolutions} solution paths are supported.`));
    }
    solutions.forEach((path, index) => {
      if (!Array.isArray(path) || path.length === 0) {
        issues.push(issue("NO_SOLUTIONS", `Solution ${index + 1} is empty.`, { pathIndex: index }));
      } else if (path.length > PUZZLE_LIMITS.maxMoves) {
        issues.push(
          issue("LIMIT_EXCEEDED", `Solution ${index + 1} is longer than ${PUZZLE_LIMITS.maxMoves} moves.`, {
            pathIndex: index,
          }),
        );
      }
    });
  }

  const verification = value.verification;
  if (
    !isRecord(verification) ||
    (verification.kind !== "verified-set" && verification.kind !== "exhaustive")
  ) {
    issues.push(issue("INVALID_SPEC", "A puzzle must state how its solutions were verified."));
  }

  return { issues, warnings };
}

/** Every card an objective refers to (for the hidden-information check). */
function objectiveCards(objective: PuzzleObjective): Card[] {
  if (!objective) return [];
  switch (objective.kind) {
    case "place-card":
    case "preserve-card":
      return isCard(objective.card) ? [objective.card] : [];
    case "all":
      return objective.objectives.flatMap((child) => objectiveCards(child));
    default:
      return [];
  }
}

/**
 * Replay ONE proposed solution and judge it against the objective.
 *
 * Returns the issues specific to that path — an illegal move at its index, an
 * exceeded constraint, or `OBJECTIVE_NOT_MET` when every move was legal but the
 * puzzle's actual goal was not reached.
 */
export function validatePuzzleSolution(
  spec: PuzzleSpec,
  moves: readonly SolitaireMove[],
): { ok: boolean; issues: PuzzleIssue[]; stats: PuzzlePathStats; finalState: SolitaireState } {
  const limits = spec?.constraints ?? {};
  const maxMoves = limits.maxMoves ?? objectiveMaxMoves(spec?.objective) ?? PUZZLE_LIMITS.maxMoves;
  const replay = replayPuzzlePath(spec.startState, moves, { ...limits, maxMoves });

  if (!replay.ok) return { ok: false, issues: replay.issues, stats: replay.stats, finalState: replay.state };

  if (!objectiveReached(spec.objective, replay.state, replay.stats)) {
    return {
      ok: false,
      issues: [
        issue("OBJECTIVE_NOT_MET", "The moves are legal, but the puzzle's objective is not reached."),
      ],
      stats: replay.stats,
      finalState: replay.state,
    };
  }

  return { ok: true, issues: [], stats: replay.stats, finalState: replay.state };
}

/**
 * The full acceptance check: static spec, then every declared solution.
 *
 * `ok` is true only when the spec is well formed AND at least one solution
 * reaches the objective AND every declared solution does (a path that does not
 * would be a false claim in the spec, so it is an error, not a warning).
 */
export function validatePuzzle(spec: unknown): PuzzleValidationResult {
  const staticCheck = validatePuzzleSpec(spec);
  const issues = [...staticCheck.issues];
  const warnings = [...staticCheck.warnings];

  if (issues.length > 0) {
    return { ok: false, issues, warnings };
  }

  const value = spec as PuzzleSpec;
  const finalStates: SolitaireState[] = [];
  const stats: PuzzlePathStats[] = [];

  value.solutions.forEach((path, index) => {
    const result = validatePuzzleSolution(value, path);
    finalStates.push(result.finalState);
    stats.push(result.stats);
    for (const entry of result.issues) issues.push({ ...entry, pathIndex: index });
  });

  let metrics: PuzzleComplexity | undefined;
  try {
    metrics = assessPuzzleComplexity(value);
    if (metrics && value.difficulty !== metrics.suggestedDifficulty) {
      warnings.push(
        issue(
          "DIFFICULTY_MISMATCH",
          `Declared difficulty ${value.difficulty} differs from the measured suggestion ${metrics.suggestedDifficulty}.`,
        ),
      );
    }
  } catch {
    // Metrics are advisory; a spec still validates without them.
  }

  return { ok: issues.length === 0, issues, warnings, finalStates, stats, metrics };
}

// ── Complexity ────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Structural complexity, measured — not authored.
 *
 * `score` is a transparent heuristic over facts a player faces (how many
 * choices, how many productive ones, how much is still hidden, how far the goal
 * is). It is explicitly UNCALIBRATED: `suggestedDifficulty` is a proposal, and a
 * declared difficulty is only ever a warning when it disagrees. Calibration needs
 * real attempt data, which this phase does not have.
 */
export function assessPuzzleComplexity(spec: PuzzleSpec): PuzzleComplexity {
  const state = spec.startState;
  const moves = legalMoves(state);
  const seen = new Set<string>();
  let branching = 0;
  let productiveMoves = 0;
  for (const move of moves) {
    const signature = puzzleMoveSignature(move);
    if (seen.has(signature)) continue;
    seen.add(signature);
    branching += 1;
    try {
      if (scoreMove(state, move) > 0) productiveMoves += 1;
    } catch {
      // A scoring failure only lowers the count; it never invalidates a puzzle.
    }
  }

  const firstMoves = new Set<string>();
  let movesToGoal: number | null = null;
  let stockPassesToGoal: number | null = null;
  for (const path of spec.solutions ?? []) {
    if (path.length > 0) firstMoves.add(puzzleMoveSignature(path[0]));
    if (movesToGoal === null || path.length < movesToGoal) movesToGoal = path.length;
  }
  // Measure the stock passes the shortest path actually takes.
  const shortest = (spec.solutions ?? []).reduce<readonly SolitaireMove[] | null>((best, path) => {
    if (!best || path.length < best.length) return path;
    return best;
  }, null);
  if (shortest) {
    const replay = replayPuzzlePath(state, shortest, spec.constraints ?? {});
    if (replay.ok) stockPassesToGoal = replay.stats.stockPasses;
  }

  const hidden = faceDownCount(state);
  const foundations = foundationCountOf(state);
  const emptyColumns = emptyColumnCount(state);
  const stockCount = state.stock?.length ?? 0;

  const score = Math.round(
    clamp(
      hidden * 1.4 +
        Math.min(branching, 12) * 1.6 +
        Math.min(productiveMoves, 8) * 2.2 +
        (emptyColumns > 0 ? 4 : 0) +
        Math.min(movesToGoal ?? 1, 12) * 0.8 +
        (stockCount > 0 ? 3 : 0),
      0,
      100,
    ),
  );

  const suggestedDifficulty: PuzzleDifficulty =
    score <= 25 ? 1 : score <= 45 ? 2 : score <= 62 ? 3 : score <= 80 ? 4 : 5;

  return {
    branching,
    productiveMoves,
    hiddenCards: hidden,
    foundationCards: foundations,
    emptyColumns,
    stockCount,
    distinctFirstMoves: firstMoves.size,
    movesToGoal,
    stockPassesToGoal,
    score,
    suggestedDifficulty,
  };
}

// ── Hidden-information projection ─────────────────────────────────────────

export type PublicPuzzleObjective =
  | { kind: "reveal-cards"; count: number }
  | { kind: "open-column"; column?: number }
  | { kind: "place-card"; card: Card; destination: PuzzlePlaceDestination }
  | { kind: "foundation-milestone"; total?: number; suit?: Suit; rank?: number }
  | { kind: "preserve-card"; card: Card; in: "tableau" }
  | { kind: "reach-state"; target: PuzzleStateTarget }
  /** The shape only: never the accepted moves. */
  | { kind: "best-move" }
  | { kind: "all"; objectives: readonly PublicPuzzleObjective[] };

export type PublicPuzzleSpec = {
  id: string;
  version: number;
  category: PuzzleCategory;
  difficulty: PuzzleDifficulty;
  objectiveText: string;
  concept: string;
  objective: PublicPuzzleObjective;
  constraints: { maxMoves?: number; maxStockPasses?: number };
  hints: readonly PuzzleHint[];
  verification: { kind: PuzzleVerification["kind"]; checkedSolutions: number };
  /** What a player may see: no stock order, no hidden identity, no solution. */
  board: SolitaireView;
};

export function publicObjective(objective: PuzzleObjective): PublicPuzzleObjective {
  switch (objective.kind) {
    case "best-move":
      return { kind: "best-move" };
    case "all":
      return { kind: "all", objectives: objective.objectives.map((child) => publicObjective(child)) };
    case "reveal-cards":
      return { kind: "reveal-cards", count: objective.count };
    case "open-column":
      return objective.column === undefined ? { kind: "open-column" } : { kind: "open-column", column: objective.column };
    case "place-card":
      return {
        kind: "place-card",
        card: { suit: objective.card.suit, rank: objective.card.rank },
        destination:
          objective.destination.kind === "foundation"
            ? { kind: "foundation", ...(objective.destination.suit ? { suit: objective.destination.suit } : {}) }
            : { kind: "tableau", column: objective.destination.column },
      };
    case "foundation-milestone":
      return {
        kind: "foundation-milestone",
        ...(objective.total !== undefined ? { total: objective.total } : {}),
        ...(objective.suit ? { suit: objective.suit } : {}),
        ...(objective.rank !== undefined ? { rank: objective.rank } : {}),
      };
    case "preserve-card":
      return { kind: "preserve-card", card: { suit: objective.card.suit, rank: objective.card.rank }, in: "tableau" };
    case "reach-state":
      return {
        kind: "reach-state",
        target: {
          ...(objective.target.foundations ? { foundations: { ...objective.target.foundations } } : {}),
          ...(objective.target.faceDown !== undefined ? { faceDown: objective.target.faceDown } : {}),
          ...(objective.target.emptyColumns !== undefined ? { emptyColumns: objective.target.emptyColumns } : {}),
          ...(objective.target.stockCount !== undefined ? { stockCount: objective.target.stockCount } : {}),
          ...(objective.target.wasteCount !== undefined ? { wasteCount: objective.target.wasteCount } : {}),
        },
      };
    default:
      return { kind: "reach-state", target: {} };
  }
}

/**
 * The client-facing puzzle.
 *
 * Built by projection, not redaction: `viewForState` already drops hidden
 * identities, and `nextStockCard` is deliberately nulled here — the duel
 * exposes it so a draw can be painted without a round trip, but a puzzle must
 * not hand out the next stock card.
 */
export function puzzlePublicSpec(spec: PuzzleSpec): PublicPuzzleSpec {
  const view = viewForState(spec.startState);
  return {
    id: spec.id,
    version: spec.version,
    category: spec.category,
    difficulty: spec.difficulty,
    objectiveText: spec.objectiveText,
    concept: spec.concept,
    objective: publicObjective(spec.objective),
    constraints: {
      ...(spec.constraints?.maxMoves !== undefined ? { maxMoves: spec.constraints.maxMoves } : {}),
      ...(spec.constraints?.maxStockPasses !== undefined
        ? { maxStockPasses: spec.constraints.maxStockPasses }
        : {}),
    },
    hints: (spec.hints ?? []).map((hint) => ({
      text: hint.text,
      ...(hint.card ? { card: { suit: hint.card.suit, rank: hint.card.rank } } : {}),
      ...(hint.column !== undefined ? { column: hint.column } : {}),
    })),
    verification: { kind: spec.verification.kind, checkedSolutions: spec.verification.checkedSolutions },
    board: { ...view, nextStockCard: null },
  };
}

// ── Legacy migration ──────────────────────────────────────────────────────

/**
 * Wrap an EXISTING one-move puzzle (`puzzleCore.Puzzle`) as a spec.
 *
 * This exists so shipped puzzles and their recorded attempts are not discarded:
 * the id stays the original `key` (e.g. `daily:2026-11-14:2`), the solution is
 * the answer the engine already proved, and the objective is `best-move` with
 * that single accepted move. Nothing about the board, the answer or the reveal
 * is recomputed, and no uniqueness is claimed.
 *
 * Hints are derived from facts that are already public: the card the best move
 * touches is visible in the starting position, so naming it leaks nothing. A
 * draw answer names no card at all.
 */
export function specFromBestMovePuzzle(
  puzzle: Puzzle,
  options: {
    category?: PuzzleCategory;
    difficulty?: PuzzleDifficulty;
    id?: string;
  } = {},
): PuzzleSpec {
  const answer = puzzle.answer;
  const objective: PuzzleObjective = { kind: "best-move", acceptedMoves: [answer] };

  const touched: Card | null =
    answer.kind === "tableau-to-tableau" ||
    answer.kind === "tableau-to-foundation"
      ? answer.card
      : answer.kind === "draw"
        ? null
        : puzzle.answerReveal?.card ?? null;

  const hints: PuzzleHint[] = [
    {
      text: puzzle.answerReveal
        ? "Look for the move that turns a face-down card over."
        : "Look for the move that improves the position without needing a fresh card.",
    },
  ];
  if (touched && isVisibleCard(puzzle.state, touched)) {
    hints.push({
      text: `The card that matters here is the ${RANK_TEXT[touched.rank]}${SUIT_GLYPH[touched.suit]}.`,
      card: { suit: touched.suit, rank: touched.rank },
    });
  } else if (answer.kind === "draw") {
    hints.push({ text: "The stock is worth a look before anything else." });
  }

  const spec: PuzzleSpec = {
    // `buildPuzzleForSeed` leaves the key empty; a puzzle that came through the
    // route always has one. The fallback keeps both forms addressable.
    id: options.id ?? (puzzle.key || `${puzzle.kind}:${puzzle.seed}`),
    version: PUZZLE_SPEC_VERSION,
    category: options.category ?? "best-move",
    difficulty: options.difficulty ?? 2,
    objective,
    objectiveText: "Find the strongest move on this board.",
    concept: puzzle.answerReveal
      ? "The best move is the one that exposes new information."
      : "Progress here is structural: the best move improves the board without a reveal.",
    startState: puzzle.state,
    constraints: { maxMoves: 1 },
    solutions: [[answer]],
    hints,
    verification: { kind: "verified-set", checkedSolutions: 1, maxMoves: 1 },
  };

  if (!options.difficulty) {
    try {
      spec.difficulty = assessPuzzleComplexity(spec).suggestedDifficulty;
    } catch {
      spec.difficulty = 2;
    }
  }

  return spec;
}

/** True when a spec still needs a supported version before it can be validated. */
export function puzzleVersionIssue(spec: unknown): PuzzleIssue | null {
  if (!isRecord(spec)) return issue("INVALID_SPEC", "The puzzle spec is missing.");
  if (!isSupportedPuzzleVersion(spec.version)) {
    return issue(
      "UNSUPPORTED_VERSION",
      `Puzzle version ${String(spec.version)} is not supported; expected ${PUZZLE_SPEC_VERSION}.`,
    );
  }
  return null;
}
