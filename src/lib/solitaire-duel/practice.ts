// src/lib/solitaire-duel/practice.ts
//
// THE INDEPENDENT PRACTICE CATALOG.
//
// Practice is a set of prepared positions that train ONE skill at a time. It is
// deliberately not a second lesson engine:
//
//   * every position is a complete 52-card `SolitaireDeal`, built by the same
//     `preparedDeal` helper the curriculum uses;
//   * every objective is a `LessonStep` predicate evaluated by the SAME engine
//     (`createLessonSession`, `applyLessonMove`, `requestLessonHint`), which
//     applies every move through the real rules authority;
//   * validation is `validateLessonDefinition` — the same function the authored
//     courses are validated with — so an exercise can never be published with a
//     malformed deal, a duplicated card, or an objective that is already true on
//     the opening board;
//   * the board, cards and move handling are the existing Solitaire components,
//     never a practice-only copy.
//
// ── WHY THE OBJECTIVES ARE STATE PREDICATES ───────────────────────────────
//
// Most drills state a target ARRANGEMENT, not a move script. Two different legal
// orders can therefore satisfy the same objective (see
// `comparing-alternative-moves`), which is exactly what an "acceptable
// solutions" list should mean. A step also carries explicit `acceptableMoves`
// so a hint can offer one legal move without the exercise claiming that move is
// the only, or the objectively best, answer.
//
// ── DIFFICULTY ────────────────────────────────────────────────────────────
//
// Difficulty is authored per exercise and describes the reasoning the drill
// asks for, not the number of cards on the board: `beginner` applies one rule to
// a visible target, `intermediate` links two placements or chooses between legal
// moves, and `advanced` needs a plan across several moves (an order that
// matters, a column to free, or a stock cycle to plan). `rationaleKey` records
// the reason for each exercise's level so it can be reviewed rather than
// guessed.
//
// ── ISOLATION ─────────────────────────────────────────────────────────────
//
// This module imports the pure engine and the deal helper only. There is no
// fetch, no rating, no trophy, no coin, no matchmaking and no AI call, so no
// practice drill can create a competitive record.

import { TABLEAU_COLUMNS } from "./constants";
import { preparedDeal } from "./lessonCatalog";
import { applyMove, initialStateFromDeal } from "./rules";
import {
  applyLessonMove,
  createLessonSession,
  requestLessonHint,
  restartLesson,
  undoLessonMove,
  validateLessonDefinition,
} from "./lessons";
import type {
  Lesson,
  LessonDifficulty,
  LessonMoveResult,
  LessonSession,
  LessonStep,
} from "./lessons";
import type { Card, PileCard, SolitaireDeal, SolitaireMove, SolitaireState } from "./types";

// ── Definition types ──────────────────────────────────────────────────────

export type PracticeCategoryId = "tableau" | "foundations" | "stock-and-waste" | "strategy";

/** The three authored levels. Same vocabulary as the lesson catalog. */
export type PracticeDifficulty = LessonDifficulty;

export const PRACTICE_DIFFICULTIES: readonly PracticeDifficulty[] = Object.freeze([
  "beginner",
  "intermediate",
  "advanced",
]);

export type PracticeCategory = {
  readonly id: PracticeCategoryId;
  readonly order: number;
  readonly titleKey: string;
  readonly descriptionKey: string;
};

export type PracticeSkill = {
  readonly id: string;
  readonly categoryId: PracticeCategoryId;
  readonly order: number;
  readonly titleKey: string;
  readonly focusKey: string;
  /** Two progressive clues; the second offers one legal move. */
  readonly hintKeys: readonly [string, string];
};

export type PracticeExercise = {
  /** Stable id; also the copy key suffix and the progress key. */
  readonly id: string;
  readonly skillId: string;
  readonly categoryId: PracticeCategoryId;
  readonly difficulty: PracticeDifficulty;
  readonly order: number;
  readonly titleKey: string;
  readonly objectiveKey: string;
  readonly explanationKey: string;
  readonly successKey: string;
  readonly rationaleKey: string;
  readonly deal: SolitaireDeal;
  readonly steps: readonly LessonStep[];
  /**
   * Authored acceptable solutions. Every line is replayed through the real
   * engine when the catalog loads, and a drill with no valid line is not shown.
   * More than one line means two different orders genuinely solve the drill.
   */
  readonly solutions: readonly (readonly SolitaireMove[])[];
  /** Optional whole-drill condition, as in a lesson. */
  readonly completion?: (state: SolitaireState) => boolean;
};

