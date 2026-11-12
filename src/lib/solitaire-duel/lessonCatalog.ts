// src/lib/solitaire-duel/lessonCatalog.ts
//
// THE AUTHORED LESSON CATALOG — five courses, twenty playable exercises.
//
// These are data, not UI. Each lesson names a complete 52-card prepared
// position, ordered state-based objectives and progressive hints. All of the
// execution lives in `lessons.ts`; no component hardcodes a lesson.
//
// The deal helpers only choose cards. Every prepared position is a complete
// unique deck, and every objective is evaluated against the REAL rules engine.
// Verification lives in tests/solitaire-lessons.test.mjs: every deal is a unique
// full deck, every step starts unmet, every hint resolves, and every canonical
// line is played through `applyLessonMove`.

import { SUITS } from "./constants";
import type {
  Lesson,
  LessonCourse,
  LessonDifficulty,
  LessonStep,
} from "./lessons";
import type { Card, PileCard, SolitaireDeal, SolitaireMove, Suit } from "./types";

const card = (suit: Suit, rank: number): Card => ({
  suit,
  rank: rank as Card["rank"],
});

const H = (rank: number) => card("hearts", rank);
const D = (rank: number) => card("diamonds", rank);
const S = (rank: number) => card("spades", rank);
const C = (rank: number) => card("clubs", rank);

const up = (value: Card): PileCard => ({ card: value, faceUp: true });
const down = (value: Card): PileCard => ({ card: value, faceUp: false });

const keyOf = (value: Card): string => `${value.suit}-${value.rank}`;

/** Every card of the standard deck except the prepared ones (stable order). */
function remainingDeck(excluded: readonly Card[]): Card[] {
  const used = new Set(excluded.map(keyOf));
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) {
      const value = card(suit, rank);
      if (!used.has(keyOf(value))) deck.push(value);
    }
  }
  return deck;
}

/**
 * Build a full deal from a prepared tableau.
 *
 * `drawOrder` lists the next cards in the order they are drawn. The stock is
 * bottom→top, so the first entry becomes the last element.
 *
 * `padTableau` is only for the stock-cycle exercise: the remaining deck is
 * placed face-down beneath the prepared tableau cards so the stock can hold
 * exactly the cards that exercise needs. Elsewhere the rest of the deck stays
 * in the stock, as in a real deal.
 */
function preparedDeal({
  tableau,
  drawOrder = [],
  padTableau = false,
}: {
  tableau: PileCard[][];
  drawOrder?: readonly Card[];
  padTableau?: boolean;
}): SolitaireDeal {
  const used = [
    ...tableau.flatMap((column) => column.map((slot) => slot.card!)),
    ...drawOrder,
  ];
  const rest = remainingDeck(used);
  const board = tableau.map((column) => [...column]);

  if (padTableau) {
    rest.forEach((value, index) => {
      board[index % board.length].unshift(down(value));
    });
  }

  return {
    variant: "klondike-1",
    variantVersion: 3,
    tableau: board,
    stock: padTableau
      ? [...drawOrder].reverse()
      : [...rest, ...[...drawOrder].reverse()],
  };
}

/** Build a step whose copy is namespaced by the lesson and step ids. */
function step(
  lessonId: string,
  id: string,
  done: (state: Parameters<LessonStep["done"]>[0]) => boolean,
  acceptableMoves: readonly SolitaireMove[] = [],
): LessonStep {
  const base = `learn.lessons.${lessonId}.step.${id}`;
  return {
    id,
    instructionKey: `${base}.instruction`,
    explanationKey: `${base}.explanation`,
    incorrectKey: `${base}.incorrect`,
    done,
    acceptableMoves,
    hints: [
      { textKey: `${base}.hint1` },
      { textKey: `${base}.hint2`, revealsSolution: true },
    ],
  };
}

/** Build lesson metadata with the catalog's stable translation-key scheme. */
function lesson({
  id,
  courseId,
  order,
  difficulty,
  estimatedMinutes,
  deal,
  steps,
}: {
  id: string;
  courseId: string;
  order: number;
  difficulty: LessonDifficulty;
  estimatedMinutes: number;
  deal: SolitaireDeal;
  steps: readonly LessonStep[];
}): Lesson {
  return {
    id,
    courseId,
    order,
    titleKey: `learn.lessons.${id}.title`,
    descriptionKey: `learn.lessons.${id}.description`,
    difficulty,
    estimatedMinutes,
    deal,
    steps,
    successKey: `learn.lessons.${id}.success`,
  };
}

