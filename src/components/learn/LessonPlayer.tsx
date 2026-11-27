"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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

import { trackSolitaireEventOnce } from "../../lib/solitaire-analytics";
import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import SolitaireBoard from "../solitaire-duel/SolitaireBoard";
import {
  KnowledgeCheckView,
  LearnPhaseView,
  PhaseRail,
  PracticePhaseView,
  RecapPhaseView,
  WatchPhaseView,
} from "./LessonPhaseViews";
import GlitchSay from "../mascot/GlitchSay";
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
  createLessonPhaseState,
  currentLessonPhase,
  isLastLessonPhase,
  nextLessonPhase,
  previousLessonPhase,
} from "../../lib/solitaire-duel/lessonPhases";
import {
  courseProgress,
  isLessonCompleted,
  lessonPhaseIndex,
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
    <div className="relative mx-auto max-w-4xl px-4 pb-24 pt-6 sm:px-6 md:pt-8">
      <Link
        href="/learn"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-[#9dd8ff]/75 transition hover:text-[#00e5ff] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        <IconArrowLeft size={15} aria-hidden="true" />
        {t("learn.player.back")}
      </Link>

      <section
        aria-label={t("learn.player.completionAria")}
        className="mt-4 overflow-hidden rounded-3xl border border-[#00ffa3]/25 bg-[var(--tint-bg--05170f)]"
      >
        <div className="border-b border-[#00ffa3]/15 bg-[radial-gradient(ellipse_at_top_left,rgba(0,255,163,0.16),transparent_68%)] p-5 sm:p-8">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[#00ffa3]/30 bg-[#00ffa3]/15 text-[#8dffd0]">
            <IconCheck size={26} aria-hidden="true" />
          </span>
          <p className="mt-4 text-[11px] font-black uppercase tracking-[0.32em] text-[#00ffa3]/80">
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
            <div className="rounded-2xl border border-white/10 bg-surface p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#9dd8ff]/70">
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

            <div className="rounded-2xl border border-white/10 bg-surface p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#9dd8ff]/70">
                {t("learn.player.nextLesson")}
              </p>
              {next ? (
                <>
                  <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-[#00e5ff]/70">
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
    </div>
  );
}

type PendingAdvance = {
  readonly session: LessonSession;
  readonly feedback: LessonFeedback;
};

function Player({ lesson }: { lesson: Lesson }) {
  // ENGAGEMENT: the academy lesson was opened. Completion is reported by the
  // lesson's own completion handler, not by this mount.
  useEffect(() => {
    trackSolitaireEventOnce(`academy_lesson_started:${lesson.id}`, "academy_lesson_started", {
      lesson_id: lesson.id,
      surface: "academy",
    });
  }, [lesson.id]);

  const { t } = useTranslation();
  const { progress, recordStep, recordPhase, completeLesson, isProgressLoaded } =
    useLessonProgress();
  const [session, setSession] = useState<LessonSession>(() => createLessonSession(lesson));
  // The engine advances as soon as a qualifying move is applied. The ADVANCED
  // session is held here, unacknowledged, so the board can show the completed
  // move while the next objective stays inactive until Continue.
  const [pendingAdvance, setPendingAdvance] = useState<PendingAdvance | null>(null);
  const advanceLockRef = useRef(false);
  const [feedback, setFeedback] = useState<LessonFeedback | null>(null);
  const [hint, setHint] = useState<LessonHintResult["hint"]>(null);
  const [hintMessage, setHintMessage] = useState<string | null>(null);
  const [boardNotice, setBoardNotice] = useState(false);
  const [phaseState, setPhaseState] = useState(() => createLessonPhaseState(lesson));
  const [finished, setFinished] = useState(false);
  const phaseLockRef = useRef(false);
  const restoredRef = useRef(false);
  const phase = currentLessonPhase(phaseState);

  // Restore once, after device progress has loaded, at the BEGINNING of the
  // saved phase. The guided exercise itself deliberately restarts its board.
  useEffect(() => {
    if (!isProgressLoaded || restoredRef.current) return;
    restoredRef.current = true;
    setPhaseState(
      createLessonPhaseState(lesson, lessonPhaseIndex(progress, lesson.id)),
    );
  }, [isProgressLoaded, lesson, progress]);

  // A locked transition is released only once the new phase has rendered, so a
  // rapid double-click cannot skip a phase.
  useEffect(() => {
    phaseLockRef.current = false;
  }, [phaseState.index]);

  const course = LESSON_COURSES.find((item) => item.id === lesson.courseId);
  const boardSession = pendingAdvance?.session ?? session;
  // While the explanation is open, keep showing the objective that was just
  // completed. The next objective becomes current only after Continue.
  const displayStepIndex = pendingAdvance
    ? Math.max(0, pendingAdvance.session.stepIndex - 1)
    : session.stepIndex;
  const currentStep = lesson.steps[displayStepIndex] ?? null;
  const glitchLine =
    phase === "watch"
      ? "Watch the demo first, then try the same idea on the board."
      : phase === "practice"
        ? "Your turn — use the demo you just watched, and ask for a hint if you get stuck."
        : phase === "knowledgeCheck"
          ? "Answer from what you just practised. Glitch will explain anything you miss."
          : phase === "recap"
            ? "Here is the whole idea in one place. Replay the lesson whenever you like."
            : currentStep
              ? t(currentStep.instructionKey)
              : t(lesson.successKey);
  const next = nextLessonAfter(lesson.id);
  const progressPercent = (session.stepIndex / lesson.steps.length) * 100;

  const finish = () => {
    setFinished(true);
    setPendingAdvance(null);
    completeLesson(lesson.id, lesson.steps.length);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
  };

  const onMove = (move: Parameters<typeof applyLessonMove>[1]) => {
    // The pause is not only visual: no second lesson move is evaluated while
    // the completed objective is waiting to be acknowledged.
    if (pendingAdvance) return;

    const result = applyLessonMove(session, move);
    setBoardNotice(false);
    setHint(null);
    setHintMessage(null);

    if (!result.accepted) {
      setSession(result.session);
      setFeedback(result.feedback);
      return;
    }

    // Correct (or final) move: show the advanced board, but hold progression.
    // The pre-move session stays authoritative until Continue, so the next
    // objective cannot accept moves yet.
    if (result.advanced) {
      setFeedback(result.feedback);
      setPendingAdvance({ session: result.session, feedback: result.feedback });
      advanceLockRef.current = false;
      return;
    }

    setSession(result.session);
    setFeedback(result.feedback);
  };

  const onHint = () => {
    if (pendingAdvance) return;
    const result = requestLessonHint(session);
    setSession(result.session);
    setHint(result.hint);
    setHintMessage(result.hint ? null : result.messageKey);
    setFeedback(null);
    setBoardNotice(false);
  };

  const onRestart = () => {
    const nextSession = restartLesson(session);
    setPendingAdvance(null);
    advanceLockRef.current = false;
    phaseLockRef.current = false;
    setSession(nextSession);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
    setFinished(false);
    setPhaseState(createLessonPhaseState(lesson));
    // One write records both the first step and the first phase; completed
    // lessons stay completed because the progress reducer preserves history.
    recordPhase(lesson.id, 0, 0);
  };

  const onUndo = () => {
    const nextSession = undoLessonMove(session);
    setPendingAdvance(null);
    advanceLockRef.current = false;
    setSession(nextSession);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
    recordStep(lesson.id, nextSession.stepIndex);
  };

  const advancePhase = (stepIndex = boardSession.stepIndex) => {
    if (phaseLockRef.current || finished) return;
    phaseLockRef.current = true;
    const next = nextLessonPhase(phaseState);
    if (!next) {
      finish();
      return;
    }
    setPhaseState(next);
    recordPhase(lesson.id, next.index, stepIndex);
    setPendingAdvance(null);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
  };

  const backPhase = () => {
    if (phaseLockRef.current || finished) return;
    const previous = previousLessonPhase(phaseState);
    if (!previous) return;
    phaseLockRef.current = true;
    setPhaseState(previous);
    recordPhase(lesson.id, previous.index, session.stepIndex);
    setPendingAdvance(null);
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
  };

  const onContinue = () => {
    const pending = pendingAdvance;
    // The synchronous lock is what makes rapid double-clicks advance exactly
    // once: the second click is rejected before React has re-rendered.
    if (!pending || advanceLockRef.current) return;
    advanceLockRef.current = true;

    setPendingAdvance(null);
    setFeedback(null);
    setSession(pending.session);

    if (pending.session.completed) {
      if (isLastLessonPhase(phaseState)) finish();
      else advancePhase(pending.session.stepIndex);
      return;
    }
    recordStep(lesson.id, pending.session.stepIndex);
  };

  const replay = () => {
    setPendingAdvance(null);
    advanceLockRef.current = false;
    phaseLockRef.current = false;
    setFinished(false);
    setPhaseState(createLessonPhaseState(lesson));
    setSession(createLessonSession(lesson));
    setFeedback(null);
    setHint(null);
    setHintMessage(null);
    setBoardNotice(false);
  };

  if (finished) {
    return <CompletionScreen lesson={lesson} session={session} onReplay={replay} />;
  }

  const feedbackTone =
    feedback?.kind === "incorrect" ? "warning" : feedback ? "correct" : null;
  const feedbackTitle =
    feedback?.kind === "correct" || feedback?.kind === "complete"
      ? t("learn.player.feedback.correct")
      : feedback?.kind === "incorrect"
        ? feedback.reason === "illegal"
          ? t("learn.player.feedback.illegal")
          : t("learn.player.feedback.offGoal")
        : "";
  const completedStep =
    feedback && "completedStepIds" in feedback
      ? lesson.steps.find(
          (step) => step.id === feedback.completedStepIds[feedback.completedStepIds.length - 1],
        ) ?? null
      : null;
  const feedbackBody =
    feedback?.kind === "correct"
      ? t(feedback.explanationKey)
      : feedback?.kind === "complete"
        ? t(completedStep?.explanationKey ?? lesson.successKey)
        : feedback?.kind === "incorrect"
          ? t(feedback.messageKey)
          : "";
  const showContinue = Boolean(pendingAdvance && feedback && feedback.kind !== "incorrect");

  if (phase && phase !== "guided") {
    const phases = lesson.phases;
    return (
      <div className="relative mx-auto max-w-4xl px-4 pb-24 pt-6 sm:px-6 md:pt-8">
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

        <header className="mt-4 border-b border-white/10 pb-4">
          <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
            {course ? t(course.titleKey) : t("learn.kicker")}
          </p>
          <h1 className="mt-1 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
            {t(lesson.titleKey)}
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-white/50">
            {t(lesson.descriptionKey)}
          </p>
        </header>

        <PhaseRail
          state={phaseState}
          onBack={phaseState.index > 0 ? backPhase : null}
        />

        <div className="mt-4 rounded-2xl border border-[#00e5ff]/25 bg-[#06152f]/90 p-3">
          <GlitchSay size="sm" message={glitchLine} />
        </div>

        <div className="mt-5">
          {phase === "learn" && phases?.learn && (
            <LearnPhaseView content={phases.learn} onContinue={() => advancePhase()} />
          )}
          {phase === "watch" && phases?.watch && (
            <WatchPhaseView
              key={`watch-${phaseState.index}`}
              content={phases.watch}
              onContinue={() => advancePhase()}
            />
          )}
          {phase === "practice" && phases?.practice && (
            <PracticePhaseView
              key={`practice-${phaseState.index}`}
              lesson={lesson}
              positions={phases.practice}
              onContinue={() => advancePhase()}
            />
          )}
          {phase === "knowledgeCheck" && phases?.knowledgeCheck && (
            <KnowledgeCheckView
              key={`knowledge-${phaseState.index}`}
              check={phases.knowledgeCheck}
              onContinue={() => advancePhase()}
            />
          )}
          {phase === "recap" && phases?.recap && (
            <RecapPhaseView
              key={`recap-${phaseState.index}`}
              lesson={lesson}
              recap={phases.recap}
              onContinue={() => advancePhase()}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative mx-auto max-w-[1440px] px-2 pb-24 pt-6 sm:px-6 md:pt-8">
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
          <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
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
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]">
            {t(`learn.difficulty.${lesson.difficulty}`)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-bold text-[#9dd8ff]">
            <IconClock size={12} aria-hidden="true" />
            {t("learn.lesson.minutes", { minutes: lesson.estimatedMinutes })}
          </span>
          <span className="rounded-full border border-[#00e5ff]/25 bg-[#00e5ff]/10 px-2.5 py-1 font-mono text-[11px] font-bold text-[#9dd8ff]">
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

      <PhaseRail
        state={phaseState}
        onBack={phaseState.index > 0 ? backPhase : null}
      />

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* Board ---------------------------------------------------------- */}
        <section
          aria-label={t(lesson.titleKey)}
          className="order-2 min-w-0 lg:order-1"
        >
          <div className="rounded-3xl border border-[#00e5ff]/20 bg-surface/80 p-2 shadow-[0_0_45px_rgba(0,229,255,0.06)] sm:p-3">
            <SolitaireBoard
              view={viewForState(boardSession.state)}
              interactive={!pendingAdvance && !session.completed}
              onMove={onMove}
              onInvalid={() => setBoardNotice(true)}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onUndo}
              disabled={session.log.length === 0 || pendingAdvance !== null}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[11px] font-bold text-[#9dd8ff] transition hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <IconRotateClockwise size={14} aria-hidden="true" />
              {t("learn.player.undo")}
            </button>
            <button
              type="button"
              onClick={onRestart}
              disabled={pendingAdvance !== null}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-[11px] font-bold text-[#9dd8ff] transition hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <IconRefresh size={14} aria-hidden="true" />
              {t("learn.player.restart")}
            </button>
            <button
              type="button"
              onClick={onHint}
              disabled={pendingAdvance !== null}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[#f5ff3b]/35 bg-[#f5ff3b]/10 px-3 text-[11px] font-bold text-[#f5ff3b] transition hover:bg-[#f5ff3b]/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#f5ff3b] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <IconBulb size={14} aria-hidden="true" />
              {t("learn.player.hint")}
            </button>
            {session.hintsUsed > 0 && (
              <span className="text-[11px] font-semibold text-white/35">
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

          {session.completed && !pendingAdvance && (
            <section className="mt-3 rounded-2xl border border-[#00ffa3]/25 bg-[#00ffa3]/[0.07] p-4">
              <p className="text-sm font-extrabold text-[#8dffd0]">
                {t("learn.player.phases.guidedComplete")}
              </p>
              <button
                type="button"
                onClick={() => advancePhase(session.stepIndex)}
                className="mt-2 inline-flex min-h-9 items-center justify-center rounded-lg bg-[#00e5ff] px-3 py-1.5 text-[11px] font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                {t("learn.player.phases.continue")}
              </button>
            </section>
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
          <div className="rounded-2xl border border-[#00e5ff]/25 bg-[#06152f]/90 p-3">
            <GlitchSay size="sm" message={glitchLine} />
          </div>
          <section className="rounded-2xl border border-[#00e5ff]/25 bg-[#06152f]/90 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-black uppercase tracking-[0.28em] text-[#00e5ff]/80">
                {t("learn.player.coach")}
              </p>
              <span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] font-bold text-[#9dd8ff]">
                {t("learn.player.stepOf", {
                  step: Math.min(session.stepIndex + 1, lesson.steps.length),
                  total: lesson.steps.length,
                })}
              </span>
            </div>

            <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/50">
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
                  <span className="text-[11px] uppercase tracking-[0.12em] opacity-60">
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
            {feedback && (
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
                    {feedback.kind === "incorrect" && feedback.nextInstructionKey && (
                      <p className="mt-1 text-[11px] leading-relaxed text-[#ffe9a3]/70">
                        {t("learn.player.objective")}: {t(feedback.nextInstructionKey)}
                      </p>
                    )}
                    {showContinue ? (
                      <button
                        type="button"
                        onClick={onContinue}
                        className="mt-2 inline-flex min-h-9 items-center justify-center rounded-lg bg-[#00e5ff] px-3 py-1.5 text-[11px] font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                      >
                        {t("learn.player.feedback.continue")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setFeedback(null)}
                        className="mt-2 text-[11px] font-extrabold text-[#00e5ff] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                      >
                        {t("learn.player.feedback.tryAgain")}
                      </button>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>

          {(hint || hintMessage) && (
            <section className="rounded-2xl border border-[#f5ff3b]/25 bg-[#1c1a05]/70 p-3.5">
              <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.16em] text-[#f5ff3b]">
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
    </div>
  );
}

export default function LessonPlayer({ lessonId }: { lessonId: string }) {
  const lesson = lessonById(lessonId);
  if (!lesson) return null;

  return (
    <div className="relative min-h-dvh overflow-hidden bg-page pb-24 text-white md:pb-0">
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