// ── Card helpers (data only, no rules) ────────────────────────────────────

const H = (rank: number): Card => ({ suit: "hearts", rank: rank as Card["rank"] });
const D = (rank: number): Card => ({ suit: "diamonds", rank: rank as Card["rank"] });
const S = (rank: number): Card => ({ suit: "spades", rank: rank as Card["rank"] });
const C = (rank: number): Card => ({ suit: "clubs", rank: rank as Card["rank"] });

const up = (card: Card): PileCard => ({ card, faceUp: true });
const down = (card: Card): PileCard => ({ card, faceUp: false });

/** Normalise a prepared tableau to the seven real columns. */
function columns(...prepared: PileCard[][]): PileCard[][] {
  const board = prepared.map((column) => [...column]);
  while (board.length < TABLEAU_COLUMNS) board.push([]);
  return board;
}

function deal(
  tableau: PileCard[][],
  options: { drawOrder?: readonly Card[]; padTableau?: boolean } = {},
): SolitaireDeal {
  return preparedDeal({
    tableau,
    drawOrder: options.drawOrder ?? [],
    padTableau: options.padTableau ?? false,
  });
}

function topCard(state: SolitaireState, column: number): Card | null {
  const pile = state.tableau[column];
  if (!pile || pile.length === 0) return null;
  const slot = pile[pile.length - 1];
  return slot.faceUp ? slot.card : null;
}

function is(card: Card | null, suit: Card["suit"], rank: number): boolean {
  return Boolean(card) && card!.suit === suit && card!.rank === rank;
}

function runIs(state: SolitaireState, column: number, cards: readonly Card[]): boolean {
  const pile = state.tableau[column] ?? [];
  if (pile.length !== cards.length) return false;
  return cards.every((card, index) => {
    const slot = pile[index];
    return slot.faceUp && is(slot.card, card.suit, card.rank);
  });
}

function columnEmpty(state: SolitaireState, column: number): boolean {
  return (state.tableau[column]?.length ?? 0) === 0;
}

// ── Skill map ─────────────────────────────────────────────────────────────

type SkillSeed = {
  readonly id: string;
  readonly categoryId: PracticeCategoryId;
};

const SKILL_SEEDS: readonly SkillSeed[] = Object.freeze([
  { id: "alternating-colors", categoryId: "tableau" },
  { id: "descending-sequences", categoryId: "tableau" },
  { id: "moving-runs", categoryId: "tableau" },
  { id: "reveal-hidden-cards", categoryId: "tableau" },
  { id: "opening-empty-columns", categoryId: "tableau" },
  { id: "managing-kings", categoryId: "tableau" },
  { id: "foundation-timing", categoryId: "foundations" },
  { id: "keeping-tableau-cards", categoryId: "foundations" },
  { id: "efficient-foundations", categoryId: "foundations" },
  { id: "stock-draw-decisions", categoryId: "stock-and-waste" },
  { id: "waste-pile-management", categoryId: "stock-and-waste" },
  { id: "stock-cycle-planning", categoryId: "stock-and-waste" },
  { id: "planning-ahead", categoryId: "strategy" },
  { id: "choosing-reveals", categoryId: "strategy" },
  { id: "avoiding-blocked-positions", categoryId: "strategy" },
  { id: "comparing-alternative-moves", categoryId: "strategy" },
]);

export const PRACTICE_CATEGORIES: readonly PracticeCategory[] = Object.freeze([
  {
    id: "tableau",
    order: 1,
    titleKey: "learn.practice.categories.tableau.title",
    descriptionKey: "learn.practice.categories.tableau.description",
  },
  {
    id: "foundations",
    order: 2,
    titleKey: "learn.practice.categories.foundations.title",
    descriptionKey: "learn.practice.categories.foundations.description",
  },
  {
    id: "stock-and-waste",
    order: 3,
    titleKey: "learn.practice.categories.stock-and-waste.title",
    descriptionKey: "learn.practice.categories.stock-and-waste.description",
  },
  {
    id: "strategy",
    order: 4,
    titleKey: "learn.practice.categories.strategy.title",
    descriptionKey: "learn.practice.categories.strategy.description",
  },
]);

export const PRACTICE_SKILLS: readonly PracticeSkill[] = Object.freeze(
  (["tableau", "foundations", "stock-and-waste", "strategy"] as const).flatMap((categoryId) =>
    SKILL_SEEDS.filter((seed) => seed.categoryId === categoryId).map((seed, index) => ({
      id: seed.id,
      categoryId,
      order: index + 1,
      titleKey: `learn.practice.skills.${seed.id}.title`,
      focusKey: `learn.practice.skills.${seed.id}.focus`,
      hintKeys: [
        `learn.practice.skills.${seed.id}.hint1`,
        `learn.practice.skills.${seed.id}.hint2`,
      ] as const,
    })),
  ),
);

