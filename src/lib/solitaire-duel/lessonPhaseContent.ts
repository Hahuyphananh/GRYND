// src/lib/solitaire-duel/lessonPhaseContent.ts
//
// Phase copy wiring for the existing 20 lessons. It does NOT author new
// positions: every Watch demonstration replays the first canonical action on
// the lesson's own prepared deal, and every Practice exercise reuses a complete
// prepared deal from another authored lesson. Both paths go through the same
// validation and rules engine as the guided exercise.

import { SUITS } from "./constants";
import type { Lesson, LessonPhases, LessonStep } from "./lessons";
import type { Card, PileCard, SolitaireDeal } from "./types";

const card = (suit: Card["suit"], rank: number): Card => ({
  suit,
  rank: rank as Card["rank"],
});
const up = (value: Card): PileCard => ({ card: value, faceUp: true });

/** A complete 52-card deal with a prepared tableau and the rest in the stock. */
function practiceDeal(tableau: PileCard[][]): SolitaireDeal {
  const used = new Set(
    tableau.flatMap((column) =>
      column.map((slot) => slot.card!.suit + "-" + slot.card!.rank),
    ),
  );
  const stock: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) {
      const value = card(suit, rank);
      if (!used.has(value.suit + "-" + value.rank)) stock.push(value);
    }
  }
  return { variant: "klondike-1", variantVersion: 3, tableau, stock };
}

/**
 * Independent practice uses a different prepared position from the lesson's
 * guided deal. The source lesson supplies a validated deal and objective.
 * The two introductory lessons deliberately have no extra practice phase.
 */
const PRACTICE_SOURCE: Readonly<Record<string, string>> = {
  "building-foundations": "keeping-tableau-cards",
  "legal-moves": "alternating-colors",
  "alternating-colors": "legal-moves",
  "descending-sequences": "planning-ahead",
  "moving-runs": "moving-runs",
  "reveal-a-card": "choosing-reveals",
  "opening-columns": "moving-kings",
  "moving-kings": "opening-columns",
  "choosing-sequences": "reveal-a-card",
  "blocked-columns": "difficult-positions",
  "foundation-timing": "building-foundations",
  "keeping-tableau-cards": "efficient-foundations",
  "low-value-cards": "foundation-timing",
  "efficient-foundations": "keeping-tableau-cards",
  "planning-ahead": "moving-runs",
  "choosing-reveals": "reveal-a-card",
  "stock-cycles": "first-draw",
  "difficult-positions": "blocked-columns",
};

/**
 * Moving a whole run is the one concept with no second run-bearing deal in the
 * existing catalog, so this lesson gets a dedicated prepared position.
 */
const CUSTOM_PRACTICE: Readonly<
  Record<string, { deal: SolitaireDeal; step: LessonStep }>
> = {
  "moving-runs": {
    deal: practiceDeal([
      [up(card("hearts", 10)), up(card("spades", 9)), up(card("diamonds", 8))],
      [up(card("clubs", 11))],
      [],
      [],
      [],
      [],
      [],
    ]),
    step: {
      id: "move-new-run",
      instructionKey: "learn.lessons.moving-runs.step.move-run.instruction",
      explanationKey: "learn.lessons.moving-runs.step.move-run.explanation",
      incorrectKey: "learn.lessons.moving-runs.step.move-run.incorrect",
      done: (state) =>
        state.tableau[1].length === 4 &&
        state.tableau[1][3]?.card?.suit === "diamonds" &&
        state.tableau[1][3]?.card?.rank === 8,
      acceptableMoves: [
        {
          kind: "tableau-to-tableau",
          fromColumn: 0,
          card: card("hearts", 10),
          toColumn: 1,
        },
      ],
      hints: [
        { textKey: "learn.lessons.moving-runs.step.move-run.hint1" },
        {
          textKey: "learn.lessons.moving-runs.step.move-run.hint2",
          revealsSolution: true,
        },
      ],
    },
  },
};

/** Rounded estimates for the additional teaching content. */
export const PHASE_MINUTES: Readonly<Record<string, number>> = {
  "tableau-basics": 3,
  "first-draw": 4,
  "building-foundations": 5,
  "legal-moves": 5,
  "alternating-colors": 5,
  "descending-sequences": 5,
  "moving-runs": 6,
  "reveal-a-card": 6,
  "opening-columns": 6,
  "moving-kings": 6,
  "choosing-sequences": 6,
  "blocked-columns": 6,
  "foundation-timing": 6,
  "keeping-tableau-cards": 7,
  "low-value-cards": 6,
  "efficient-foundations": 6,
  "planning-ahead": 7,
  "choosing-reveals": 7,
  "stock-cycles": 7,
  "difficult-positions": 8,
};

export function buildLessonPhases(
  lesson: Lesson,
  lessons: readonly Lesson[],
): LessonPhases {
  const firstStep = lesson.steps[0];
  const demoMove = firstStep?.acceptableMoves?.[0];
  const sourceId = PRACTICE_SOURCE[lesson.id];
  const source = sourceId ? lessons.find((entry) => entry.id === sourceId) : null;
  const custom = CUSTOM_PRACTICE[lesson.id];
  const practiceStep = custom?.step ?? source?.steps[0];
  const practiceDeal = custom?.deal ?? source?.deal;
  const correctOptionId = lesson.order % 2 === 0 ? "b" : "a";
  const correctKey = "learn.phases.quiz." + lesson.id + ".correct";
  const wrongKey = "learn.phases.quiz." + lesson.id + ".wrong";

  return {
    learn: {
      titleKey: lesson.titleKey,
      explanationKey: lesson.descriptionKey,
      whyKey: firstStep?.explanationKey ?? lesson.successKey,
      mistakeKey: firstStep?.incorrectKey ?? lesson.successKey,
      recognizeKey: firstStep?.hints?.[0]?.textKey ?? lesson.descriptionKey,
    },
    ...(demoMove && firstStep
      ? {
          watch: {
            deal: lesson.deal,
            steps: [
              {
                move: demoMove,
                explanationKey: firstStep.explanationKey,
              },
            ],
          },
        }
      : {}),
    ...(practiceDeal && practiceStep
      ? {
          practice: [
            {
              id: lesson.id + "-practice",
              deal: practiceDeal,
              instructionKey: "learn.phases.practiceInstruction",
              steps: [practiceStep],
              successKey: practiceStep.explanationKey,
              hints: practiceStep.hints,
            },
          ],
        }
      : {}),
    knowledgeCheck: {
      questionKey: "learn.phases.quiz." + lesson.id + ".question",
      options: [
        {
          id: "a",
          textKey: correctOptionId === "a" ? correctKey : wrongKey,
        },
        {
          id: "b",
          textKey: correctOptionId === "b" ? correctKey : wrongKey,
        },
      ],
      correctOptionId,
      explanationKey: "learn.phases.quiz." + lesson.id + ".explanation",
    },
    recap: {
      summaryKey: lesson.descriptionKey,
      rememberKey: firstStep?.explanationKey ?? lesson.successKey,
    },
  };
}
