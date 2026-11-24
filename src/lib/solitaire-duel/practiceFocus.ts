// src/lib/solitaire-duel/practiceFocus.ts
//
// PURE: the one practiced skill worth drilling, read from the device-local
// practice record the caller already holds.
//
// Practice progress is device-local by design (see practiceProgress.ts) and is
// never sent to the server, so the weakness cannot be detected inside
// `/api/home/dashboard`. The dashboard component therefore reads the record it
// already has and asks this module for one deterministic answer: which practiced
// skill has the weakest recorded results, why it is flagged, and which validated
// drill targets it.
//
// ── HONESTY RULES ─────────────────────────────────────────────────────────
//
//   * A skill needs a MINIMUM SAMPLE before it can be flagged; one failed
//     attempt is not a weakness.
//   * The thresholds mirror COACHING_THRESHOLDS (minAttemptsPerSkill = 2,
//     lowSuccessRate = 60) and the tests pin them equal, so the Academy's
//     coaching report and this card can never disagree about what "weak" means.
//   * The flag is reported, not hidden: a 100% completion record can only be
//     flagged for hint use (or an unfinished drill), and `detail` says exactly
//     that instead of calling a perfect completion rate weak.
//   * Only authored skills with a validated exercise can be returned. An
//     unknown or stale id from an older storage payload is ignored, never
//     linked.
//   * Ordering is a total order (rate, unfinished, hints, skill id), so the same
//     record always yields the same drill.
//
// Nothing here reads storage, calls the network, or grades a competitive game.

import { LEARN_PRACTICE_TRANSLATIONS } from "../learnPracticeTranslations";
import { PRACTICE_SKILL_BY_ID, practiceDifficultiesFor } from "./practice";
import type { PracticeProgressState } from "./practiceProgress";

/** A skill needs this many attempts before it can be called a weak area. */
export const PRACTICE_FOCUS_MIN_ATTEMPTS = 2;

/** Below this completion rate, with enough attempts, a skill is a weak area. */
export const PRACTICE_FOCUS_LOW_SUCCESS_RATE = 60;

/** The struggle signal the drill is answering, in the same priority as coaching. */
export type PracticeFocusReason = "low-success" | "hint-reliance" | "unfinished";

export type PracticeFocus = {
  readonly skillId: string;
  /** The skill's English title, the same label Practice renders. */
  readonly label: string;
  readonly reason: PracticeFocusReason;
  /** A clause describing only the recorded fact behind `reason`. */
  readonly detail: string;
  /** A deep link that preselects the validated drill on the Practice page. */
  readonly href: string;
};

const SKILL_TITLES = LEARN_PRACTICE_TRANSLATIONS.en.skills as Record<
  string,
  { title?: string }
>;

type Candidate = {
  skillId: string;
  label: string;
  attempts: number;
  completions: number;
  hints: number;
  successRate: number;
  unfinished: number;
};

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The single flagged practiced skill with a validated drill, or null.
 *
 * Null is the normal answer for a player with too little practice data or a
 * clean record; the dashboard then keeps its account-level recommendation.
 */
export function weakestPracticeFocus(
  progress: PracticeProgressState | null | undefined,
): PracticeFocus | null {
  const bySkill = progress?.bySkill;
  if (!bySkill || typeof bySkill !== "object") return null;

  const candidates: Candidate[] = [];

  for (const [skillId, bucket] of Object.entries(bySkill)) {
    const skill = PRACTICE_SKILL_BY_ID[skillId];
    if (!skill) continue;

    const attempts = count(bucket?.attempts);
    if (attempts < PRACTICE_FOCUS_MIN_ATTEMPTS) continue;

    const completions = Math.min(attempts, count(bucket?.completions));
    const hints = count(bucket?.hints);
    const successRate = Math.round((completions / attempts) * 100);
    const unfinished = attempts - completions;

    // The same three struggle signals the coaching report uses.
    const weak =
      successRate < PRACTICE_FOCUS_LOW_SUCCESS_RATE ||
      hints >= attempts ||
      unfinished > 0;
    if (!weak) continue;

    const title = SKILL_TITLES[skill.id]?.title;
    if (!title) continue;

    candidates.push({
      skillId: skill.id,
      label: title,
      attempts,
      completions,
      hints,
      successRate,
      unfinished,
    });
  }

  candidates.sort(
    (a, b) =>
      a.successRate - b.successRate ||
      b.unfinished - a.unfinished ||
      b.hints - a.hints ||
      a.skillId.localeCompare(b.skillId),
  );

  for (const candidate of candidates) {
    // Only difficulties with a validated exercise are returned.
    const difficulty = practiceDifficultiesFor(candidate.skillId)[0];
    if (!difficulty) continue;

    // Same priority as the coaching engine: a low completion rate first, then
    // hint reliance, then unfinished attempts. The copy names only this signal.
    const reason: PracticeFocusReason =
      candidate.successRate < PRACTICE_FOCUS_LOW_SUCCESS_RATE
        ? "low-success"
        : candidate.hints >= candidate.attempts
          ? "hint-reliance"
          : "unfinished";
    const detail =
      reason === "low-success"
        ? `a ${candidate.successRate}% completion rate across ${candidate.attempts} attempts`
        : reason === "hint-reliance"
          ? "hint use on every recorded attempt"
          : `${candidate.unfinished} of ${candidate.attempts} attempts left unfinished`;

    const query = new URLSearchParams({
      skill: candidate.skillId,
      difficulty,
    });

    return {
      skillId: candidate.skillId,
      label: candidate.label,
      reason,
      detail,
      href: `/learn/practice?${query.toString()}`,
    };
  }

  return null;
}