export const PRACTICE_SKILL_BY_ID: Readonly<Record<string, PracticeSkill>> = Object.freeze(
  Object.fromEntries(PRACTICE_SKILLS.map((skill) => [skill.id, skill])),
);

// ── Exercise build helpers ────────────────────────────────────────────────

/**
 * One objective step, with copy namespaced by the exercise id.
 *
 * A hint never names a move unless it is the second (solution) hint, and even
 * then the engine re-checks the move against the live board before offering it.
 */
function objective(
  exerciseId: string,
  skillId: string,
  done: (state: SolitaireState) => boolean,
  acceptableMoves: readonly SolitaireMove[],
): LessonStep {
  return {
    id: "objective",
    instructionKey: `learn.practice.exercises.${exerciseId}.objective`,
    explanationKey: `learn.practice.exercises.${exerciseId}.explanation`,
    incorrectKey: "learn.practice.feedbackOffGoal",
    done,
    acceptableMoves,
    hints: [
      { textKey: `learn.practice.skills.${skillId}.hint1` },
      { textKey: `learn.practice.skills.${skillId}.hint2`, revealsSolution: true },
    ],
  };
}

type ExerciseSeed = Omit<
  PracticeExercise,
  | "categoryId"
  | "titleKey"
  | "objectiveKey"
  | "explanationKey"
  | "successKey"
  | "rationaleKey"
  | "solutions"
> & {
  readonly solutions?: readonly (readonly SolitaireMove[])[];
  readonly lessonCopy?: {
    readonly titleKey?: string;
    readonly objectiveKey?: string;
    readonly explanationKey?: string;
    readonly successKey?: string;
    readonly rationaleKey?: string;
  };
};

function exercise(seed: ExerciseSeed): PracticeExercise {
  const skill = PRACTICE_SKILL_BY_ID[seed.skillId];
  if (!skill) throw new Error(`Practice exercise "${seed.id}" has no skill "${seed.skillId}".`);
  const base = `learn.practice.exercises.${seed.id}`;
  return {
    ...seed,
    categoryId: skill.categoryId,
    solutions: seed.solutions ?? SOLUTIONS[seed.id] ?? [],
    titleKey: seed.lessonCopy?.titleKey ?? `${base}.title`,
    objectiveKey: seed.lessonCopy?.objectiveKey ?? `${base}.objective`,
    explanationKey: seed.lessonCopy?.explanationKey ?? `${base}.explanation`,
    successKey: seed.lessonCopy?.successKey ?? `${base}.success`,
    rationaleKey: seed.lessonCopy?.rationaleKey ?? `${base}.rationale`,
  };
}

// ── Acceptable solutions ──────────────────────────────────────────────────
//
// One authored line per drill (two where the order genuinely does not matter).
// These are not "the optimal line": they are proven-legal lines that reach the
// objective, which is what makes the drill solvable and lets a hint offer a
// checked move instead of a guess.