// ── Course 1 — Understanding the Board ────────────────────────────────────

const TABLEAU_BASICS = lesson({
  id: "tableau-basics",
  courseId: "board-basics",
  order: 1,
  difficulty: "beginner",
  estimatedMinutes: 2,
  deal: preparedDeal({
    tableau: [
      [up(H(10))],
      [up(D(10))],
      [up(C(9))],
      [up(S(13))],
      [up(H(12))],
      [up(C(11))],
      [up(D(8))],
    ],
  }),
  steps: [
    step(
      "tableau-basics",
      "place-nine",
      (state) =>
        (state.tableau[0].length === 2 &&
          state.tableau[0][1]?.card?.suit === "clubs" &&
          state.tableau[0][1]?.card?.rank === 9) ||
        (state.tableau[1].length === 2 &&
          state.tableau[1][1]?.card?.suit === "clubs" &&
          state.tableau[1][1]?.card?.rank === 9),
      [
        { kind: "tableau-to-tableau", fromColumn: 2, card: C(9), toColumn: 0 },
        { kind: "tableau-to-tableau", fromColumn: 2, card: C(9), toColumn: 1 },
      ],
    ),
  ],
});

const FIRST_DRAW = lesson({
  id: "first-draw",
  courseId: "board-basics",
  order: 2,
  difficulty: "beginner",
  estimatedMinutes: 3,
  deal: preparedDeal({
    tableau: [
      [up(H(1))],
      [up(S(13))],
      [up(H(12))],
      [up(C(11))],
      [up(D(10))],
      [up(S(9))],
      [up(H(8))],
    ],
    drawOrder: [H(2)],
  }),
  steps: [
    step(
      "first-draw",
      "draw",
      (state) => state.waste.length >= 1,
      [{ kind: "draw" }],
    ),
    step(
      "first-draw",
      "ace",
      (state) => state.foundations.hearts.length >= 1,
      [
        {
          kind: "tableau-to-foundation",
          fromColumn: 0,
          card: H(1),
          suit: "hearts",
        },
      ],
    ),
    step(
      "first-draw",
      "two",
      (state) => state.foundations.hearts.length >= 2,
      [{ kind: "waste-to-foundation", suit: "hearts" }],
    ),
  ],
});

const BUILDING_FOUNDATIONS = lesson({
  id: "building-foundations",
  courseId: "board-basics",
  order: 3,
  difficulty: "beginner",
  estimatedMinutes: 3,
  deal: preparedDeal({
    tableau: [
      [up(D(1))],
      [up(D(2))],
      [up(C(13))],
      [up(H(12))],
      [up(S(11))],
      [up(H(10))],
      [up(C(9))],
    ],
  }),
  steps: [
    step(
      "building-foundations",
      "ace",
      (state) => state.foundations.diamonds.length >= 1,
      [{ kind: "tableau-to-foundation", fromColumn: 0, card: D(1), suit: "diamonds" }],
    ),
    step(
      "building-foundations",
      "two",
      (state) => state.foundations.diamonds.length >= 2,
      [{ kind: "tableau-to-foundation", fromColumn: 1, card: D(2), suit: "diamonds" }],
    ),
  ],
});

const LEGAL_MOVES = lesson({
  id: "legal-moves",
  courseId: "board-basics",
  order: 4,
  difficulty: "beginner",
  estimatedMinutes: 3,
  deal: preparedDeal({
    tableau: [
      [up(H(7))],
      [up(S(8))],
      [up(C(1))],
      [up(D(6))],
      [up(C(9))],
      [up(D(12))],
      [up(H(13))],
    ],
  }),
  steps: [
    step(
      "legal-moves",
      "place-seven",
      (state) =>
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "hearts" &&
        state.tableau[1][1]?.card?.rank === 7,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: H(7), toColumn: 1 }],
    ),
    step(
      "legal-moves",
      "ace",
      (state) => state.foundations.clubs.length >= 1,
      [{ kind: "tableau-to-foundation", fromColumn: 2, card: C(1), suit: "clubs" }],
    ),
  ],
});

