"use client";

// src/components/learn/LearnPracticePage.tsx
//
// The Practice area: choose a skill area, a skill and a level, then play ONE
// prepared exercise on the real board.
//
// It reuses, and does not duplicate:
//   * `SolitaireBoard` + `viewForState` for card rendering and interaction;
//   * the lesson engine (`createLessonSession` / `applyLessonMove` /
//     `requestLessonHint` / `restartLesson`) for move validation and objectives;
//   * the validated practice catalog for positions, difficulty and solutions.
//
// Completion is a simple screen: the drill is over, so the only actions are
// "try another exercise" and "return to practice". Practice progress is read
// from its own local store and never touches lesson progress or a ranked record.

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBulb,
  IconCheck,
  IconRefresh,
  IconTargetArrow,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import SolitaireBoard from "../solitaire-duel/SolitaireBoard";
import LearnSubnav from "./LearnSubnav";
import { usePracticeProgress } from "../../hooks/usePracticeProgress";
import { useTranslation } from "../../hooks/useTranslation";
import {
  PRACTICE_DIFFICULTIES,
  applyPracticeMove,
  createPracticeSession,
  practiceCategories,
  practiceDifficultiesFor,
  practiceExerciseCount,
  practiceExercisesFor,
  practiceSkill,
  practiceSolutionMove,
  practiceSkillsForCategory,
  requestPracticeHint,
  restartPractice,
  nextPracticeExercise,
  type PracticeCategoryId,
  type PracticeDifficulty,
  type PracticeExercise,
} from "../../lib/solitaire-duel/practice";
import type {
  LessonFeedback,
  LessonHintResult,
  LessonSession,
} from "../../lib/solitaire-duel/lessons";
import { practiceStats } from "../../lib/solitaire-duel/practiceProgress";
import { viewForState } from "../../lib/solitaire-duel/rules";
import type { SolitaireMove } from "../../lib/solitaire-duel/types";

const CARD = "rounded-2xl border border-white/10 bg-[#06152f]/90 p-4 sm:p-5";
const KICKER = "text-[10px] font-black uppercase tracking-[0.28em] text-[#00e5ff]/80";
const PRIMARY =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-4 py-2 text-sm font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-bold text-[#9dd8ff] transition hover:bg-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]";

type ActivePractice = {
  readonly exercise: PracticeExercise;
  readonly session: LessonSession;
  readonly feedback: LessonFeedback | null;
  readonly notice: boolean;
  readonly hint: LessonHintResult["hint"];
  readonly hintMessage: string | null;
  readonly hintMove: SolitaireMove | null;
};

type CompletedPractice = {
  readonly exercise: PracticeExercise;
  readonly moves: number;
  readonly hints: number;
};

function Chip({
  active,
  disabled,
  onClick,
  children,
  testId,
  data,
  pressed,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  testId: string;
  data?: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed ?? active ?? false}
      data-testid={testId}
      data-id={data}
      className={`rounded-xl border px-3 py-2 text-left text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "border-[#00e5ff]/45 bg-[#00e5ff]/12 text-white"
          : "border-white/12 bg-white/[0.03] text-white/60 hover:bg-white/[0.07]"
      }`}
    >
      {children}
    </button>
  );
}

function initialPracticeSelection(
  initialSkillId: string | null,
  initialDifficulty: string | null,
): {
  categoryId: PracticeCategoryId;
  skillId: string;
  difficulty: PracticeDifficulty;
} {
  const categories = practiceCategories();
  const requested = initialSkillId ? practiceSkill(initialSkillId) : null;
  const skill =
    requested ?? practiceSkillsForCategory(categories[0]?.id ?? "tableau")[0] ?? null;
  const levels = skill ? practiceDifficultiesFor(skill.id) : [];
  const difficulty =
    initialDifficulty && levels.includes(initialDifficulty as PracticeDifficulty)
      ? (initialDifficulty as PracticeDifficulty)
      : levels[0] ?? "beginner";
  return {
    categoryId: skill?.categoryId ?? categories[0]?.id ?? "tableau",
    skillId: skill?.id ?? "",
    difficulty,
  };
}