const SOLUTIONS: Readonly<Record<string, readonly (readonly SolitaireMove[])[]>> = Object.freeze({
  "alternating-colors": [[{ kind: "tableau-to-tableau", fromColumn: 1, card: H(7), toColumn: 0 }]],
  "alternating-colors-two": [
    [
      { kind: "tableau-to-tableau", fromColumn: 1, card: H(8), toColumn: 0 },
      { kind: "tableau-to-tableau", fromColumn: 3, card: C(7), toColumn: 0 },
    ],
  ],
  "descending-sequences": [[{ kind: "tableau-to-tableau", fromColumn: 1, card: S(6), toColumn: 0 }]],
  "moving-runs": [[{ kind: "tableau-to-tableau", fromColumn: 0, card: D(10), toColumn: 1 }]],
  "moving-runs-two": [
    [
      { kind: "tableau-to-tableau", fromColumn: 1, card: S(12), toColumn: 0 },
      { kind: "tableau-to-tableau", fromColumn: 2, card: C(10), toColumn: 0 },
    ],
  ],
  "reveal-hidden-cards": [[{ kind: "tableau-to-tableau", fromColumn: 0, card: H(3), toColumn: 1 }]],
  "opening-empty-columns": [
    [
      { kind: "tableau-to-tableau", fromColumn: 0, card: H(13), toColumn: 6 },
      { kind: "tableau-to-tableau", fromColumn: 1, card: S(12), toColumn: 6 },
    ],
    [
      { kind: "tableau-to-tableau", fromColumn: 1, card: S(12), toColumn: 0 },
      { kind: "tableau-to-tableau", fromColumn: 0, card: H(13), toColumn: 6 },
    ],
  ],
  "managing-kings": [
    [
      { kind: "tableau-to-tableau", fromColumn: 0, card: S(13), toColumn: 6 },
      { kind: "tableau-to-tableau", fromColumn: 1, card: D(13), toColumn: 0 },
    ],
  ],
  "foundation-timing": [
    [
      { kind: "tableau-to-foundation", fromColumn: 0, card: H(1), suit: "hearts" },
      { kind: "tableau-to-foundation", fromColumn: 1, card: H(2), suit: "hearts" },
    ],
  ],
  "keeping-tableau-cards": [
    [
      { kind: "tableau-to-foundation", fromColumn: 0, card: H(1), suit: "hearts" },
      { kind: "tableau-to-foundation", fromColumn: 1, card: H(2), suit: "hearts" },
      { kind: "tableau-to-tableau", fromColumn: 3, card: S(2), toColumn: 2 },
    ],
  ],
  "efficient-foundations": [
    [
      { kind: "tableau-to-foundation", fromColumn: 0, card: H(1), suit: "hearts" },
      { kind: "tableau-to-foundation", fromColumn: 1, card: H(2), suit: "hearts" },
      { kind: "tableau-to-foundation", fromColumn: 2, card: H(3), suit: "hearts" },
    ],
  ],
  "stock-draw-decisions": [
    [{ kind: "draw" }, { kind: "waste-to-tableau", toColumn: 0 }],
  ],
  "waste-pile-management": [
    [
      { kind: "draw" },
      { kind: "waste-to-tableau", toColumn: 0 },
      { kind: "draw" },
      { kind: "waste-to-tableau", toColumn: 0 },
    ],
  ],
  "stock-cycle-planning": [
    [
      { kind: "draw" },
      { kind: "draw" },
      { kind: "draw" },
      { kind: "draw" },
      { kind: "waste-to-tableau", toColumn: 0 },
    ],
  ],
  "planning-ahead": [
    [
      { kind: "tableau-to-tableau", fromColumn: 0, card: H(5), toColumn: 1 },
      { kind: "tableau-to-tableau", fromColumn: 0, card: D(6), toColumn: 2 },
    ],
  ],
  "choosing-reveals": [
    [
      { kind: "tableau-to-tableau", fromColumn: 0, card: H(7), toColumn: 2 },
      { kind: "tableau-to-tableau", fromColumn: 1, card: S(7), toColumn: 3 },
    ],
    [
      { kind: "tableau-to-tableau", fromColumn: 1, card: S(7), toColumn: 3 },
      { kind: "tableau-to-tableau", fromColumn: 0, card: H(7), toColumn: 2 },
    ],
  ],
  "avoiding-blocked-positions": [
    [
      { kind: "tableau-to-tableau", fromColumn: 0, card: S(7), toColumn: 1 },
      { kind: "tableau-to-tableau", fromColumn: 0, card: C(8), toColumn: 2 },
    ],
  ],
  "comparing-alternative-moves": [
    [
      { kind: "tableau-to-tableau", fromColumn: 1, card: S(6), toColumn: 0 },
      { kind: "tableau-to-tableau", fromColumn: 2, card: D(5), toColumn: 0 },
    ],
    [
      { kind: "tableau-to-tableau", fromColumn: 2, card: D(5), toColumn: 1 },
      { kind: "tableau-to-tableau", fromColumn: 1, card: S(6), toColumn: 0 },
    ],
  ],
});

// ── The authored exercises ────────────────────────────────────────────────