// ── Course 2 — Moving Cards ───────────────────────────────────────────────

const ALTERNATING_COLORS = lesson({
  id: "alternating-colors",
  courseId: "moving-cards",
  order: 1,
  difficulty: "beginner",
  estimatedMinutes: 3,
  deal: preparedDeal({
    tableau: [
      [up(H(7))],
      [up(S(8))],
      [up(D(8))],
      [up(C(6))],
      [up(D(9))],
      [up(S(12))],
      [up(C(13))],
    ],
  }),
  steps: [
    step(
      "alternating-colors",
      "place-seven",
      (state) =>
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "hearts" &&
        state.tableau[1][1]?.card?.rank === 7,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: H(7), toColumn: 1 }],
    ),
    step(
      "alternating-colors",
      "place-six",
      (state) =>
        state.tableau[1].length === 3 &&
        state.tableau[1][2]?.card?.suit === "clubs" &&
        state.tableau[1][2]?.card?.rank === 6,
      [{ kind: "tableau-to-tableau", fromColumn: 3, card: C(6), toColumn: 1 }],
    ),
  ],
});

const DESCENDING_SEQUENCES = lesson({
  id: "descending-sequences",
  courseId: "moving-cards",
  order: 2,
  difficulty: "beginner",
  estimatedMinutes: 3,
  deal: preparedDeal({
    tableau: [
      [up(D(9))],
      [up(S(10))],
      [up(C(8))],
      [up(H(11))],
      [up(C(1))],
      [up(S(3))],
      [up(H(4))],
    ],
  }),
  steps: [
    step(
      "descending-sequences",
      "place-nine",
      (state) =>
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "diamonds" &&
        state.tableau[1][1]?.card?.rank === 9,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: D(9), toColumn: 1 }],
    ),
    step(
      "descending-sequences",
      "place-eight",
      (state) =>
        state.tableau[1].length === 3 &&
        state.tableau[1][2]?.card?.suit === "clubs" &&
        state.tableau[1][2]?.card?.rank === 8,
      [{ kind: "tableau-to-tableau", fromColumn: 2, card: C(8), toColumn: 1 }],
    ),
  ],
});

const MOVING_RUNS = lesson({
  id: "moving-runs",
  courseId: "moving-cards",
  order: 3,
  difficulty: "beginner",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [up(D(9)), up(C(8)), up(H(7))],
      [up(S(10))],
      [up(S(6))],
      [up(C(1))],
      [up(D(12))],
      [up(H(2))],
      [up(C(3))],
    ],
  }),
  steps: [
    step(
      "moving-runs",
      "move-run",
      (state) =>
        state.tableau[0].length === 0 &&
        state.tableau[1].length === 4 &&
        state.tableau[1][3]?.card?.suit === "hearts" &&
        state.tableau[1][3]?.card?.rank === 7,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: D(9), toColumn: 1 }],
    ),
    step(
      "moving-runs",
      "place-six",
      (state) =>
        state.tableau[1].length === 5 &&
        state.tableau[1][4]?.card?.suit === "spades" &&
        state.tableau[1][4]?.card?.rank === 6,
      [{ kind: "tableau-to-tableau", fromColumn: 2, card: S(6), toColumn: 1 }],
    ),
  ],
});

const REVEAL_A_CARD = lesson({
  id: "reveal-a-card",
  courseId: "moving-cards",
  order: 4,
  difficulty: "beginner",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [up(D(13))],
      [up(S(12))],
      [down(C(9)), up(H(10))],
      [up(S(11))],
      [up(D(1))],
      [up(C(2))],
      [],
    ],
  }),
  steps: [
    step(
      "reveal-a-card",
      "place",
      (state) =>
        state.tableau[2].length === 1 &&
        state.tableau[3].length === 2 &&
        state.tableau[3][1]?.card?.suit === "hearts" &&
        state.tableau[3][1]?.card?.rank === 10,
      [{ kind: "tableau-to-tableau", fromColumn: 2, card: H(10), toColumn: 3 }],
    ),
    step(
      "reveal-a-card",
      "expose",
      (state) =>
        state.tableau[2].length === 1 &&
        state.tableau[2][0]?.faceUp === true &&
        state.tableau[2][0]?.card?.suit === "clubs" &&
        state.tableau[2][0]?.card?.rank === 9,
    ),
  ],
});