export default function LearnPracticePage({
  initialSkillId = null,
  initialDifficulty = null,
}: {
  initialSkillId?: string | null;
  initialDifficulty?: string | null;
} = {}) {
  const { t } = useTranslation();
  const {
    progress,
    userId,
    startAttempt,
    useHint: recordHint,
    completeAttempt,
  } = usePracticeProgress();

  const categories = useMemo(() => practiceCategories(), []);
  const initial = useMemo(
    () => initialPracticeSelection(initialSkillId, initialDifficulty),
    [initialSkillId, initialDifficulty],
  );
  const [categoryId, setCategoryId] = useState<PracticeCategoryId>(initial.categoryId);
  const skills = useMemo(() => practiceSkillsForCategory(categoryId), [categoryId]);
  const [skillId, setSkillId] = useState(initial.skillId);
  const [difficulty, setDifficulty] = useState<PracticeDifficulty>(initial.difficulty);

  const [active, setActive] = useState<ActivePractice | null>(null);
  const [completed, setCompleted] = useState<CompletedPractice | null>(null);

  const skill = skills.find((entry) => entry.id === skillId) ?? skills[0] ?? null;
  const stats = useMemo(() => practiceStats(progress), [progress]);

  const chooseCategory = (id: PracticeCategoryId) => {
    const nextSkill = practiceSkillsForCategory(id)[0];
    setCategoryId(id);
    setSkillId(nextSkill?.id ?? "");
    setDifficulty(practiceDifficultiesFor(nextSkill?.id ?? "")[0] ?? "beginner");
  };

  const chooseSkill = (id: string) => {
    setSkillId(id);
    setDifficulty(practiceDifficultiesFor(id)[0] ?? "beginner");
  };

  const begin = (exercise: PracticeExercise) => {
    startAttempt({
      exerciseId: exercise.id,
      skillId: exercise.skillId,
      difficulty: exercise.difficulty,
    });
    setCompleted(null);
    setActive({
      exercise,
      session: createPracticeSession(exercise),
      feedback: null,
      notice: false,
      hint: null,
      hintMessage: null,
      hintMove: null,
    });
  };

  const startSelected = () => {
    if (!skill) return;
    const [first] = practiceExercisesFor(skill.id, difficulty);
    if (first) begin(first);
  };

  const onMove = (move: SolitaireMove) => {
    if (!active) return;
    const result = applyPracticeMove(active.session, move);
    setActive({
      ...active,
      session: result.session,
      feedback: result.feedback,
      notice: !result.accepted,
      hint: null,
      hintMessage: null,
      hintMove: null,
    });
    if (result.feedback.kind === "complete") {
      completeAttempt({
        exerciseId: active.exercise.id,
        skillId: active.exercise.skillId,
        difficulty: active.exercise.difficulty,
      });
      setCompleted({
        exercise: active.exercise,
        moves: result.session.log.length,
        hints: result.session.hintsUsed,
      });
    }
  };

  const onHint = () => {
    if (!active) return;
    const result = requestPracticeHint(active.session);
    if (result.hint) {
      recordHint({
        exerciseId: active.exercise.id,
        skillId: active.exercise.skillId,
        difficulty: active.exercise.difficulty,
      });
    }
    setActive({
      ...active,
      session: result.session,
      hint: result.hint,
      hintMessage: result.hint ? null : result.messageKey,
      hintMove: practiceSolutionMove(active.exercise, result.session),
    });
  };

  const onRestart = () => {
    if (!active) return;
    startAttempt({
      exerciseId: active.exercise.id,
      skillId: active.exercise.skillId,
      difficulty: active.exercise.difficulty,
    });
    setCompleted(null);
    setActive({
      exercise: active.exercise,
      session: restartPractice(active.session),
      feedback: null,
      notice: false,
      hint: null,
      hintMessage: null,
      hintMove: null,
    });
  };

  const onAnother = () => {
    if (!completed) return;
    const next = nextPracticeExercise(completed.exercise.id, completed.exercise.difficulty);
    if (next) begin(next);
    else {
      setCompleted(null);
      setActive(null);
    }
  };

  const returnToSetup = () => {
    setCompleted(null);
    setActive(null);
  };

  const exerciseCount = practiceExerciseCount(skill?.id ?? "", difficulty);
  const categoriesWithExercises = categories;

  return (
    <div className="relative min-h-screen overflow-hidden bg-page pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(0,255,163,0.1),transparent_62%)]"
      />
      <NavigationBar currentPath="/learn" />

      <main className="relative mx-auto max-w-5xl px-4 pt-24 sm:px-6 md:pt-28">
        <Link
          href="/learn"
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 transition hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          {t("learn.subnav.back")}
        </Link>

        <LearnSubnav active="practice" />

        <p className="mt-6 text-[10px] font-black uppercase tracking-[0.3em] text-[#00ffa3]/75">
          {t("learn.practice.kicker")}
        </p>
        <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
          {t("learn.practice.title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">
          {t("learn.practice.description")}
        </p>

        {completed ? (
          <section
            aria-label={t("learn.practice.completeAria")}
            data-testid="practice-complete"
            className={`mt-6 ${CARD}`}
          >
            <p className={KICKER}>{t("learn.practice.completeTitle")}</p>
            <h2 className="mt-1 text-xl font-black leading-tight text-[#8dffd0]">
              {t(completed.exercise.titleKey)}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              {t(completed.exercise.successKey)}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-white/55">
              {t("learn.practice.completeLead")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] font-bold text-[#9dd8ff]/70">
              <span>{t("learn.practice.movesUsed", { count: completed.moves })}</span>
              <span>{t("learn.practice.hintsUsed", { count: completed.hints })}</span>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={onAnother} className={PRIMARY} data-testid="practice-another">
                {t("learn.practice.another")}
                <IconArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={returnToSetup}
                className={SECONDARY}
                data-testid="practice-return"
              >
                {t("learn.practice.backToSetup")}
              </button>
            </div>
          </section>
        ) : active ? (
          <section aria-label={t("learn.practice.boardAria")} className={`mt-6 ${CARD}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className={KICKER}>{t(active.exercise.titleKey)}</p>
                <h2 className="mt-1 text-lg font-black leading-snug text-[#ffe9a3]">
                  {t(active.exercise.objectiveKey)}
                </h2>
              </div>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]">
                {t("learn.practice.difficulty." + active.exercise.difficulty + ".label")}
              </span>
            </div>
            <p className="mt-1 text-[11px] font-semibold text-white/40">
              {t("learn.practice.skills." + active.exercise.skillId + ".focus")}
            </p>

            <div className="mt-3 rounded-2xl border border-[#00e5ff]/20 bg-surface/80 p-1.5">
              <SolitaireBoard
                view={viewForState(active.session.state)}
                interactive={!active.session.completed}
                onMove={onMove}
                onInvalid={() => setActive({ ...active, notice: true })}
              />
            </div>

            {active.notice && (
              <p
                role="status"
                className="mt-3 rounded-xl border border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06] px-3 py-2 text-xs font-semibold text-[#ffe9a3]"
              >
                {t("learn.player.boardNotice")}
              </p>
            )}

            {(active.hint || active.hintMessage) && (
              <div className="mt-3 rounded-xl border border-[#f5ff3b]/25 bg-[#1c1a05]/70 p-3">
                <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-[#f5ff3b]">
                  <IconBulb size={13} aria-hidden="true" />
                  {active.hint
                    ? t("learn.player.hintLevel", {
                        level: active.hint.level,
                        max: active.hint.maxLevel,
                      })
                    : t("learn.practice.hint")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[#ffe9a3]/85">
                  {active.hint
                    ? t(active.hint.textKey)
                    : active.hintMessage
                      ? t(active.hintMessage)
                      : ""}
                </p>
                {active.hintMove && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => onMove(active.hintMove as SolitaireMove)}
                      className={SECONDARY}
                      data-testid="practice-checked-move"
                    >
                      <IconCheck size={14} aria-hidden="true" />
                      {t("learn.practice.checkedMove")}
                    </button>
                    <p className="mt-1 text-[10px] font-semibold text-white/40">
                      {t("learn.practice.checkedMoveNote")}
                    </p>
                  </div>
                )}
              </div>
            )}

            {active.feedback && (
              <div
                className={`mt-3 rounded-xl border p-3 ${
                  active.feedback.kind === "incorrect"
                    ? "border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06]"
                    : "border-[#00ffa3]/25 bg-[#00ffa3]/[0.07]"
                }`}
              >
                <p className="text-xs font-black text-white/80">
                  {active.feedback.kind === "incorrect"
                    ? active.feedback.reason === "illegal"
                      ? t("learn.practice.feedbackIllegal")
                      : t("learn.practice.feedbackOffGoal")
                    : t("learn.practice.feedbackCorrect")}
                </p>
                {active.feedback.kind === "incorrect" &&
                  active.feedback.reason === "off-goal" && (
                    <p className="mt-1 text-xs leading-relaxed text-white/55">
                      {t(active.exercise.explanationKey)}
                    </p>
                  )}
                {active.feedback.kind === "correct" && (
                  <p className="mt-1 text-xs leading-relaxed text-white/55">
                    {t(active.feedback.explanationKey)}
                  </p>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onHint}
                className={SECONDARY}
                data-testid="practice-hint"
              >
                <IconBulb size={14} aria-hidden="true" />
                {active.hint ? t("learn.practice.nextHint") : t("learn.practice.hint")}
              </button>
              <button
                type="button"
                onClick={onRestart}
                className={SECONDARY}
                data-testid="practice-restart"
              >
                <IconRefresh size={14} aria-hidden="true" />
                {t("learn.practice.restart")}
              </button>
              <button
                type="button"
                onClick={returnToSetup}
                className={SECONDARY}
                data-testid="practice-return"
              >
                {t("learn.practice.backToSetup")}
              </button>
            </div>
          </section>
        ) : (
          <>
            <section
              aria-label={t("learn.practice.setupAria")}
              data-testid="practice-setup"
              className={`mt-6 ${CARD}`}
            >
              <p className={KICKER}>{t("learn.practice.setupKicker")}</p>
              <h2 className="mt-1 text-xl font-black tracking-tight">
                {t("learn.practice.setupTitle")}
              </h2>

              <div className="mt-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                  {t("learn.practice.categoryLabel")}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {categoriesWithExercises.map((category) => (
                    <Chip
                      key={category.id}
                      testId="practice-category"
                      data={category.id}
                      active={category.id === categoryId}
                      onClick={() => chooseCategory(category.id)}
                    >
                      <span className="block text-sm font-extrabold text-white">
                        {t(category.titleKey)}
                      </span>
                      <span className="mt-0.5 block text-[11px] font-semibold text-white/45">
                        {t(category.descriptionKey)}
                      </span>
                    </Chip>
                  ))}
                </div>
              </div>

              {skill && (
                <div className="mt-4" aria-live="polite">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                    {t("learn.practice.skillLabel")}
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {skills.map((entry) => (
                      <Chip
                        key={entry.id}
                        testId="practice-skill"
                        data={entry.id}
                        active={entry.id === skillId}
                        onClick={() => chooseSkill(entry.id)}
                      >
                        <span className="block text-sm font-extrabold text-white">
                          {t(entry.titleKey)}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-semibold text-white/45">
                          {t(entry.focusKey)}
                        </span>
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                  {t("learn.practice.difficultyLabel")}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {PRACTICE_DIFFICULTIES.map((level) => {
                    const count = practiceExerciseCount(skill?.id ?? "", level);
                    return (
                      <Chip
                        key={level}
                        testId="practice-difficulty"
                        data={level}
                        active={level === difficulty}
                        disabled={count === 0}
                        onClick={() => setDifficulty(level)}
                      >
                        <span className="block text-sm font-extrabold text-white">
                          {t("learn.practice.difficulty." + level + ".label")}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-semibold text-white/45">
                          {t("learn.practice.difficulty." + level + ".description")}
                        </span>
                        <span className="mt-1 block font-mono text-[10px] font-bold text-[#9dd8ff]/70">
                          {count === 1
                            ? t("learn.practice.exerciseCountOne")
                            : t("learn.practice.exerciseCount", { count })}
                        </span>
                      </Chip>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={startSelected}
                  disabled={exerciseCount === 0}
                  className={PRIMARY}
                  data-testid="practice-start"
                >
                  <IconTargetArrow size={16} aria-hidden="true" />
                  {t("learn.practice.start")}
                </button>
                <span className="text-[11px] font-semibold text-white/45">
                  {exerciseCount === 1
                    ? t("learn.practice.exerciseCountOne")
                    : t("learn.practice.exerciseCount", { count: exerciseCount })}
                </span>
                {exerciseCount === 0 && (
                  <span className="text-[11px] font-semibold text-[#ffe9a3]">
                    {t("learn.practice.noExercises")}
                  </span>
                )}
              </div>
            </section>

            <section
              aria-labelledby="practice-coaching-title"
              data-testid="practice-coaching-entry"
              className={`mt-4 ${CARD}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2
                  id="practice-coaching-title"
                  className="text-base font-extrabold text-white"
                >
                  {t("learn.coaching.practiceEntry.title")}
                </h2>
                <span className="rounded-full border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-[#9dd8ff]">
                  {t("learn.coaching.practiceEntry.badge")}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/55">
                {t("learn.coaching.practiceEntry.body")}
              </p>
              <Link
                href="/learn/coaching"
                className={`${SECONDARY} mt-2`}
                data-testid="practice-coaching-link"
              >
                {t("learn.coaching.practiceEntry.cta")}
                <IconArrowRight size={14} aria-hidden="true" />
              </Link>
            </section>

            <section
              aria-labelledby="practice-progress-title"
              data-testid="practice-progress"
              className={`mt-4 ${CARD}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="practice-progress-title" className="text-base font-extrabold text-white">
                  {t("learn.practice.progressTitle")}
                </h2>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]/60">
                  {userId ? t("learn.practice.accountNote") : t("learn.practice.guestNote")}
                </span>
              </div>

              {stats.attempts === 0 ? (
                <p className="mt-2 text-sm text-white/50">{t("learn.practice.progressEmpty")}</p>
              ) : (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { key: "attempted", value: stats.attempts },
                      { key: "completed", value: stats.completions },
                      { key: "successRate", value: `${stats.successRate}%` },
                      { key: "hintTotal", value: stats.hints },
                    ].map((item) => (
                      <div
                        key={item.key}
                        className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
                      >
                        <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]/60">
                          {t(`learn.practice.${item.key}`)}
                        </dt>
                        <dd className="mt-0.5 font-mono text-lg font-black text-white">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-[11px] font-semibold text-white/45">
                    {t("learn.practice.exercisesDone", {
                      completed: stats.exercisesCompleted,
                      total: 18,
                    })}
                  </p>
                  <div className="mt-3 space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/60">
                      {t("learn.practice.categoryProgress")}
                    </p>
                    {categoriesWithExercises.map((category) => {
                      const stat = stats.byCategory[category.id];
                      return (
                        <div
                          key={category.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-semibold text-white/55"
                        >
                          <span>{t(category.titleKey)}</span>
                          <span className="font-mono text-[#9dd8ff]/80">
                            {stat.completions}/{stat.attempts}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              <p className="mt-3 text-[10px] font-semibold text-white/35">
                {t("learn.practice.separateNote")}
              </p>
            </section>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