const EXERCISES: readonly PracticeExercise[] = Object.freeze([
  // ── Tableau ─────────────────────────────────────────────────────────────
  exercise({
    id: "alternating-colors",
    skillId: "alternating-colors",
    difficulty: "beginner",
    order: 1,
    deal: deal(columns([up(S(8))], [up(H(7))], [up(C(7))])),
    steps: [
      objective(
        "alternating-colors",
        "alternating-colors",
        (state) => state.tableau[0].length === 2 && is(topCard(state, 0), "hearts", 7),
        [{ kind: "tableau-to-tableau", fromColumn: 1, card: H(7), toColumn: 0 }],
      ),
    ],
  }),

  exercise({
    id: "alternating-colors-two",
    skillId: "alternating-colors",
    difficulty: "intermediate",
    order: 2,
    deal: deal(columns([up(S(9))], [up(H(8))], [up(C(8))], [up(C(7))])),
    steps: [
      objective(
        "alternating-colors-two",
        "alternating-colors",
        (state) =>
          runIs(state, 0, [S(9), H(8), C(7)]) &&
          columnEmpty(state, 1) &&
          columnEmpty(state, 3),
        // Two placements in either order: the objective is the arrangement, so
        // no single move can complete it (and none is listed as acceptable).
        [],
      ),
    ],
  }),

  exercise({
    id: "descending-sequences",
    skillId: "descending-sequences",
    difficulty: "beginner",
    order: 1,
    deal: deal(columns([up(H(7))], [up(S(6))])),
    steps: [
      objective(
        "descending-sequences",
        "descending-sequences",
        (state) => runIs(state, 0, [H(7), S(6)]) && columnEmpty(state, 1),
        [{ kind: "tableau-to-tableau", fromColumn: 1, card: S(6), toColumn: 0 }],
      ),
    ],
  }),

  exercise({
    id: "moving-runs",
    skillId: "moving-runs",
    difficulty: "intermediate",
    order: 1,
    deal: deal(columns([up(D(10)), up(S(9)), up(H(8))], [up(S(11))])),
    steps: [
      objective(
        "moving-runs",
        "moving-runs",
        (state) => runIs(state, 1, [S(11), D(10), S(9), H(8)]) && columnEmpty(state, 0),
        [{ kind: "tableau-to-tableau", fromColumn: 0, card: D(10), toColumn: 1 }],
      ),
    ],
  }),

  exercise({
    id: "moving-runs-two",
    skillId: "moving-runs",
    difficulty: "advanced",
    order: 2,
    deal: deal(columns([up(H(13))], [up(S(12)), up(D(11))], [up(C(10))])),
    steps: [
      objective(
        "moving-runs-two",
        "moving-runs",
        (state) =>
          runIs(state, 0, [H(13), S(12), D(11), C(10)]) &&
          columnEmpty(state, 1) &&
          columnEmpty(state, 2),
        [],
      ),
    ],
  }),

  exercise({
    id: "reveal-hidden-cards",
    skillId: "reveal-hidden-cards",
    difficulty: "beginner",
    order: 1,
    deal: deal(columns([down(D(4)), up(H(3))], [up(S(4))])),
    steps: [
      objective(
        "reveal-hidden-cards",
        "reveal-hidden-cards",
        (state) =>
          state.tableau[0].length === 1 &&
          state.tableau[0][0].faceUp === true &&
          is(state.tableau[0][0].card, "diamonds", 4) &&
          runIs(state, 1, [S(4), H(3)]),
        [{ kind: "tableau-to-tableau", fromColumn: 0, card: H(3), toColumn: 1 }],
      ),
    ],
  }),

  exercise({
    id: "opening-empty-columns",
    skillId: "opening-empty-columns",
    difficulty: "intermediate",
    order: 1,
    deal: deal(columns([up(H(13))], [up(S(12))])),
    steps: [
      objective(
        "opening-empty-columns",
        "opening-empty-columns",
        (state) =>
          runIs(state, 6, [H(13), S(12)]) &&
          columnEmpty(state, 0) &&
          columnEmpty(state, 1),
        [],
      ),
    ],
  }),

  exercise({
    id: "managing-kings",
    skillId: "managing-kings",
    difficulty: "advanced",
    order: 1,
    deal: deal(
      columns([up(S(13)), up(H(12)), up(C(11))], [up(D(13)), up(C(12))]),
    ),
    steps: [
      objective(
        "managing-kings",
        "managing-kings",
        (state) =>
          runIs(state, 6, [S(13), H(12), C(11)]) &&
          runIs(state, 0, [D(13), C(12)]) &&
          columnEmpty(state, 1),
        [],
      ),
    ],
  }),

  // ── Foundations ─────────────────────────────────────────────────────────
  exercise({
    id: "foundation-timing",
    skillId: "foundation-timing",
    difficulty: "beginner",
    order: 1,
    deal: deal(columns([up(H(1))], [up(H(2))])),
    steps: [
      objective(
        "foundation-timing",
        "foundation-timing",
        (state) => state.foundations.hearts.length === 2,
        [],
      ),
    ],
  }),

  exercise({
    id: "keeping-tableau-cards",
    skillId: "keeping-tableau-cards",
    difficulty: "advanced",
    order: 1,
    deal: deal(columns([up(H(1))], [up(H(2))], [up(H(3))], [up(S(2))])),
    steps: [
      objective(
        "keeping-tableau-cards",
        "keeping-tableau-cards",
        (state) =>
          state.foundations.hearts.length === 2 &&
          runIs(state, 2, [H(3), S(2)]) &&
          columnEmpty(state, 3),
        [],
      ),
    ],
  }),

  exercise({
    id: "efficient-foundations",
    skillId: "efficient-foundations",
    difficulty: "intermediate",
    order: 1,
    deal: deal(columns([up(H(1))], [up(H(2))], [up(H(3))])),
    steps: [
      objective(
        "efficient-foundations",
        "efficient-foundations",
        (state) => state.foundations.hearts.length === 3,
        [],
      ),
    ],
  }),

  // ── Stock and waste ─────────────────────────────────────────────────────
  exercise({
    id: "stock-draw-decisions",
    skillId: "stock-draw-decisions",
    difficulty: "beginner",
    order: 1,
    deal: deal(columns([up(H(5))]), { drawOrder: [S(4)] }),
    steps: [
      objective(
        "stock-draw-decisions",
        "stock-draw-decisions",
        (state) => runIs(state, 0, [H(5), S(4)]) && state.waste.length === 0,
        [],
      ),
    ],
  }),

  exercise({
    id: "waste-pile-management",
    skillId: "waste-pile-management",
    difficulty: "intermediate",
    order: 1,
    deal: deal(columns([up(H(8))]), { drawOrder: [C(7), D(6)] }),
    steps: [
      objective(
        "waste-pile-management",
        "waste-pile-management",
        (state) => runIs(state, 0, [H(8), C(7), D(6)]) && state.waste.length === 0,
        [],
      ),
    ],
  }),

  exercise({
    id: "stock-cycle-planning",
    skillId: "stock-cycle-planning",
    difficulty: "advanced",
    order: 1,
    // The remaining deck is padded face-down beneath the tableau so the stock
    // holds exactly the two cards this drill needs.
    deal: deal(columns([up(H(9))]), { drawOrder: [S(8), C(2)], padTableau: true }),
    steps: [
      objective(
        "stock-cycle-planning",
        "stock-cycle-planning",
        // A recycle leaves the SAME board as a direct draw, so the only honest
        // way to require a full cycle is a minimum move count in the objective.
        (state) =>
          state.ply >= 5 &&
          is(topCard(state, 0), "spades", 8) &&
          state.stock.length === 1 &&
          state.waste.length === 0,
        [],
      ),
    ],
  }),

  // ── Strategy ────────────────────────────────────────────────────────────
  exercise({
    id: "planning-ahead",
    skillId: "planning-ahead",
    difficulty: "intermediate",
    order: 1,
    deal: deal(columns([down(D(6)), up(H(5))], [up(S(6))], [up(C(7))])),
    steps: [
      objective(
        "planning-ahead",
        "planning-ahead",
        // The 6 leaves the column empty: the drill is about freeing it and
        // placing it, not about what remains behind.
        (state) => runIs(state, 2, [C(7), D(6)]) && columnEmpty(state, 0),
        [],
      ),
    ],
  }),

  exercise({
    id: "choosing-reveals",
    skillId: "choosing-reveals",
    difficulty: "intermediate",
    order: 1,
    deal: deal(
      columns([down(D(8)), up(H(7))], [down(C(8)), up(S(7))], [up(S(8))], [up(H(8))]),
    ),
    steps: [
      objective(
        "choosing-reveals",
        "choosing-reveals",
        (state) => state.tableau[0][0]?.faceUp === true && state.tableau[1][0]?.faceUp === true,
        [],
      ),
    ],
  }),

  exercise({
    id: "avoiding-blocked-positions",
    skillId: "avoiding-blocked-positions",
    difficulty: "advanced",
    order: 1,
    deal: deal(columns([down(C(8)), up(S(7))], [up(H(8))], [up(D(9))])),
    steps: [
      objective(
        "avoiding-blocked-positions",
        "avoiding-blocked-positions",
        (state) => runIs(state, 2, [D(9), C(8)]) && columnEmpty(state, 0),
        [],
      ),
    ],
  }),

  exercise({
    id: "comparing-alternative-moves",
    skillId: "comparing-alternative-moves",
    difficulty: "advanced",
    order: 1,
    deal: deal(columns([up(H(7))], [up(S(6))], [up(D(5))])),
    steps: [
      objective(
        "comparing-alternative-moves",
        "comparing-alternative-moves",
        (state) =>
          runIs(state, 0, [H(7), S(6), D(5)]) &&
          columnEmpty(state, 1) &&
          columnEmpty(state, 2),
        [],
      ),
    ],
  }),
]);