// ── Course 3 — Managing the Tableau ───────────────────────────────────────

const OPENING_COLUMNS = lesson({
  id: "opening-columns",
  courseId: "tableau-management",
  order: 1,
  difficulty: "intermediate",
  estimatedMinutes: 3,
  deal: preparedDeal({
    tableau: [
      [up(S(13))],
      [up(H(12))],
      [up(C(11))],
      [up(D(10))],
      [up(S(9))],
      [up(H(8))],
      [],
    ],
  }),
  steps: [
    step(
      "opening-columns",
      "move-king",
      (state) =>
        state.tableau[6].length === 1 &&
        state.tableau[6][0]?.card?.suit === "spades" &&
        state.tableau[6][0]?.card?.rank === 13,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: S(13), toColumn: 6 }],
    ),
    step(
      "opening-columns",
      "place-queen",
      (state) =>
        state.tableau[6].length === 2 &&
        state.tableau[6][1]?.card?.suit === "hearts" &&
        state.tableau[6][1]?.card?.rank === 12,
      [{ kind: "tableau-to-tableau", fromColumn: 1, card: H(12), toColumn: 6 }],
    ),
  ],
});

const MOVING_KINGS = lesson({
  id: "moving-kings",
  courseId: "tableau-management",
  order: 2,
  difficulty: "intermediate",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [down(S(1)), up(D(13))],
      [up(C(12))],
      [up(H(11))],
      [up(S(10))],
      [up(D(9))],
      [up(C(8))],
      [],
    ],
  }),
  steps: [
    step(
      "moving-kings",
      "move-king",
      (state) =>
        state.tableau[0].length === 1 &&
        state.tableau[0][0]?.faceUp === true &&
        state.tableau[0][0]?.card?.suit === "spades" &&
        state.tableau[0][0]?.card?.rank === 1 &&
        state.tableau[6].length === 1 &&
        state.tableau[6][0]?.card?.rank === 13,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: D(13), toColumn: 6 }],
    ),
    step(
      "moving-kings",
      "foundation-ace",
      (state) => state.foundations.spades.length >= 1,
      [{ kind: "tableau-to-foundation", fromColumn: 0, card: S(1), suit: "spades" }],
    ),
  ],
});

const CHOOSING_SEQUENCES = lesson({
  id: "choosing-sequences",
  courseId: "tableau-management",
  order: 3,
  difficulty: "intermediate",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [down(C(9)), up(H(8))],
      [up(S(9))],
      [up(C(6))],
      [up(D(5))],
      [up(D(10))],
      [up(H(1))],
      [up(S(13))],
    ],
  }),
  steps: [
    step(
      "choosing-sequences",
      "choose-reveal",
      (state) =>
        state.tableau[0].length === 1 &&
        state.tableau[0][0]?.faceUp === true &&
        state.tableau[0][0]?.card?.rank === 9 &&
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "hearts",
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: H(8), toColumn: 1 }],
    ),
    step(
      "choosing-sequences",
      "place-nine",
      (state) =>
        state.tableau[4].length === 2 &&
        state.tableau[4][1]?.card?.suit === "clubs" &&
        state.tableau[4][1]?.card?.rank === 9,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: C(9), toColumn: 4 }],
    ),
  ],
});

const BLOCKED_COLUMNS = lesson({
  id: "blocked-columns",
  courseId: "tableau-management",
  order: 4,
  difficulty: "intermediate",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [down(D(6)), up(S(7))],
      [up(H(8))],
      [up(C(7))],
      [up(D(9))],
      [up(S(1))],
      [up(H(13))],
      [up(C(12))],
    ],
  }),
  steps: [
    step(
      "blocked-columns",
      "unblock",
      (state) =>
        state.tableau[0].length === 1 &&
        state.tableau[0][0]?.faceUp === true &&
        state.tableau[0][0]?.card?.suit === "diamonds" &&
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "spades",
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: S(7), toColumn: 1 }],
    ),
    step(
      "blocked-columns",
      "place-six",
      (state) =>
        state.tableau[2].length === 2 &&
        state.tableau[2][1]?.card?.suit === "diamonds" &&
        state.tableau[2][1]?.card?.rank === 6,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: D(6), toColumn: 2 }],
    ),
  ],
});

