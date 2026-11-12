// src/lib/solitaire-duel/lessons.ts
//
// THE INTERACTIVE LESSON ENGINE.
//
// A lesson is DATA plus a small set of pure functions. Nothing here knows about
// a route, a component, analytics, ranked matches, bots or persistence: the
// engine owns one in-memory `SolitaireState` and evaluates whether the player
// has reached the lesson's objective.
//
// ── THE RULES ENGINE IS NOT DUPLICATED ────────────────────────────────────
//
// Every player move is normalised and applied by `applyMove` — the same
// authority used by Solo, the Daily Challenge, the tutorial and the duel store.
// An illegal move is refused by the engine, never by lesson code. A lesson can
// therefore never invent a move the rest of the game would reject.
//
// ── OBJECTIVES, NOT MOVE SCRIPTS ──────────────────────────────────────────
//
// A step is complete when EITHER its state predicate is true, OR the move the
// player made is one of the step's explicit acceptable moves. That is what lets
// two different strategies satisfy the same objective, and what stops the
// engine from marking every legal move as "correct": a legal move that advances
// neither condition is accepted by the board (experimentation is free) but its
// feedback is `off-goal`, never `correct`.
//
// ── MULTI-STEP LESSONS ────────────────────────────────────────────────────
//
// Steps are ordered. A move may satisfy several steps at once (for example a
// tableau move that both places a card and flips the card underneath); the
// evaluation cascades in order. Undo replays the canonical log from the
// prepared deal, so progress is always a pure function of (lesson, log) and can
// never drift from the board.
//
// ── ISOLATION ─────────────────────────────────────────────────────────────
//
// This module imports only the pure engine and its types. It has no fetch, no
// storage, no matchmaking, no queue, no rating, no trophy, no quest and no AI
// call, so a lesson cannot create a ranked game or change a competitive record.

import {
  TABLEAU_COLUMNS,
} from "./constants";
import {
  applyMove,
  initialStateFromDeal,
  isRank,
  isSuit,
  isWellFormedState,
  normalizeMove,
} from "./rules";
import type {
  Card,
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
} from "./types";

// ── Definition types ──────────────────────────────────────────────────────

export type LessonDifficulty = "beginner" | "intermediate" | "advanced";

/** Catalog metadata for the course a lesson belongs to (no execution logic). */
export type LessonCourse = {
  readonly id: string;
  readonly order: number;
  readonly titleKey: string;
  readonly descriptionKey: string;
};

/**
 * One progressively more specific clue.
 *
 * `revealsSolution` is opt-in per hint: an ordinary hint never names a move.
 * Only a hint that explicitly asks for it can return a legal solution move.
 */
export type LessonHint = {
  readonly textKey: string;
  readonly revealsSolution?: boolean;
};

/** One intermediate objective inside a lesson. */
export type LessonStep = {
  /** Stable inside the lesson; used by feedback and tests. */
  readonly id: string;
  /** Instruction shown while this is the current objective. */
  readonly instructionKey: string;
  /** Why the completed objective was the right idea. */
  readonly explanationKey: string;
  /** Why a legal move that did not advance this step does not satisfy it. */
  readonly incorrectKey?: string;
  /** The learning objective, as a predicate over the REAL board. */
  readonly done: (state: SolitaireState) => boolean;
  /**
   * Explicit acceptable moves for this step, in addition to `done`. Still
   * validated by the engine before they can advance anything.
   */
  readonly acceptableMoves?: readonly SolitaireMove[];
  /** Progressive hints, from general to specific. */
  readonly hints?: readonly LessonHint[];
};

export type Lesson = {
  /** Stable, globally unique id (also the catalog lookup key). */
  readonly id: string;
  readonly courseId: string;
  /** Ordering inside the course; validated unique per course. */
  readonly order: number;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly difficulty: LessonDifficulty;
  /** Estimated minutes, a positive integer. */
  readonly estimatedMinutes: number;
  /** A complete, unique 52-card prepared position. */
  readonly deal: SolitaireDeal;
  /** Ordered intermediate objectives; the last one completes the lesson. */
  readonly steps: readonly LessonStep[];
  /**
   * Optional whole-lesson condition checked after every step is complete
   * (e.g. a move-count or no-pull-back rule).
   */
  readonly completion?: (state: SolitaireState) => boolean;
  /** Copy shown when the lesson is complete. */
  readonly successKey: string;
};

