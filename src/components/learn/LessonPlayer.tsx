"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBulb,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconRefresh,
  IconRotateClockwise,
  IconSchool,
  IconSparkles,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import SolitaireBoard from "../solitaire-duel/SolitaireBoard";
import { useLessonProgress } from "../../hooks/useLessonProgress";
import { useTranslation } from "../../hooks/useTranslation";
import { lessonById, LESSON_COURSES } from "../../lib/solitaire-duel/lessonCatalog";
import {
  applyLessonMove,
  createLessonSession,
  requestLessonHint,
  restartLesson,
  undoLessonMove,
  type Lesson,
  type LessonFeedback,
  type LessonHintResult,
  type LessonSession,
} from "../../lib/solitaire-duel/lessons";
import {
  courseProgress,
  isLessonCompleted,
  lessonStepIndex,
  nextLessonAfter,
} from "../../lib/solitaire-duel/lessonProgress";
import { viewForState } from "../../lib/solitaire-duel/rules";

function StepDots({ session }: { session: LessonSession }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {session.lesson.steps.map((step, index) => (
        <span
          key={step.id}
          className={`h-1.5 rounded-full transition-colors ${
            index < session.stepIndex
              ? "w-6 bg-[#00ffa3]"
              : index === session.stepIndex
                ? "w-8 bg-[#00e5ff]"
                : "w-3 bg-white/15"
          }`}
        />
      ))}
    </div>
  );
}