// ── Course 4 — Foundation Strategy ────────────────────────────────────────

const FOUNDATION_TIMING = lesson({
  id: "foundation-timing",
  courseId: "foundation-strategy",
  order: 1,
  difficulty: "intermediate",
  estimatedMinutes: 3,
  deal: preparedDeal({
    tableau: [
      [down(D(9)), up(S(1))],
      [up(C(10))],
      [up(H(13))],
      [up(S(12))],
      [up(D(11))],
      [up(H(8))],
      [up(C(7))],
    ],
  }),
  steps: [
    step(
      "foundation-timing",
      "ace",
      (state) =>
        state.foundations.spades.length >= 1 &&
        state.tableau[0].length === 1 &&
        state.tableau[0][0]?.faceUp === true,
      [{ kind: "tableau-to-foundation", fromColumn: 0, card: S(1), suit: "spades" }],
    ),
    step(
      "foundation-timing",
      "revealed-nine",
      (state) =>
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "diamonds" &&
        state.tableau[1][1]?.card?.rank === 9,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: D(9), toColumn: 1 }],
    ),
  ],
});

const KEEPING_TABLEAU_CARDS = lesson({
  id: "keeping-tableau-cards",
  courseId: "foundation-strategy",
  order: 2,
  difficulty: "intermediate",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [up(C(3))],
      [up(C(2))],
      [up(C(1))],
      [up(D(2))],
      [up(S(4))],
      [up(H(13))],
      [up(S(12))],
    ],
  }),
  steps: [
    step(
      "keeping-tableau-cards",
      "ace",
      (state) => state.foundations.clubs.length >= 1,
      [{ kind: "tableau-to-foundation", fromColumn: 2, card: C(1), suit: "clubs" }],
    ),
    step(
      "keeping-tableau-cards",
      "two",
      (state) => state.foundations.clubs.length >= 2,
      [{ kind: "tableau-to-foundation", fromColumn: 1, card: C(2), suit: "clubs" }],
    ),
    step(
      "keeping-tableau-cards",
      "keep-three",
      (state) =>
        state.tableau[0].length === 2 &&
        state.tableau[0][1]?.card?.suit === "diamonds" &&
        state.tableau[0][1]?.card?.rank === 2,
      [{ kind: "tableau-to-tableau", fromColumn: 3, card: D(2), toColumn: 0 }],
    ),
  ],
});

const LOW_VALUE_CARDS = lesson({
  id: "low-value-cards",
  courseId: "foundation-strategy",
  order: 3,
  difficulty: "intermediate",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [up(D(2))],
      [up(D(1))],
      [up(C(3))],
      [up(H(4))],
      [up(S(13))],
      [up(C(12))],
      [up(H(11))],
    ],
  }),
  steps: [
    step(
      "low-value-cards",
      "ace",
      (state) => state.foundations.diamonds.length >= 1,
      [{ kind: "tableau-to-foundation", fromColumn: 1, card: D(1), suit: "diamonds" }],
    ),
    step(
      "low-value-cards",
      "place-three",
      (state) =>
        state.tableau[3].length === 2 &&
        state.tableau[3][1]?.card?.suit === "clubs" &&
        state.tableau[3][1]?.card?.rank === 3,
      [{ kind: "tableau-to-tableau", fromColumn: 2, card: C(3), toColumn: 3 }],
    ),
    step(
      "low-value-cards",
      "send-two",
      (state) => state.foundations.diamonds.length >= 2,
      [{ kind: "tableau-to-foundation", fromColumn: 0, card: D(2), suit: "diamonds" }],
    ),
  ],
});