export type LessonLogEntry = {
  readonly kind: SolitaireMove["kind"];
  readonly move: SolitaireMove;
};

export type LessonSession = {
  readonly lesson: Lesson;
  readonly deal: SolitaireDeal;
  readonly state: SolitaireState;
  readonly log: LessonLogEntry[];
  /** Count of completed steps; also the index of the current step. */
  readonly stepIndex: number;
  readonly completedStepIds: string[];
  readonly completed: boolean;
  /** Log length at which the lesson was completed, or null. */
  readonly completedAtPly: number | null;
  /** How many hints of the CURRENT step have been revealed. */
  readonly hintIndex: number;
  /** Total hints revealed across the session (never reset by undo). */
  readonly hintsUsed: number;
  /** Legal-but-off-goal and refused attempts. Informational, never a penalty. */
  readonly attempts: number;
};

export type LessonProgress = {
  readonly lessonId: string;
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly completedStepIds: readonly string[];
  readonly completed: boolean;
  readonly hintsUsed: number;
  readonly attempts: number;
  readonly moves: number;
};

// ── Feedback ──────────────────────────────────────────────────────────────

export type LessonFeedback =
  | {
      readonly kind: "correct";
      readonly messageKey: string;
      /** The newly completed steps, in order. */
      readonly completedStepIds: readonly string[];
      readonly explanationKey: string;
    }
  | {
      readonly kind: "incorrect";
      /** `illegal` = the engine refused it; `off-goal` = legal but not helpful. */
      readonly reason: "illegal" | "off-goal";
      readonly messageKey: string;
      /** Engine or step-specific explanation, for the UI’s detail line. */
      readonly detail?: string;
      readonly nextInstructionKey?: string;
    }
  | {
      readonly kind: "complete";
      readonly messageKey: string;
      readonly successKey: string;
      readonly completedStepIds: readonly string[];
    };

export type LessonMoveResult = {
  readonly session: LessonSession;
  /** True when the ENGINE accepted the move (also true for an off-goal move). */
  readonly accepted: boolean;
  /** True when the move advanced at least one lesson step. */
  readonly advanced: boolean;
  readonly feedback: LessonFeedback;
};

export type LessonHintResult = {
  readonly session: LessonSession;
  readonly hint: {
    /** 1-based. */
    readonly level: number;
    readonly maxLevel: number;
    readonly textKey: string;
    /**
     * A legal canonical move, only when this hint explicitly reveals the
     * solution. Never populated for an ordinary clue.
     */
    readonly solutionMove: SolitaireMove | null;
  } | null;
  readonly messageKey: string;
};

// ── Validation ────────────────────────────────────────────────────────────

export type LessonValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  return isSuit(value.suit) && isRank(value.rank);
}

function cardKey(card: Card): string {
  return `${card.suit}-${card.rank}`;
}

/**
 * A lesson deal must be a complete, unique deck in a well-formed seven-column
 * board. A prepared position is still a real deal: fewer than 52 cards would
 * make later replay and foundation completion dishonest.
 */
