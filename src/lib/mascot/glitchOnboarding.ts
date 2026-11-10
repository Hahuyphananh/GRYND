// src/lib/mascot/glitchOnboarding.ts
//
// WHERE GLITCH SPEAKS DURING ONBOARDING, AND WHAT IT SAYS.
//
// GRYND is Solitaire-first now, so this map is the single place that decides
// which expression and which line belong to each onboarding step and to each
// real gameplay event in the tutorial. The COPY is not here: every
// `messageKey` points into src/lib/appTextTranslations.js under
// `onboarding.glitch.*` (en / fr / es), so no user-facing sentence is
// duplicated into a component and the welcome page, the questionnaire and the
// tutorial cannot drift into three different mascots.
//
// ONBOARDING ONLY USES INLINE PLACEMENT. These lines are part of the page
// (GlitchSay placement="inline"), never the floating provider: a guide that
// hovers over a board is exactly what glitchCadence.js exists to prevent.
//
// The lines react to REAL events only. `tutorialMoveLine` is called after the
// engine has accepted a move and reports which goal it advanced; an invalid
// move gets `invalid`, which is helpful and never claims success.

import type { GlitchExpression } from "./glitchAssets";

export type GlitchLine = {
  readonly expression: GlitchExpression;
  /** Dotted path into appTextTranslations (`onboarding.glitch.*`). */
  readonly messageKey: string;
};

// ── Questionnaire ─────────────────────────────────────────────────────────
// Sparse on purpose: question 1 sets the tone, question 3 nudges toward the
// goal question, question 5 marks the finish. A mascot on every screen would
// be noise in a form the player wants to get through.
const QUESTIONNAIRE_LINES: Record<number, GlitchLine> = {
  0: { expression: "surprised", messageKey: "onboarding.solitaire.glitch.questionnaire.q1" },
  2: { expression: "wink", messageKey: "onboarding.solitaire.glitch.questionnaire.q3" },
  4: { expression: "focused", messageKey: "onboarding.solitaire.glitch.questionnaire.q5" },
};

/** The line for a questionnaire step, or null for the quiet ones. */
export function glitchQuestionnaireLine(step: number): GlitchLine | null {
  return QUESTIONNAIRE_LINES[step] ?? null;
}

// ── /welcome, six steps ───────────────────────────────────────────────────
/**
 * One line per step, in step order:
 *   0 welcome · 1 the board · 2 the rules · 3 tutorial · 4 modes · 5 done
 */
export const GLITCH_WELCOME_LINES: readonly GlitchLine[] = [
  { expression: "idle", messageKey: "onboarding.solitaire.glitch.welcome.step0" },
  { expression: "wink", messageKey: "onboarding.solitaire.glitch.welcome.step1" },
  { expression: "focused", messageKey: "onboarding.solitaire.glitch.welcome.step2" },
  { expression: "focused", messageKey: "onboarding.solitaire.glitch.welcome.step3" },
  { expression: "wink", messageKey: "onboarding.solitaire.glitch.welcome.step4" },
  { expression: "victory", messageKey: "onboarding.solitaire.glitch.welcome.step5" },
];

/** The line for a tutorial step (null outside the six steps). */
export function glitchWelcomeLine(step: number): GlitchLine | null {
  return GLITCH_WELCOME_LINES[step] ?? null;
}

/** How many steps the tutorial copy covers — pinned by tests to the page's
 *  own TOTAL_STEPS, so adding a step cannot silently leave it silent. */
export const GLITCH_WELCOME_STEP_COUNT = GLITCH_WELCOME_LINES.length;

// ── Interactive Solitaire tutorial ────────────────────────────────────────
/**
 * Reactions to what the player actually did. Every one of these is triggered
 * by the engine's result, never by a timer or by opening the page:
 *
 *   ace      an Ace reached a foundation (the first goal)
 *   progress any goal advanced
 *   reveal   a face-down card was turned over
 *   invalid  the engine refused the move — helpful, never insulting
 *   stuck    repeated inactivity; offers the hint without forcing it
 *   complete all four goals met
 */
export const GLITCH_TUTORIAL_LINES = {
  ace: { expression: "victory", messageKey: "onboarding.solitaire.glitch.tutorial.ace" },
  progress: { expression: "wink", messageKey: "onboarding.solitaire.glitch.tutorial.progress" },
  reveal: { expression: "surprised", messageKey: "onboarding.solitaire.glitch.tutorial.reveal" },
  invalid: { expression: "focused", messageKey: "onboarding.solitaire.glitch.tutorial.invalid" },
  stuck: { expression: "surprised", messageKey: "onboarding.solitaire.glitch.tutorial.stuck" },
  complete: { expression: "victory", messageKey: "onboarding.solitaire.glitch.tutorial.complete" },
} as const satisfies Record<string, GlitchLine>;

export type GlitchTutorialReaction = keyof typeof GLITCH_TUTORIAL_LINES;

/**
 * The reaction for one accepted tutorial move.
 *
 * `stepId` is the goal the move COMPLETED (null when the move was legal but
 * did not advance a goal), and `revealed` is the engine's list of cards this
 * move turned face-up. Nothing here can report a success the engine did not
 * produce.
 */
export function tutorialMoveLine({
  stepId,
  revealed,
  complete,
}: {
  stepId: string | null;
  revealed: readonly unknown[];
  complete: boolean;
}): GlitchLine {
  if (complete) return GLITCH_TUTORIAL_LINES.complete;
  if (stepId === "ace") return GLITCH_TUTORIAL_LINES.ace;
  if (revealed.length > 0) return GLITCH_TUTORIAL_LINES.reveal;
  if (stepId) return GLITCH_TUTORIAL_LINES.progress;
  return GLITCH_TUTORIAL_LINES.progress;
}

// ── First match (legacy RPS vs AI, ?onboarding=1) ─────────────────────────
// Kept untouched so the existing RPS practice page keeps rendering its
// onboarding lines. The SOLITAIRE onboarding never routes to RPS.
export const GLITCH_FIRST_MATCH_LINES = {
  start: { expression: "idle", messageKey: "onboarding.glitch.firstMatch.start" },
  victory: { expression: "victory", messageKey: "onboarding.glitch.firstMatch.victory" },
  defeat: { expression: "defeat", messageKey: "onboarding.glitch.firstMatch.defeat" },
} as const satisfies Record<string, GlitchLine>;

/** The terminal legacy tutorial line: won the match, or lost it. */
export function glitchFirstMatchResultLine(won: boolean): GlitchLine {
  return won ? GLITCH_FIRST_MATCH_LINES.victory : GLITCH_FIRST_MATCH_LINES.defeat;
}