// ── Validation gate ───────────────────────────────────────────────────────

/**
 * Wrap one exercise as a `Lesson` so the EXISTING engine can run it.
 *
 * The synthetic id namespaces practice, and `courseId` is derived from the
 * category. Nothing here is written to lesson progress: practice has its own
 * record (`practiceProgress.ts`).
 */
export function practiceExerciseLesson(exercise: PracticeExercise): Lesson {
  return {
    id: `practice:${exercise.id}`,
    courseId: `practice:${exercise.categoryId}`,
    order: exercise.order,
    titleKey: exercise.titleKey,
    descriptionKey: exercise.objectiveKey,
    difficulty: exercise.difficulty,
    estimatedMinutes: 1,
    deal: exercise.deal,
    steps: exercise.steps,
    completion: exercise.completion,
    successKey: exercise.successKey,
  };
}

/** Stable identity for comparing an authored move with the engine's log. */
function moveIdentity(move: SolitaireMove): string {
  const card = "card" in move && move.card ? `${move.card.suit}-${move.card.rank}` : "";
  return [
    move.kind,
    "fromColumn" in move ? move.fromColumn : "",
    "toColumn" in move ? move.toColumn : "",
    "suit" in move ? move.suit : "",
    card,
  ].join("|");
}

/**
 * Replay one authored solution through the real engine.
 *
 * This is what makes "validated exercise" mean something: the drill must be
 * solvable by a legal line that actually satisfies its own objective, not just
 * a well-shaped position.
 */