function dealErrors(deal: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(deal)) return ["The starting position must be a SolitaireDeal."];
  if (!isNonEmptyString(deal.variant)) errors.push("The deal has no variant.");
  if (!Number.isInteger(deal.variantVersion)) errors.push("The deal has no variant version.");
  if (!Array.isArray(deal.tableau)) {
    return [...errors, "The deal tableau must be an array."];
  }
  if (deal.tableau.length !== TABLEAU_COLUMNS) {
    errors.push(`The deal must have exactly ${TABLEAU_COLUMNS} tableau columns.`);
  }

  const cards: Card[] = [];
  deal.tableau.forEach((column, columnIndex) => {
    if (!Array.isArray(column)) {
      errors.push(`Tableau column ${columnIndex} is not an array.`);
      return;
    }
    column.forEach((slot, slotIndex) => {
      if (!isRecord(slot) || typeof slot.faceUp !== "boolean") {
        errors.push(`Tableau slot ${columnIndex}:${slotIndex} is malformed.`);
        return;
      }
      if (!isCard(slot.card)) {
        errors.push(`Tableau slot ${columnIndex}:${slotIndex} has no card identity.`);
        return;
      }
      cards.push(slot.card);
    });
  });

  if (!Array.isArray(deal.stock)) {
    errors.push("The deal stock must be an array.");
  } else {
    deal.stock.forEach((card, index) => {
      if (!isCard(card)) errors.push(`Stock card ${index} is malformed.`);
      else cards.push(card);
    });
  }

  if (cards.length !== 52) errors.push(`A lesson deal must hold 52 cards, got ${cards.length}.`);
  const unique = new Set(cards.map(cardKey));
  if (unique.size !== cards.length) errors.push("A lesson deal contains duplicate cards.");

  if (errors.length === 0) {
    const initial = initialStateFromDeal(deal as SolitaireDeal);
    if (!isWellFormedState(initial)) errors.push("The deal does not produce a well-formed board.");
  }
  return errors;
}

/**
 * Validate one lesson definition.
 *
 * This is intentionally strict: a catalog is authored data, and a broken
 * definition must fail at load/test time rather than producing an unwinnable
 * exercise. It also enforces that no step is already satisfied by the opening
 * position, so a lesson can never begin complete.
 */
