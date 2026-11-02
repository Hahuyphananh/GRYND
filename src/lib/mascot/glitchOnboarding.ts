// src/lib/mascot/glitchOnboarding.ts
//
// WHERE GLITCH SPEAKS DURING ONBOARDING, AND WHAT IT SAYS.
//
// The copy is not here: every `messageKey` points into
// src/lib/appTextTranslations.js under `onboarding.glitch.*` (en / fr / es), so
// nothing user-facing is duplicated into a component. What lives here is the
// mapping the pages share — which step uses which expression, and which
// message — so the questionnaire, /welcome and the first RPS match cannot drift
// into three slightly different mascots.
//
// ONBOARDING ONLY USES INLINE PLACEMENT. These lines are part of the page
// (GlitchSay placement="inline"), never the floating provider: a guide that
// hovers over a question or a board is exactly the behaviour the cadence rules
// in glitchCadence.js exist to prevent, and "never show a floating and an
// inline mascot at once" is trivially satisfied if onboarding only ever renders
// the inline one.
//
// Translations are resolved with `t(key)` at the call site, so a missing locale
// falls back to English through the existing t() helper rather than rendering a
// raw key.

import type { GlitchExpression } from "./glitchAssets";

export type GlitchLine = {
  readonly expression: GlitchExpression;
  /** Dotted path into appTextTranslations (`onboarding.glitch.*`). */
  readonly messageKey: string;
};

// ── Questionnaire ─────────────────────────────────────────────────────────
// Deliberately SPARSE: question 1 sets the tone, question 5 marks the finish.
// The three questions in between say nothing — a mascot on every screen would
// be noise, and this questionnaire is a form the player wants to get through.
const QUESTIONNAIRE_LINES: Record<number, GlitchLine> = {
  0: { expression: "surprised", messageKey: "onboarding.glitch.questionnaire.q1" },
  4: { expression: "focused", messageKey: "onboarding.glitch.questionnaire.q5" },
};

/** The line for a questionnaire step, or null for the quiet ones. */
export function glitchQuestionnaireLine(step: number): GlitchLine | null {
  return QUESTIONNAIRE_LINES[step] ?? null;
}

// ── /welcome tutorial (five steps) ────────────────────────────────────────
/** One line per existing tutorial step, in step order. */
export const GLITCH_WELCOME_LINES: readonly GlitchLine[] = [
  { expression: "idle", messageKey: "onboarding.glitch.welcome.step0" },
  { expression: "wink", messageKey: "onboarding.glitch.welcome.step1" },
  { expression: "focused", messageKey: "onboarding.glitch.welcome.step2" },
  { expression: "focused", messageKey: "onboarding.glitch.welcome.step3" },
  { expression: "victory", messageKey: "onboarding.glitch.welcome.step4" },
];

/** The line for a tutorial step (null outside the five steps). */
export function glitchWelcomeLine(step: number): GlitchLine | null {
  return GLITCH_WELCOME_LINES[step] ?? null;
}

/** How many steps the tutorial copy covers — pinned by tests to the page's
 *  own TOTAL_STEPS, so adding a step cannot silently leave it silent. */
export const GLITCH_WELCOME_STEP_COUNT = GLITCH_WELCOME_LINES.length;

// ── First match (RPS vs AI, ?onboarding=1) ────────────────────────────────
export const GLITCH_FIRST_MATCH_LINES = {
  start: { expression: "idle", messageKey: "onboarding.glitch.firstMatch.start" },
  victory: { expression: "victory", messageKey: "onboarding.glitch.firstMatch.victory" },
  defeat: { expression: "defeat", messageKey: "onboarding.glitch.firstMatch.defeat" },
} as const satisfies Record<string, GlitchLine>;

/** The terminal tutorial line: won the match, or lost it. */
export function glitchFirstMatchResultLine(won: boolean): GlitchLine {
  return won ? GLITCH_FIRST_MATCH_LINES.victory : GLITCH_FIRST_MATCH_LINES.defeat;
}