const EFFICIENT_FOUNDATIONS = lesson({
  id: "efficient-foundations",
  courseId: "foundation-strategy",
  order: 4,
  difficulty: "intermediate",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [up(C(1))],
      [up(C(2))],
      [up(C(3))],
      [up(H(13))],
      [up(S(12))],
      [up(D(11))],
      [up(H(10))],
    ],
  }),
  steps: [
    step(
      "efficient-foundations",
      "ace",
      (state) => state.foundations.clubs.length >= 1,
      [{ kind: "tableau-to-foundation", fromColumn: 0, card: C(1), suit: "clubs" }],
    ),
    step(
      "efficient-foundations",
      "two",
      (state) => state.foundations.clubs.length >= 2,
      [{ kind: "tableau-to-foundation", fromColumn: 1, card: C(2), suit: "clubs" }],
    ),
    step(
      "efficient-foundations",
      "three",
      (state) => state.foundations.clubs.length >= 3,
      [{ kind: "tableau-to-foundation", fromColumn: 2, card: C(3), suit: "clubs" }],
    ),
  ],
});

// ── Course 5 — Advanced Strategy ──────────────────────────────────────────

const PLANNING_AHEAD = lesson({
  id: "planning-ahead",
  courseId: "advanced-strategy",
  order: 1,
  difficulty: "advanced",
  estimatedMinutes: 5,
  deal: preparedDeal({
    tableau: [
      [up(H(9))],
      [up(S(10))],
      [up(C(8))],
      [up(D(7))],
      [up(S(1))],
      [up(H(13))],
      [up(C(12))],
    ],
  }),
  steps: [
    step(
      "planning-ahead",
      "place-nine",
      (state) =>
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "hearts" &&
        state.tableau[1][1]?.card?.rank === 9,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: H(9), toColumn: 1 }],
    ),
    step(
      "planning-ahead",
      "place-eight",
      (state) =>
        state.tableau[1].length === 3 &&
        state.tableau[1][2]?.card?.suit === "clubs" &&
        state.tableau[1][2]?.card?.rank === 8,
      [{ kind: "tableau-to-tableau", fromColumn: 2, card: C(8), toColumn: 1 }],
    ),
    step(
      "planning-ahead",
      "place-seven",
      (state) =>
        state.tableau[1].length === 4 &&
        state.tableau[1][3]?.card?.suit === "diamonds" &&
        state.tableau[1][3]?.card?.rank === 7,
      [{ kind: "tableau-to-tableau", fromColumn: 3, card: D(7), toColumn: 1 }],
    ),
  ],
});

const CHOOSING_REVEALS = lesson({
  id: "choosing-reveals",
  courseId: "advanced-strategy",
  order: 2,
  difficulty: "advanced",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [down(D(9)), up(S(10))],
      [down(C(4)), up(H(5))],
      [up(H(11))],
      [up(C(6))],
      [up(S(1))],
      [up(D(13))],
      [up(C(12))],
    ],
  }),
  steps: [
    step(
      "choosing-reveals",
      "reveal-nine",
      (state) =>
        state.tableau[0].length === 1 &&
        state.tableau[0][0]?.faceUp === true &&
        state.tableau[0][0]?.card?.suit === "diamonds" &&
        state.tableau[2].length === 2 &&
        state.tableau[2][1]?.card?.suit === "spades",
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: S(10), toColumn: 2 }],
    ),
    step(
      "choosing-reveals",
      "place-nine",
      (state) =>
        state.tableau[2].length === 3 &&
        state.tableau[2][2]?.card?.suit === "diamonds" &&
        state.tableau[2][2]?.card?.rank === 9,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: D(9), toColumn: 2 }],
    ),
  ],
});

const STOCK_CYCLES = lesson({
  id: "stock-cycles",
  courseId: "advanced-strategy",
  order: 3,
  difficulty: "advanced",
  estimatedMinutes: 5,
  deal: preparedDeal({
    tableau: [
      [up(S(13))],
      [up(H(12))],
      [up(C(11))],
      [up(D(10))],
      [up(S(9))],
      [up(H(8))],
      [up(C(1))],
    ],
    drawOrder: [H(2), C(3)],
    padTableau: true,
  }),
  steps: [
    step(
      "stock-cycles",
      "draw-one",
      (state) => state.waste.length >= 1,
      [{ kind: "draw" }],
    ),
    step(
      "stock-cycles",
      "draw-two",
      (state) => state.stock.length === 0 && state.waste.length === 2,
      [{ kind: "draw" }],
    ),
    step(
      "stock-cycles",
      "recycle",
      (state) =>
        state.stock.length === 2 && state.waste.length === 0 && state.ply >= 3,
      [{ kind: "draw" }],
    ),
    step(
      "stock-cycles",
      "draw-again",
      (state) =>
        state.waste.length === 1 &&
        state.waste[0]?.suit === "clubs" &&
        state.waste[0]?.rank === 3,
      [{ kind: "draw" }],
    ),
  ],
});