function ProgressMeter({
  percent,
  label,
}: {
  percent: number;
  label: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-label={label}
      className="h-1.5 overflow-hidden rounded-full bg-white/10"
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#00e5ff] to-[#00ffa3] transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function CompletionScreen({
  lesson,
  session,
  onReplay,
}: {
  lesson: Lesson;
  session: LessonSession;
  onReplay: () => void;
}) {
  const { t } = useTranslation();
  const { progress } = useLessonProgress();
  const course = LESSON_COURSES.find((item) => item.id === lesson.courseId);
  const stats = courseProgress(progress, lesson.courseId);
  const next = nextLessonAfter(lesson.id);
  const nextCourse = next
    ? LESSON_COURSES.find((item) => item.id === next.courseId)
    : null;

  return (
    <main className="relative mx-auto max-w-4xl px-4 pb-24 pt-24 sm:px-6 md:pt-28">
      <Link
        href="/learn"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-[#9dd8ff]/75 transition hover:text-[#00e5ff] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        <IconArrowLeft size={15} aria-hidden="true" />
        {t("learn.player.back")}
      </Link>

      <section
        aria-label={t("learn.player.completionAria")}
        className="mt-4 overflow-hidden rounded-3xl border border-[#00ffa3]/25 bg-[#05170f]"
      >
        <div className="border-b border-[#00ffa3]/15 bg-[radial-gradient(ellipse_at_top_left,rgba(0,255,163,0.16),transparent_68%)] p-5 sm:p-8">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[#00ffa3]/30 bg-[#00ffa3]/15 text-[#8dffd0]">
            <IconCheck size={26} aria-hidden="true" />
          </span>
          <p className="mt-4 text-[10px] font-black uppercase tracking-[0.32em] text-[#00ffa3]/80">
            {t("learn.player.completionKicker")}
          </p>
          <h1 className="mt-2 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
            {t("learn.player.completionTitle")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#9dd8ff]/75">
            {t("learn.player.completionLead")}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1 text-[11px] font-bold text-[#9dd8ff]">
              <IconSchool size={13} aria-hidden="true" />
              {course ? t(course.titleKey) : ""}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1 text-[11px] font-bold text-[#9dd8ff]">
              <IconSparkles size={13} aria-hidden="true" />
              {t(lesson.titleKey)}
            </span>
          </div>
        </div>

        <div className="grid gap-6 p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div>
            <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/75">
              {t("learn.player.whatLearned")}
            </h2>
            <ul className="mt-3 space-y-3">
              {lesson.steps.map((step, index) => (
                <li key={step.id} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#00ffa3]/30 bg-[#00ffa3]/10 font-mono text-[11px] font-bold text-[#8dffd0]">
                    {index + 1}
                  </span>
                  <p className="text-sm leading-relaxed text-white/65">
                    {t(step.explanationKey)}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-[#071128] p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#9dd8ff]/70">
                {t("learn.player.courseProgress")}
              </p>
              <p className="mt-1 text-sm font-extrabold text-white">
                {t("learn.player.courseProgressValue", {
                  completed: stats.completed,
                  total: stats.total,
                })}
              </p>
              <ProgressMeter
                percent={stats.total ? (stats.completed / stats.total) * 100 : 0}
                label={t("learn.player.courseProgressValue", {
                  completed: stats.completed,
                  total: stats.total,
                })}
              />
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#071128] p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#9dd8ff]/70">
                {t("learn.player.nextLesson")}
              </p>
              {next ? (
                <>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#00e5ff]/70">
                    {nextCourse ? t(nextCourse.titleKey) : ""}
                  </p>
                  <p className="mt-0.5 text-sm font-extrabold leading-snug text-white">
                    {t(next.titleKey)}
                  </p>
                  <Link
                    href={`/learn/${next.id}`}
                    className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-3 py-2 text-xs font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    {t("learn.player.next")}
                    <IconArrowRight size={15} aria-hidden="true" />
                  </Link>
                </>
              ) : (
                <p className="mt-1 text-xs leading-relaxed text-white/50">
                  {t("learn.player.finalLesson")}
                </p>
              )}
            </div>
          </aside>
        </div>

        <div className="flex flex-col gap-2 border-t border-white/10 p-5 sm:flex-row sm:items-center sm:p-6">
          <button
            type="button"
            onClick={onReplay}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#00e5ff]/35 bg-[#00e5ff]/10 px-4 py-2 text-sm font-extrabold text-[#9dd8ff] transition hover:bg-[#00e5ff]/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            <IconRefresh size={16} aria-hidden="true" />
            {t("learn.player.replayLesson")}
          </button>
          <Link
            href="/learn"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-extrabold text-[#9dd8ff]/75 underline-offset-4 transition hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("learn.player.returnToLearn")}
          </Link>
        </div>
      </section>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-white/35">
        <IconCheck size={13} aria-hidden="true" />
        {t("learn.player.saved")}
      </p>

      <div className="mt-6 text-center text-xs text-white/30">
        {t("learn.player.stepsComplete", {
          completed: session.stepIndex,
          total: lesson.steps.length,
        })}
      </div>
    </main>
  );
}

function Player({ lesson }: { lesson: Lesson }) {
  const { t } = useTranslation();
  const { progress, recordStep, completeLesson } = useLessonProgress();
  const [session, setSession] = useState<LessonSession>(() => createLessonSession(lesson));
  const [feedback, setFeedback] = useState<LessonFeedback | null>(null);
  const [hint, setHint] = useState<LessonHintResult["hint"]>(null);
  const [hintMessage, setHintMessage] = useState<string | null>(null);
  const [boardNotice, setBoardNotice] = useState(false);

  const course = LESSON_COURSES.find((item) => item.id === lesson.courseId);
  const currentStep = lesson.steps[session.stepIndex] ?? null;
  const next = nextLessonAfter(lesson.id);
  const progressPercent = (session.stepIndex / lesson.steps.length) * 100;

  const finish = () => {
    completeLesson(lesson.id, lesson.steps.length);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
  };

  const onMove = (move: Parameters<typeof applyLessonMove>[1]) => {
    const result = applyLessonMove(session, move);
    setBoardNotice(false);
    setHint(null);
    setHintMessage(null);

    if (!result.accepted) {
      setFeedback(result.feedback);
      return;
    }

    setSession(result.session);

    if (result.feedback.kind === "complete") {
      finish();
      return;
    }

    if (result.advanced) {
      recordStep(lesson.id, result.session.stepIndex);
    }
    setFeedback(result.feedback);
  };

  const onHint = () => {
    const result = requestLessonHint(session);
    setSession(result.session);
    setHint(result.hint);
    setHintMessage(result.hint ? null : result.messageKey);
    setFeedback(null);
    setBoardNotice(false);
  };

  const onRestart = () => {
    const nextSession = restartLesson(session);
    setSession(nextSession);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
    if (!isLessonCompleted(progress, lesson.id)) {
      recordStep(lesson.id, 0);
    }
  };

  const onUndo = () => {
    const nextSession = undoLessonMove(session);
    setSession(nextSession);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
    recordStep(lesson.id, nextSession.stepIndex);
  };

  const replay = () => {
    setSession(createLessonSession(lesson));
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
  };

  if (session.completed) {
    return <CompletionScreen lesson={lesson} session={session} onReplay={replay} />;
  }

  const feedbackTone =
    feedback?.kind === "incorrect" ? "warning" : feedback?.kind === "correct" ? "correct" : null;
  const feedbackTitle =
    feedback?.kind === "correct"
      ? t("learn.player.feedback.correct")
      : feedback?.kind === "incorrect"
        ? feedback.reason === "illegal"
          ? t("learn.player.feedback.illegal")
          : t("learn.player.feedback.offGoal")
        : "";
  const feedbackBody =
    feedback?.kind === "correct"
      ? t(feedback.explanationKey)
      : feedback?.kind === "incorrect"
        ? t(feedback.messageKey)
        : "";

  return (
    <main className="relative mx-auto max-w-[1440px] px-2 pb-24 pt-24 sm:px-6 md:pt-28">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/learn"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-[#9dd8ff]/75 transition hover:text-[#00e5ff] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          {t("learn.player.back")}
        </Link>
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/35">
          <IconCheck size={13} aria-hidden="true" />
          {t("learn.player.saved")}
        </p>
      </div>

      <header className="mt-4 flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
            {course ? t(course.titleKey) : t("learn.kicker")}
          </p>
          <h1 className="mt-1 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
            {t(lesson.titleKey)}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/50">
            {t(lesson.descriptionKey)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]">
            {t(`learn.difficulty.${lesson.difficulty}`)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold text-[#9dd8ff]">
            <IconClock size={12} aria-hidden="true" />
            {t("learn.lesson.minutes", { minutes: lesson.estimatedMinutes })}
          </span>
          <span className="rounded-full border border-[#00e5ff]/25 bg-[#00e5ff]/10 px-2.5 py-1 font-mono text-[10px] font-bold text-[#9dd8ff]">
            {t("learn.player.stepOf", {
              step: session.stepIndex + 1,
              total: lesson.steps.length,
            })}
          </span>
        </div>
      </header>

      <div className="mt-4 flex items-center gap-3">
        <ProgressMeter
          percent={progressPercent}
          label={t("learn.player.stepsComplete", {
            completed: session.stepIndex,
            total: lesson.steps.length,
          })}
        />
        <StepDots session={session} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* Board ---------------------------------------------------------- */}
        <section
          aria-label={t(lesson.titleKey)}
          className="order-2 min-w-0 lg:order-1"
        >
          <div className="rounded-3xl border border-[#00e5ff]/20 bg-[#040d24]/80 p-2 shadow-[0_0_45px_rgba(0,229,255,0.06)] sm:p-3">
            <SolitaireBoard
              view={viewForState(session.state)}
              interactive
              onMove={onMove}
              onInvalid={() => setBoardNotice(true)}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onUndo}
              disabled={session.log.length === 0}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[11px] font-bold text-[#9dd8ff] transition hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <IconRotateClockwise size={14} aria-hidden="true" />
              {t("learn.player.undo")}
            </button>
            <button
              type="button"
              onClick={onRestart}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[11px] font-bold text-[#9dd8ff] transition hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              <IconRefresh size={14} aria-hidden="true" />
              {t("learn.player.restart")}
            </button>
            <button
              type="button"
              onClick={onHint}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[#f5ff3b]/35 bg-[#f5ff3b]/10 px-3 text-[11px] font-bold text-[#f5ff3b] transition hover:bg-[#f5ff3b]/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
            >
              <IconBulb size={14} aria-hidden="true" />
              {t("learn.player.hint")}
            </button>
            {session.hintsUsed > 0 && (
              <span className="text-[10px] font-semibold text-white/35">
                {t("learn.player.hintsUsed", { count: session.hintsUsed })}
              </span>
            )}
          </div>

          {boardNotice && (
            <p
              role="status"
              className="mt-3 rounded-xl border border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06] px-3 py-2 text-xs font-semibold text-[#ffe9a3]"
            >
              {t("learn.player.boardNotice")}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 lg:hidden">
            <Link
              href="/learn"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-[#9dd8ff]/70 hover:text-[#00e5ff]"
            >
              <IconArrowLeft size={14} aria-hidden="true" />
              {t("learn.player.returnToLearn")}
            </Link>
            {next && (
              <span
                aria-disabled="true"
                title={t("learn.player.nextLocked")}
                className="inline-flex cursor-not-allowed items-center gap-1 text-xs font-bold text-[#9dd8ff]/25"
              >
                {t("learn.player.next")}
                <IconChevronRight size={14} aria-hidden="true" />
              </span>
            )}
          </div>
        </section>

        {/* Coach ------------------------------------------------------------ */}
        <aside className="order-1 min-w-0 space-y-3 lg:order-2">
          <section className="rounded-2xl border border-[#00e5ff]/25 bg-[#06152f]/90 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-[#00e5ff]/80">
                {t("learn.player.coach")}
              </p>
              <span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] font-bold text-[#9dd8ff]">
                {t("learn.player.stepOf", {
                  step: Math.min(session.stepIndex + 1, lesson.steps.length),
                  total: lesson.steps.length,
                })}
              </span>
            </div>

            <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/50">
              {t("learn.player.objective")}
            </p>
            <p
              role="status"
              aria-live="polite"
              className="mt-1.5 text-base font-extrabold leading-snug text-[#ffe9a3]"
            >
              {currentStep ? t(currentStep.instructionKey) : t(lesson.successKey)}
            </p>

            <div className="mt-4">
              <ProgressMeter
                percent={progressPercent}
                label={t("learn.player.stepsComplete", {
                  completed: session.stepIndex,
                  total: lesson.steps.length,
                })}
              />
            </div>

            <ol className="mt-4 space-y-1.5" aria-label={t("learn.player.progress")}>
              {lesson.steps.map((step, index) => (
                <li
                  key={step.id}
                  className={`flex items-center gap-2 text-[11px] font-semibold ${
                    index < session.stepIndex
                      ? "text-[#8dffd0]"
                      : index === session.stepIndex
                        ? "text-white"
                        : "text-white/30"
                  }`}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {index < session.stepIndex ? (
                      <IconCheck size={13} aria-hidden="true" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                    )}
                  </span>
                  <span>
                    {t("learn.player.stepOf", { step: index + 1, total: lesson.steps.length })}
                  </span>
                  <span className="text-[9px] uppercase tracking-[0.12em] opacity-60">
                    {index < session.stepIndex
                      ? t("learn.status.done")
                      : index === session.stepIndex
                        ? t("learn.status.current")
                        : t("learn.status.upcoming")}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <div aria-live="polite" aria-label={t("learn.player.feedbackAria")}>
            {feedback && feedback.kind !== "complete" && (
              <section
                className={`rounded-2xl border p-3.5 ${
                  feedbackTone === "correct"
                    ? "border-[#00ffa3]/30 bg-[#00ffa3]/[0.08]"
                    : "border-[#f5ff3b]/30 bg-[#f5ff3b]/[0.06]"
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                      feedbackTone === "correct"
                        ? "bg-[#00ffa3]/15 text-[#8dffd0]"
                        : "bg-[#f5ff3b]/15 text-[#ffe9a3]"
                    }`}
                  >
                    {feedbackTone === "correct" ? (
                      <IconCheck size={15} aria-hidden="true" />
                    ) : (
                      <IconBulb size={14} aria-hidden="true" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-xs font-black ${
                        feedbackTone === "correct" ? "text-[#b6ffe0]" : "text-[#ffe9a3]"
                      }`}
                    >
                      {feedbackTitle}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-white/65">
                      {feedbackBody}
                    </p>
                    <button
                      type="button"
                      onClick={() => setFeedback(null)}
                      className="mt-2 text-[11px] font-extrabold text-[#00e5ff] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                    >
                      {feedbackTone === "correct"
                        ? t("learn.player.feedback.continue")
                        : t("learn.player.feedback.tryAgain")}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>

          {(hint || hintMessage) && (
            <section className="rounded-2xl border border-[#f5ff3b]/25 bg-[#1c1a05]/70 p-3.5">
              <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-[#f5ff3b]">
                <IconBulb size={13} aria-hidden="true" />
                {hint
                  ? t("learn.player.hintLevel", {
                      level: hint.level,
                      max: hint.maxLevel,
                    })
                  : t("learn.player.hint")}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-[#ffe9a3]/85">
                {hint ? t(hint.textKey) : hintMessage ? t(hintMessage) : ""}
              </p>
            </section>
          )}

          <div className="hidden items-center justify-between gap-2 pt-1 lg:flex">
            <Link
              href="/learn"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-[#9dd8ff]/60 transition hover:text-[#00e5ff] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              <IconArrowLeft size={14} aria-hidden="true" />
              {t("learn.player.returnToLearn")}
            </Link>
            {next && (
              <span
                aria-disabled="true"
                title={t("learn.player.nextLocked")}
                className="inline-flex cursor-not-allowed items-center gap-1 text-xs font-bold text-[#9dd8ff]/25"
              >
                {t("learn.player.next")}
                <IconChevronRight size={14} aria-hidden="true" />
              </span>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

export default function LessonPlayer({ lessonId }: { lessonId: string }) {
  const lesson = lessonById(lessonId);
  if (!lesson) return null;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#040712] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.12),transparent_62%)]"
      />
      <NavigationBar currentPath="/learn" />
      <div className="relative">
        <Player key={lesson.id} lesson={lesson} />
      </div>
      <Footer />
    </div>
  );
}
