// src/lib/solitaire-duel/lessonPhases.ts
//
// The teaching-phase state machine. It is deliberately pure and independent of
// React, routes, storage and the demo board so every transition can be tested
// directly. The guided exercise remains the existing lesson engine; this module
// only decides which optional phase is shown around it.

import {
  applyMove,
  initialStateFromDeal,
  normalizeMove,
} from "./rules";
import type {
  Lesson,
  LessonDemoStep,
  LessonKnowledgeCheck,
  LessonPracticePosition,
  LessonWatchContent,
} from "./lessons";
import type { SolitaireState } from "./types";

/** The six supported teaching phases, in presentation order. */
export type LessonPhaseKind =
  | "learn"
  | "watch"
  | "guided"
  | "practice"
  | "knowledgeCheck"
  | "recap";

export const LESSON_PHASE_ORDER: readonly LessonPhaseKind[] = [
  "learn",
  "watch",
  "guided",
  "practice",
  "knowledgeCheck",
  "recap",
];

export function phaseLabelKey(kind: LessonPhaseKind): string {
  return `learn.player.phases.${kind}`;
}

/**
 * The phases THIS lesson actually has. Missing optional content is skipped,
 * never rendered as an empty phase. The existing guided exercise is included
 * whenever the lesson has steps, which keeps all 20 authored lessons working.
 */
export function lessonPhasePlan(lesson: Lesson): LessonPhaseKind[] {
  const plan: LessonPhaseKind[] = [];
  if (lesson.phases?.learn) plan.push("learn");
  if (lesson.phases?.watch && lesson.phases.watch.steps.length > 0) plan.push("watch");
  if (lesson.steps.length > 0) plan.push("guided");
  if (lesson.phases?.practice && lesson.phases.practice.length > 0) plan.push("practice");
  if (lesson.phases?.knowledgeCheck) plan.push("knowledgeCheck");
  if (lesson.phases?.recap) plan.push("recap");
  return plan;
}

export type LessonPhaseState = {
  readonly plan: readonly LessonPhaseKind[];
  /** Index into the plan. Always a valid index. */
  readonly index: number;
  /** Index into the lesson's practice positions (only meaningful in practice). */
  readonly practiceIndex: number;
};

/** Build a phase state, clamping a stale persisted index into the real plan. */
export function createLessonPhaseState(
  lesson: Lesson,
  resumeIndex = 0,
): LessonPhaseState {
  const plan = lessonPhasePlan(lesson);
  const safe = Number.isFinite(resumeIndex) ? Math.floor(resumeIndex) : 0;
  return {
    plan,
    index: Math.max(0, Math.min(safe, Math.max(0, plan.length - 1))),
    practiceIndex: 0,
  };
}

export function currentLessonPhase(state: LessonPhaseState): LessonPhaseKind | null {
  return state.plan[state.index] ?? null;
}

export function isLastLessonPhase(state: LessonPhaseState): boolean {
  return state.index >= state.plan.length - 1;
}

/** Explicit forward transition. Returns null at the final phase. */
export function nextLessonPhase(state: LessonPhaseState): LessonPhaseState | null {
  if (isLastLessonPhase(state)) return null;
  return { plan: state.plan, index: state.index + 1, practiceIndex: 0 };
}

/** Explicit backward transition. Returns null on the first phase. */
export function previousLessonPhase(state: LessonPhaseState): LessonPhaseState | null {
  if (state.index <= 0) return null;
  return { plan: state.plan, index: state.index - 1, practiceIndex: 0 };
}

export function withPracticeIndex(
  state: LessonPhaseState,
  practiceIndex: number,
): LessonPhaseState {
  const safe = Number.isFinite(practiceIndex) ? Math.floor(practiceIndex) : 0;
  return { ...state, practiceIndex: Math.max(0, safe) };
}

export function phaseProgress(state: LessonPhaseState): {
  current: number;
  total: number;
  percent: number;
} {
  const total = state.plan.length;
  return {
    current: state.index + 1,
    total,
    percent: total > 0 ? (state.index / total) * 100 : 0,
  };
}

// ── Demonstration ─────────────────────────────────────────────────────────
//
// Demonstrations run on the REAL board via initialStateFromDeal + applyMove.
// Nothing is animated by hand and no fake cards are created.

export type DemoSession = {
  readonly watch: LessonWatchContent;
  readonly state: SolitaireState;
  /** How many demonstration actions have been applied. */
  readonly stepIndex: number;
};

export type DemoAdvanceResult =
  | { readonly ok: true; readonly session: DemoSession }
  | { readonly ok: false; readonly session: DemoSession; readonly reason: "complete" | "illegal" };

export function createDemoSession(watch: LessonWatchContent): DemoSession {
  return {
    watch,
    state: initialStateFromDeal(watch.deal),
    stepIndex: 0,
  };
}

export function demoCurrentStep(session: DemoSession): LessonDemoStep | null {
  return session.watch.steps[session.stepIndex] ?? null;
}

export function demoIsComplete(session: DemoSession): boolean {
  return session.stepIndex >= session.watch.steps.length;
}

/**
 * Apply exactly one demonstration action. A second call while a transition is
 * in flight is naturally idempotent because the caller owns the returned
 * session and the next step comes from stepIndex.
 */
export function demoNext(session: DemoSession): DemoAdvanceResult {
  const step = demoCurrentStep(session);
  if (!step) return { ok: false, session, reason: "complete" };

  const normalized = normalizeMove(step.move);
  if (!normalized.ok) return { ok: false, session, reason: "illegal" };

  const applied = applyMove({ state: session.state, move: normalized.move });
  if (!applied.ok) return { ok: false, session, reason: "illegal" };

  return {
    ok: true,
    session: {
      watch: session.watch,
      state: applied.state,
      stepIndex: session.stepIndex + 1,
    },
  };
}

export function demoReplay(watch: LessonWatchContent): DemoSession {
  return createDemoSession(watch);
}

// ── Knowledge check ───────────────────────────────────────────────────────

export type KnowledgeCheckResult = {
  readonly correct: boolean;
  readonly explanationKey: string;
};

/**
 * Validate one answer. Returning null means the option id was not part of the
 * question, so a stale/forged answer can never be treated as correct.
 */
export function checkKnowledgeAnswer(
  check: LessonKnowledgeCheck,
  optionId: string,
): KnowledgeCheckResult | null {
  if (!check.options.some((option) => option.id === optionId)) return null;
  return {
    correct: optionId === check.correctOptionId,
    explanationKey: check.explanationKey,
  };
}

export function isKnowledgeAnswerCorrect(
  check: LessonKnowledgeCheck,
  optionId: string,
): boolean {
  return checkKnowledgeAnswer(check, optionId)?.correct === true;
}

// ── Independent practice ──────────────────────────────────────────────────

export function practicePositions(lesson: Lesson): readonly LessonPracticePosition[] {
  return lesson.phases?.practice ?? [];
}

export function practicePosition(
  lesson: Lesson,
  index: number,
): LessonPracticePosition | null {
  return practicePositions(lesson)[index] ?? null;
}

/**
 * Wrap one practice position as a synthetic Lesson so the existing engine can
 * run it unchanged. The synthetic id is never written to progress; practice is
 * for experimentation and does not alter course history.
 */
export function practiceLesson(lesson: Lesson, index: number): Lesson | null {
  const position = practicePosition(lesson, index);
  if (!position) return null;

  return {
    ...lesson,
    id: `${lesson.id}:practice:${position.id}`,
    deal: position.deal,
    steps: position.steps,
    successKey: position.successKey ?? lesson.successKey,
    completion: undefined,
    phases: undefined,
  };
}