function solutionCompletesExercise(
  exercise: PracticeExercise,
  solution: readonly SolitaireMove[],
): boolean {
  if (solution.length === 0) return false;
  let state = initialStateFromDeal(exercise.deal);
  for (const move of solution) {
    const applied = applyMove({ state, move });
    if (!applied.ok) return false;
    state = applied.state;
  }
  if (!exercise.steps.every((step) => step.done(state))) return false;
  return !exercise.completion || exercise.completion(state);
}

/**
 * Only definitions that pass the lesson validator AND have a proven solution are
 * ever exposed to the UI. A malformed or unsolvable drill disappears from
 * Practice rather than being offered as teaching material.
 */
function isValidExercise(exercise: PracticeExercise): boolean {
  try {
    if (!validateLessonDefinition(practiceExerciseLesson(exercise)).ok) return false;
    return exercise.solutions.some((solution) =>
      solutionCompletesExercise(exercise, solution),
    );
  } catch {
    return false;
  }
}

export const VALIDATED_PRACTICE_EXERCISES: readonly PracticeExercise[] = Object.freeze(
  EXERCISES.filter(isValidExercise),
);

const EXERCISE_BY_ID: Readonly<Record<string, PracticeExercise>> = Object.freeze(
  Object.fromEntries(VALIDATED_PRACTICE_EXERCISES.map((entry) => [entry.id, entry])),
);

// ── Selection helpers (what the page is allowed to show) ──────────────────

const CATEGORY_ORDER: Readonly<Record<PracticeCategoryId, number>> = Object.freeze({
  tableau: 1,
  foundations: 2,
  "stock-and-waste": 3,
  strategy: 4,
});

/** Categories are shown only when at least one validated exercise exists. */
export function practiceCategories(): readonly PracticeCategory[] {
  return PRACTICE_CATEGORIES.filter((category) =>
    VALIDATED_PRACTICE_EXERCISES.some((exercise) => exercise.categoryId === category.id),
  ).sort((a, b) => a.order - b.order);
}

export function practiceSkillsForCategory(
  categoryId: PracticeCategoryId,
): readonly PracticeSkill[] {
  return PRACTICE_SKILLS.filter(
    (skill) =>
      skill.categoryId === categoryId &&
      VALIDATED_PRACTICE_EXERCISES.some((exercise) => exercise.skillId === skill.id),
  ).sort((a, b) => a.order - b.order);
}

export function practiceSkill(skillId: string): PracticeSkill | null {
  return PRACTICE_SKILL_BY_ID[skillId] ?? null;
}

/** Difficulties that actually have a validated exercise for this skill. */
export function practiceDifficultiesFor(skillId: string): readonly PracticeDifficulty[] {
  return PRACTICE_DIFFICULTIES.filter((difficulty) =>
    VALIDATED_PRACTICE_EXERCISES.some(
      (exercise) => exercise.skillId === skillId && exercise.difficulty === difficulty,
    ),
  );
}