export function validateLessonDefinition(lesson: unknown): LessonValidation {
  if (!isRecord(lesson)) {
    return { ok: false, errors: ["A lesson definition must be an object."] };
  }

  const errors: string[] = [];
  for (const field of ["id", "courseId", "titleKey", "descriptionKey", "successKey"] as const) {
    if (!isNonEmptyString(lesson[field])) errors.push(`Lesson ${field} must be a non-empty string.`);
  }
  if (!Number.isInteger(lesson.order) || (lesson.order as number) < 0) {
    errors.push("Lesson order must be a non-negative integer.");
  }
  if (
    lesson.difficulty !== "beginner" &&
    lesson.difficulty !== "intermediate" &&
    lesson.difficulty !== "advanced"
  ) {
    errors.push("Lesson difficulty must be beginner, intermediate or advanced.");
  }
  if (
    !Number.isInteger(lesson.estimatedMinutes) ||
    (lesson.estimatedMinutes as number) <= 0
  ) {
    errors.push("Lesson estimatedMinutes must be a positive integer.");
  }
  if (lesson.completion !== undefined && typeof lesson.completion !== "function") {
    errors.push("Lesson completion must be a function when present.");
  }

  const dealIssues = dealErrors(lesson.deal);
  errors.push(...dealIssues);

  if (!Array.isArray(lesson.steps) || lesson.steps.length === 0) {
    errors.push("A lesson must define at least one step.");
    return { ok: false, errors };
  }

  const stepIds = new Set<string>();
  let initialState: SolitaireState | null = null;
  if (dealIssues.length === 0) {
    initialState = initialStateFromDeal(lesson.deal as SolitaireDeal);
  }

  lesson.steps.forEach((step, index) => {
    if (!isRecord(step)) {
      errors.push(`Step ${index} must be an object.`);
      return;
    }
    if (!isNonEmptyString(step.id)) errors.push(`Step ${index} has no id.`);
    else if (stepIds.has(step.id)) errors.push(`Step id "${step.id}" is duplicated.`);
    else stepIds.add(step.id);

    for (const field of ["instructionKey", "explanationKey"] as const) {
      if (!isNonEmptyString(step[field])) {
        errors.push(`Step ${step.id ?? index} needs a ${field}.`);
      }
    }
    if (typeof step.done !== "function") {
      errors.push(`Step ${step.id ?? index} needs a done predicate.`);
    }

    if (step.acceptableMoves !== undefined) {
      if (!Array.isArray(step.acceptableMoves)) {
        errors.push(`Step ${step.id ?? index} acceptableMoves must be an array.`);
      } else {
        step.acceptableMoves.forEach((move, moveIndex) => {
          if (!normalizeMove(move).ok) {
            errors.push(
              `Step ${step.id ?? index} acceptable move ${moveIndex} is not a legal move shape.`,
            );
          }
        });
      }
    }

    if (step.hints !== undefined) {
      if (!Array.isArray(step.hints)) {
        errors.push(`Step ${step.id ?? index} hints must be an array.`);
      } else {
        step.hints.forEach((hint, hintIndex) => {
          if (!isRecord(hint) || !isNonEmptyString(hint.textKey)) {
            errors.push(`Step ${step.id ?? index} hint ${hintIndex} needs a textKey.`);
          } else if (
            hint.revealsSolution !== undefined &&
            typeof hint.revealsSolution !== "boolean"
          ) {
            errors.push(
              `Step ${step.id ?? index} hint ${hintIndex} revealsSolution must be boolean.`,
            );
          }
        });
      }
    }

    if (initialState && typeof step.done === "function") {
      try {
        if ((step.done as (state: SolitaireState) => boolean)(initialState)) {
          errors.push(
            `Step ${step.id ?? index} is already complete in the opening position.`,
          );
        }
      } catch {
        errors.push(`Step ${step.id ?? index} threw while evaluating the opening position.`);
      }
    }
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Validate a whole catalog, including ids and course ordering uniqueness. */
export function validateLessonCatalog(lessons: readonly unknown[]): LessonValidation {
  if (!Array.isArray(lessons) || lessons.length === 0) {
    return { ok: false, errors: ["A lesson catalog must contain at least one lesson."] };
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  const courseOrders = new Set<string>();

  lessons.forEach((lesson, index) => {
    const id = isRecord(lesson) && isNonEmptyString(lesson.id) ? lesson.id : `#${index}`;
    if (isRecord(lesson) && isNonEmptyString(lesson.id)) {
      if (ids.has(lesson.id)) errors.push(`Lesson id "${lesson.id}" appears more than once.`);
      ids.add(lesson.id);
    }
    if (
      isRecord(lesson) &&
      isNonEmptyString(lesson.courseId) &&
      Number.isInteger(lesson.order)
    ) {
      const slot = `${lesson.courseId}:${lesson.order}`;
      if (courseOrders.has(slot)) {
        errors.push(`Two lessons share course "${lesson.courseId}" order ${lesson.order}.`);
      }
      courseOrders.add(slot);
    }

    const one = validateLessonDefinition(lesson);
    if (!one.ok) {
      const detail = "errors" in one ? one.errors : [];
      errors.push(...detail.map((error) => `${id}: ${error}`));
    }
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── Session construction ──────────────────────────────────────────────────

type Replay = {
  readonly state: SolitaireState;
  readonly states: readonly SolitaireState[];
  readonly ok: boolean;
};

function replayForLesson(deal: SolitaireDeal, log: readonly LessonLogEntry[]): Replay {
  let state = initialStateFromDeal(deal);
  const states: SolitaireState[] = [state];

  for (const entry of log) {
    const normalized = normalizeMove(entry.move);
    if (!normalized.ok || normalized.move.kind !== entry.kind) {
      return { state, states, ok: false };
    }
    const applied = applyMove({ state, move: normalized.move });
    if (!applied.ok) return { state, states, ok: false };
    state = applied.state;
    states.push(state);
  }

  return { state, states, ok: true };
}

function moveKey(move: SolitaireMove): string {
  const normalized = normalizeMove(move);
  return normalized.ok ? JSON.stringify(normalized.move) : "";
}

function sameMove(a: SolitaireMove, b: SolitaireMove): boolean {
  return moveKey(a) === moveKey(b);
}

/**
 * Walk the steps in order over the replayed log.
 *
 * `fromPly` is the prefix where the previous step was satisfied. The next step
 * may be satisfied by that SAME position (a cascade), but an explicit
 * acceptable move only counts when it is a LATER move than the previous step's.
 */
function evaluateLesson(
  lesson: Lesson,
  states: readonly SolitaireState[],
  log: readonly LessonLogEntry[],
): Pick<LessonSession, "stepIndex" | "completedStepIds" | "completed" | "completedAtPly"> {
  const completedStepIds: string[] = [];
  let fromPly = 0;
  let lastStepPly: number | null = null;

  for (const step of lesson.steps) {
    let satisfiedAt = -1;
    for (let ply = fromPly; ply < states.length; ply += 1) {
      if (step.done(states[ply])) {
        satisfiedAt = ply;
        break;
      }
      if (ply > fromPly) {
        const move = log[ply - 1]?.move;
        if (move && step.acceptableMoves?.some((accepted) => sameMove(accepted, move))) {
          satisfiedAt = ply;
          break;
        }
      }
    }
    if (satisfiedAt < 0) break;
    completedStepIds.push(step.id);
    lastStepPly = satisfiedAt;
    fromPly = satisfiedAt;
  }

  const finalState = states[states.length - 1];
  const allStepsDone = completedStepIds.length === lesson.steps.length;
  const completionSatisfied =
    allStepsDone && (!lesson.completion || lesson.completion(finalState));
  const completedAtPly = completionSatisfied
    ? lesson.completion
      ? states.length - 1
      : lastStepPly
    : null;

  return {
    stepIndex: completedStepIds.length,
    completedStepIds,
    completed: completionSatisfied,
    completedAtPly,
  };
}

/**
 * A fresh session from a prepared position.
 *
 * Throws on an invalid definition: callers that load authored data should use
 * `validateLessonDefinition` first, but a malformed lesson can never silently
 * become a playable exercise.
 */
export function createLessonSession(lesson: Lesson): LessonSession {
  const validation = validateLessonDefinition(lesson);
  if (!validation.ok) {
    const detail = "errors" in validation ? validation.errors : [];
    throw new Error(`Invalid lesson definition: ${detail.join("; ")}`);
  }

  const replay = replayForLesson(lesson.deal, []);
  return {
    lesson,
    deal: lesson.deal,
    state: replay.state,
    log: [],
    ...evaluateLesson(lesson, replay.states, []),
    hintIndex: 0,
    hintsUsed: 0,
    attempts: 0,
  };
}

// ── Moves ─────────────────────────────────────────────────────────────────

function incorrect(
  session: LessonSession,
  reason: "illegal" | "off-goal",
  messageKey: string,
  extra: { detail?: string; nextInstructionKey?: string } = {},
  accepted = reason === "off-goal",
): LessonMoveResult {
  return {
    session: { ...session, attempts: session.attempts + 1 },
    accepted,
    advanced: false,
    feedback: {
      kind: "incorrect",
      reason,
      messageKey,
      ...extra,
    },
  };
}

/**
 * Validate and apply one player move.
 *
 * The returned session is always a NEW object. The input session and its board
 * are never mutated, so two lessons (or two attempts) can never share state.
 */
export function applyLessonMove(session: LessonSession, move: unknown): LessonMoveResult {
  if (session.completed) {
    // Nothing was applied: a finished lesson is not a place to keep playing.
    return incorrect(session, "off-goal", "learn.feedback.alreadyComplete", {}, false);
  }

  const normalized = normalizeMove(move);
  if (!normalized.ok) {
    return incorrect(session, "illegal", "learn.feedback.illegal", {
      detail: "error" in normalized ? normalized.error : undefined,
      nextInstructionKey: session.lesson.steps[session.stepIndex]?.instructionKey,
    });
  }

  const applied = applyMove({ state: session.state, move: normalized.move });
  if (!applied.ok) {
    return incorrect(session, "illegal", "learn.feedback.illegal", {
      detail: applied.error,
      nextInstructionKey: session.lesson.steps[session.stepIndex]?.instructionKey,
    });
  }

  const entry: LessonLogEntry = { kind: normalized.move.kind, move: normalized.move };
  const log = [...session.log, entry];
  const replay = replayForLesson(session.deal, log);
  const evaluation = evaluateLesson(session.lesson, replay.states, log);

  const advanced = evaluation.stepIndex > session.stepIndex;
  const newlyCompleted = evaluation.completedStepIds.slice(session.stepIndex);
  const lastStep = newlyCompleted.length
    ? session.lesson.steps.find((step) => step.id === newlyCompleted[newlyCompleted.length - 1])
    : null;

  const next: LessonSession = {
    ...session,
    state: replay.state,
    log,
    ...evaluation,
    hintIndex: advanced ? 0 : session.hintIndex,
    attempts: advanced ? session.attempts : session.attempts + 1,
  };

  if (evaluation.completed) {
    return {
      session: next,
      accepted: true,
      advanced: true,
      feedback: {
        kind: "complete",
        messageKey: "learn.feedback.complete",
        successKey: session.lesson.successKey,
        completedStepIds: evaluation.completedStepIds,
      },
    };
  }

  if (advanced) {
    return {
      session: next,
      accepted: true,
      advanced: true,
      feedback: {
        kind: "correct",
        messageKey: "learn.feedback.correct",
        completedStepIds: newlyCompleted,
        explanationKey:
          lastStep?.explanationKey ?? session.lesson.steps[session.stepIndex]?.explanationKey ?? session.lesson.successKey,
      },
    };
  }

  const current = session.lesson.steps[session.stepIndex] ?? null;
  return {
    session: next,
    accepted: true,
    advanced: false,
    feedback: {
      kind: "incorrect",
      reason: "off-goal",
      messageKey: current?.incorrectKey ?? "learn.feedback.offGoal",
      nextInstructionKey: current?.instructionKey,
    },
  };
}

// ── Hints ─────────────────────────────────────────────────────────────────

function firstLegalAcceptableMove(
  session: LessonSession,
  step: LessonStep | null,
): SolitaireMove | null {
  for (const candidate of step?.acceptableMoves ?? []) {
    const normalized = normalizeMove(candidate);
    if (!normalized.ok) continue;
    if (applyMove({ state: session.state, move: normalized.move }).ok) {
      return normalized.move;
    }
  }
  return null;
}

/**
 * Reveal the next hint for the current step.
 *
 * Hints are progressive because they are returned in definition order; the
 * engine tracks how many have been used. A solution move is returned ONLY when
 * the hint says `revealsSolution: true`, and even then it is checked against the
 * live board before being offered.
 */
export function requestLessonHint(session: LessonSession): LessonHintResult {
  if (session.completed) {
    return { session, hint: null, messageKey: "learn.feedback.complete" };
  }

  const step = session.lesson.steps[session.stepIndex] ?? null;
  const hints = step?.hints ?? [];
  if (!step || session.hintIndex >= hints.length) {
    return { session, hint: null, messageKey: "learn.feedback.noMoreHints" };
  }

  const hint = hints[session.hintIndex];
  const level = session.hintIndex + 1;
  const next: LessonSession = {
    ...session,
    hintIndex: level,
    hintsUsed: session.hintsUsed + 1,
  };

  return {
    session: next,
    hint: {
      level,
      maxLevel: hints.length,
      textKey: hint.textKey,
      solutionMove: hint.revealsSolution ? firstLegalAcceptableMove(session, step) : null,
    },
    messageKey: hint.textKey,
  };
}

// ── Undo / restart / progress ─────────────────────────────────────────────

/**
 * Undo the last accepted move by replaying the remaining log.
 *
 * Hint usage stays counted (it genuinely happened). Progress, completion and
 * the board are recomputed, so undo can never leave the lesson believing a
 * step is complete when its board says otherwise.
 */
export function undoLessonMove(session: LessonSession): LessonSession {
  if (session.log.length === 0) return session;

  const log = session.log.slice(0, -1);
  const replay = replayForLesson(session.deal, log);
  const evaluation = evaluateLesson(session.lesson, replay.states, log);

  return {
    ...session,
    state: replay.state,
    log,
    ...evaluation,
    hintIndex: 0,
  };
}

/** A fresh attempt at the same prepared position. */
export function restartLesson(session: LessonSession): LessonSession {
  return createLessonSession(session.lesson);
}

export function lessonProgress(session: LessonSession): LessonProgress {
  return {
    lessonId: session.lesson.id,
    stepIndex: session.stepIndex,
    totalSteps: session.lesson.steps.length,
    completedStepIds: [...session.completedStepIds],
    completed: session.completed,
    hintsUsed: session.hintsUsed,
    attempts: session.attempts,
    moves: session.log.length,
  };
}