const DIFFICULT_POSITIONS = lesson({
  id: "difficult-positions",
  courseId: "advanced-strategy",
  order: 4,
  difficulty: "advanced",
  estimatedMinutes: 4,
  deal: preparedDeal({
    tableau: [
      [down(S(8)), up(H(9))],
      [up(C(10))],
      [up(D(13))],
      [up(S(12))],
      [up(H(11))],
      [up(C(7))],
      [up(D(6))],
    ],
  }),
  steps: [
    step(
      "difficult-positions",
      "scan",
      (state) =>
        state.tableau[0].length === 1 &&
        state.tableau[0][0]?.faceUp === true &&
        state.tableau[0][0]?.card?.suit === "spades" &&
        state.tableau[1].length === 2 &&
        state.tableau[1][1]?.card?.suit === "hearts",
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: H(9), toColumn: 1 }],
    ),
    step(
      "difficult-positions",
      "continue",
      (state) =>
        state.tableau[1].length === 3 &&
        state.tableau[1][2]?.card?.suit === "spades" &&
        state.tableau[1][2]?.card?.rank === 8,
      [{ kind: "tableau-to-tableau", fromColumn: 0, card: S(8), toColumn: 1 }],
    ),
  ],
});

export const LESSON_COURSES: readonly LessonCourse[] = Object.freeze([
  {
    id: "board-basics",
    order: 1,
    titleKey: "learn.courses.board-basics.title",
    descriptionKey: "learn.courses.board-basics.description",
  },
  {
    id: "moving-cards",
    order: 2,
    titleKey: "learn.courses.moving-cards.title",
    descriptionKey: "learn.courses.moving-cards.description",
  },
  {
    id: "tableau-management",
    order: 3,
    titleKey: "learn.courses.tableau-management.title",
    descriptionKey: "learn.courses.tableau-management.description",
  },
  {
    id: "foundation-strategy",
    order: 4,
    titleKey: "learn.courses.foundation-strategy.title",
    descriptionKey: "learn.courses.foundation-strategy.description",
  },
  {
    id: "advanced-strategy",
    order: 5,
    titleKey: "learn.courses.advanced-strategy.title",
    descriptionKey: "learn.courses.advanced-strategy.description",
  },
]);

export const LESSON_CATALOG: readonly Lesson[] = Object.freeze([
  TABLEAU_BASICS,
  FIRST_DRAW,
  BUILDING_FOUNDATIONS,
  LEGAL_MOVES,
  ALTERNATING_COLORS,
  DESCENDING_SEQUENCES,
  MOVING_RUNS,
  REVEAL_A_CARD,
  OPENING_COLUMNS,
  MOVING_KINGS,
  CHOOSING_SEQUENCES,
  BLOCKED_COLUMNS,
  FOUNDATION_TIMING,
  KEEPING_TABLEAU_CARDS,
  LOW_VALUE_CARDS,
  EFFICIENT_FOUNDATIONS,
  PLANNING_AHEAD,
  CHOOSING_REVEALS,
  STOCK_CYCLES,
  DIFFICULT_POSITIONS,
]);

/** Stable id lookup. A catalog edit never changes a route or stored key. */
export const LESSON_BY_ID: Readonly<Record<string, Lesson>> = Object.freeze(
  Object.fromEntries(LESSON_CATALOG.map((entry) => [entry.id, entry])),
);

export function lessonById(id: string): Lesson | null {
  return LESSON_BY_ID[id] ?? null;
}

export function lessonsForCourse(courseId: string): readonly Lesson[] {
  return LESSON_CATALOG.filter((entry) => entry.courseId === courseId).sort(
    (a, b) => a.order - b.order,
  );
}

/** The next lesson in the same course, or null at the end of the course. */
export function nextLessonInCourse(lessonId: string): Lesson | null {
  const current = lessonById(lessonId);
  if (!current) return null;
  const ordered = lessonsForCourse(current.courseId);
  const index = ordered.findIndex((entry) => entry.id === lessonId);
  return index >= 0 ? ordered[index + 1] ?? null : null;
}