export function practiceExercisesFor(
  skillId: string,
  difficulty?: PracticeDifficulty,
): readonly PracticeExercise[] {
  return VALIDATED_PRACTICE_EXERCISES.filter(
    (exercise) =>
      exercise.skillId === skillId &&
      (difficulty === undefined || exercise.difficulty === difficulty),
  ).sort((a, b) => a.order - b.order);
}

export function practiceExerciseCount(
  skillId: string,
  difficulty?: PracticeDifficulty,
): number {
  return practiceExercisesFor(skillId, difficulty).length;
}

export function practiceCategoryCount(categoryId: PracticeCategoryId): number {
  return VALIDATED_PRACTICE_EXERCISES.filter((exercise) => exercise.categoryId === categoryId)
    .length;
}

export function findPracticeExercise(exerciseId: string): PracticeExercise | null {
  return EXERCISE_BY_ID[exerciseId] ?? null;
}

/**
 * Deterministic rotation for "Try another exercise".
 *
 * The list is ordered by category, then skill, then exercise, so the next drill
 * is stable and testable. When the filtered list holds one exercise, the same
 * drill is returned: practice is explicitly repeatable.
 */
export function nextPracticeExercise(
  exerciseId: string,
  difficulty?: PracticeDifficulty,
): PracticeExercise | null {
  const pool = VALIDATED_PRACTICE_EXERCISES.filter(
    (exercise) => difficulty === undefined || exercise.difficulty === difficulty,
  ).sort((a, b) => {
    const category = CATEGORY_ORDER[a.categoryId] - CATEGORY_ORDER[b.categoryId];
    if (category !== 0) return category;
    const skill = (PRACTICE_SKILL_BY_ID[a.skillId]?.order ?? 0) -
      (PRACTICE_SKILL_BY_ID[b.skillId]?.order ?? 0);
    if (skill !== 0) return skill;
    return a.order - b.order;
  });
  if (pool.length === 0) return null;
  const index = pool.findIndex((entry) => entry.id === exerciseId);
  return index < 0 ? pool[0] : pool[(index + 1) % pool.length];
}

/** Catalog facts for the UI and the report; every count comes from validated data. */
export function practiceCatalogSummary(): {
  total: number;
  byDifficulty: Record<PracticeDifficulty, number>;
  byCategory: Record<PracticeCategoryId, number>;
  bySkill: Record<string, number>;
} {
  const byDifficulty = { beginner: 0, intermediate: 0, advanced: 0 };
  const byCategory = { tableau: 0, foundations: 0, "stock-and-waste": 0, strategy: 0 };
  const bySkill: Record<string, number> = {};
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    byDifficulty[exercise.difficulty] += 1;
    byCategory[exercise.categoryId] += 1;
    bySkill[exercise.skillId] = (bySkill[exercise.skillId] ?? 0) + 1;
  }
  return { total: VALIDATED_PRACTICE_EXERCISES.length, byDifficulty, byCategory, bySkill };
}

// ── Session helpers (thin delegation to the lesson engine) ────────────────

export function createPracticeSession(exercise: PracticeExercise): LessonSession {
  return createLessonSession(practiceExerciseLesson(exercise));
}

export function applyPracticeMove(session: LessonSession, move: unknown): LessonMoveResult {
  return applyLessonMove(session, move);
}

export function requestPracticeHint(session: LessonSession) {
  return requestLessonHint(session);
}

export function restartPractice(session: LessonSession): LessonSession {
  return restartLesson(session);
}

export function undoPracticeMove(session: LessonSession): LessonSession {
  return undoLessonMove(session);
}

/**
 * The next move of a proven solution line, or null.
 *
 * Only the line the player is currently following is offered, and the move is
 * re-checked against the live board first, so a hint can never suggest an
 * illegal move or claim a unique optimum. The UI presents this as "one checked
 * way forward", never as "the best move".
 */
export function practiceSolutionMove(
  exercise: PracticeExercise,
  session: LessonSession,
): SolitaireMove | null {
  for (const solution of exercise.solutions) {
    if (solution.length <= session.log.length) continue;
    const followsLine = session.log.every(
      (entry, index) => moveIdentity(entry.move) === moveIdentity(solution[index]),
    );
    if (!followsLine) continue;
    const candidate = solution[session.log.length];
    if (applyMove({ state: session.state, move: candidate }).ok) return candidate;
  }
  return null;
}
