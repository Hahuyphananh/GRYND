"use client";

import Link from "next/link";
import { useState } from "react";
import {
  IconArrowRight,
  IconCheck,
  IconRefresh,
} from "@tabler/icons-react";

import SolitaireBoard from "../solitaire-duel/SolitaireBoard";
import { useTranslation } from "../../hooks/useTranslation";
import {
  applyLessonMove,
  createLessonSession,
  requestLessonHint,
  type Lesson,
  type LessonFeedback,
  type LessonHintResult,
  type LessonKnowledgeCheck,
  type LessonLearnContent,
  type LessonPracticePosition,
  type LessonRecapContent,
  type LessonSession,
  type LessonWatchContent,
} from "../../lib/solitaire-duel/lessons";
import {
  checkKnowledgeAnswer,
  createDemoSession,
  demoCurrentStep,
  demoIsComplete,
  demoNext,
  demoReplay,
  phaseLabelKey,
  phaseProgress,
  practiceLesson,
  type KnowledgeCheckResult,
  type LessonPhaseState,
} from "../../lib/solitaire-duel/lessonPhases";
import { lessonById } from "../../lib/solitaire-duel/lessonCatalog";
import { nextLessonAfter } from "../../lib/solitaire-duel/lessonProgress";
import { viewForState } from "../../lib/solitaire-duel/rules";

const CARD = "rounded-2xl border border-white/10 bg-[#06152f]/90 p-4 sm:p-5";
const KICKER = "text-[10px] font-black uppercase tracking-[0.28em] text-[#00e5ff]/80";
const PRIMARY =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-4 py-2 text-sm font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] disabled:cursor-not-allowed disabled:opacity-40";
const SECONDARY =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-bold text-[#9dd8ff] transition hover:bg-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]";

/** Phase indicator shared by every phase, including the guided exercise. */
export function PhaseRail({
  state,
  onBack,
}: {
  state: LessonPhaseState;
  onBack: (() => void) | null;
}) {
  const { t } = useTranslation();
  const progress = phaseProgress(state);
  return (
    <div className="mt-4">
      <div
        className="flex flex-wrap items-center gap-1.5"
        aria-label={t("learn.player.phases.label")}
      >
        {state.plan.map((kind, index) => (
          <span
            key={kind}
            aria-current={index === state.index ? "step" : undefined}
            className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${
              index === state.index
                ? "border-[#00e5ff]/40 bg-[#00e5ff]/15 text-[#9dd8ff]"
                : index < state.index
                  ? "border-[#00ffa3]/20 bg-[#00ffa3]/10 text-[#8dffd0]"
                  : "border-white/10 bg-white/[0.03] text-white/35"
            }`}
          >
            {t(phaseLabelKey(kind))}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#00e5ff] to-[#00ffa3] transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
          />
        </div>
        <span className="font-mono text-[10px] font-bold text-[#9dd8ff]/60">
          {t("learn.player.phases.progress", {
            current: progress.current,
            total: progress.total,
          })}
        </span>
        {onBack && (
          <button type="button" onClick={onBack} className={SECONDARY}>
            {t("learn.player.phases.back")}
          </button>
        )}
      </div>
    </div>
  );
}

export function LearnPhaseView({
  content,
  onContinue,
}: {
  content: LessonLearnContent;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("learn.player.phases.learn")} className={CARD}>
      <p className={KICKER}>{t("learn.player.phases.concept")}</p>
      <h2 className="mt-1 text-2xl font-black leading-tight text-white">
        {t(content.titleKey)}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-white/70">
        {t(content.explanationKey)}
      </p>
      <div className="mt-4 rounded-xl border border-[#00e5ff]/20 bg-[#00e5ff]/[0.06] p-3">
        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#9dd8ff]/70">
          {t("learn.player.phases.whyMatters")}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-[#9dd8ff]">
          {t(content.whyKey)}
        </p>
      </div>
      {content.illustrationKey && (
        <p className="mt-3 text-xs leading-relaxed text-white/45">
          {t(content.illustrationKey)}
        </p>
      )}
      {content.mistakeKey && (
        <div className="mt-3 rounded-xl border border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06] p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#ffe9a3]/70">
            {t("learn.player.phases.mistake")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#ffe9a3]/85">
            {t(content.mistakeKey)}
          </p>
        </div>
      )}
      {content.recognizeKey && (
        <p className="mt-3 text-xs leading-relaxed text-[#9dd8ff]/65">
          <span className="font-black uppercase tracking-[0.14em] text-[#9dd8ff]/45">
            {t("learn.player.phases.recognize")}:
          </span>{" "}
          {t(content.recognizeKey)}
        </p>
      )}
      <button type="button" onClick={onContinue} className={`mt-4 ${PRIMARY}`}>
        {t("learn.player.phases.continue")}
      </button>
    </section>
  );
}

/** Demonstration on the real board. Manual stepping only; nothing auto-plays. */
export function WatchPhaseView({
  content,
  onContinue,
}: {
  content: LessonWatchContent;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const [demo, setDemo] = useState(() => createDemoSession(content));
  const complete = demoIsComplete(demo);
  const current = demoCurrentStep(demo);
  const last = content.steps[Math.max(0, demo.stepIndex - 1)] ?? null;
  const explanationKey = current?.explanationKey ?? last?.explanationKey ?? null;

  const advance = () => {
    const result = demoNext(demo);
    if (result.ok) setDemo(result.session);
  };

  return (
    <section aria-label={t("learn.player.phases.watch")} className={CARD}>
      <p className={KICKER}>{t("learn.player.phases.watch")}</p>
      <p className="mt-1 text-xs leading-relaxed text-white/50">
        {t("learn.player.phases.watchLead")}
      </p>

      <div className="mt-3 rounded-2xl border border-[#00e5ff]/20 bg-[#040d24]/80 p-1.5">
        <SolitaireBoard
          view={viewForState(demo.state)}
          interactive={false}
          onMove={() => undefined}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-bold text-[#9dd8ff]/60">
          {t("learn.player.phases.demoProgress", {
            current: Math.min(demo.stepIndex + (complete ? 0 : 1), content.steps.length),
            total: content.steps.length,
          })}
        </span>
        <button
          type="button"
          onClick={() => setDemo(demoReplay(content))}
          className={SECONDARY}
        >
          <IconRefresh size={14} aria-hidden="true" />
          {t("learn.player.phases.replayDemo")}
        </button>
      </div>

      {explanationKey && (
        <p className="mt-3 rounded-xl border border-[#00ffa3]/20 bg-[#00ffa3]/[0.06] p-3 text-sm leading-relaxed text-[#b6ffe0]">
          {t(explanationKey)}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!complete ? (
          <button type="button" onClick={advance} className={PRIMARY}>
            {t("learn.player.phases.nextAction")}
          </button>
        ) : (
          <>
            <p className="text-sm font-extrabold text-[#8dffd0]">
              {t("learn.player.phases.demoComplete")}
            </p>
            <button type="button" onClick={onContinue} className={PRIMARY}>
              {t("learn.player.phases.continue")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function PracticePositionView({
  lesson,
  position,
  index,
  total,
  last,
  onComplete,
  onContinue,
}: {
  lesson: Lesson;
  position: LessonPracticePosition;
  index: number;
  total: number;
  last: boolean;
  onComplete: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const synthetic = practiceLesson(lesson, index);
  const [session, setSession] = useState<LessonSession | null>(() =>
    synthetic ? createLessonSession(synthetic) : null,
  );
  const [feedback, setFeedback] = useState<LessonFeedback | null>(null);
  const [notice, setNotice] = useState(false);
  const [hint, setHint] = useState<LessonHintResult["hint"]>(null);
  const [hintMessage, setHintMessage] = useState<string | null>(null);

  if (!synthetic || !session) return null;

  const onMove = (move: Parameters<typeof applyLessonMove>[1]) => {
    const result = applyLessonMove(session, move);
    setSession(result.session);
    setFeedback(result.feedback);
    setNotice(!result.accepted);
    setHint(null);
    setHintMessage(null);
  };

  const onHint = () => {
    const result = requestLessonHint(session);
    setSession(result.session);
    setHint(result.hint);
    setHintMessage(result.hint ? null : result.messageKey);
  };

  const body =
    feedback?.kind === "correct"
      ? t(feedback.explanationKey)
      : feedback?.kind === "complete"
        ? t(position.successKey ?? synthetic.successKey)
        : feedback?.kind === "incorrect"
          ? t(feedback.messageKey)
          : "";

  return (
    <section aria-label={t("learn.player.phases.practice")} className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={KICKER}>{t("learn.player.phases.practice")}</p>
        <span className="font-mono text-[10px] font-bold text-[#9dd8ff]/60">
          {t("learn.player.phases.practicePosition", {
            current: index + 1,
            total,
          })}
        </span>
      </div>
      <p className="mt-2 text-base font-extrabold leading-snug text-[#ffe9a3]">
        {t(position.instructionKey)}
      </p>

      <div className="mt-3 rounded-2xl border border-[#00e5ff]/20 bg-[#040d24]/80 p-1.5">
        <SolitaireBoard
          view={viewForState(session.state)}
          interactive={!session.completed}
          onMove={onMove}
          onInvalid={() => setNotice(true)}
        />
      </div>

      {notice && (
        <p
          role="status"
          className="mt-3 rounded-xl border border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06] px-3 py-2 text-xs font-semibold text-[#ffe9a3]"
        >
          {t("learn.player.boardNotice")}
        </p>
      )}

      {(hint || hintMessage) && (
        <div className="mt-3 rounded-xl border border-[#f5ff3b]/25 bg-[#1c1a05]/70 p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#f5ff3b]">
            {hint
              ? t("learn.player.hintLevel", {
                  level: hint.level,
                  max: hint.maxLevel,
                })
              : t("learn.player.hint")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#ffe9a3]/85">
            {hint ? t(hint.textKey) : hintMessage ? t(hintMessage) : ""}
          </p>
        </div>
      )}

      {feedback && (
        <div
          className={`mt-3 rounded-xl border p-3 ${
            feedback.kind === "incorrect"
              ? "border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06]"
              : "border-[#00ffa3]/25 bg-[#00ffa3]/[0.07]"
          }`}
        >
          <p className="text-xs font-black text-white/80">
            {feedback.kind === "incorrect"
              ? t("learn.player.feedback.offGoal")
              : t("learn.player.phases.correct")}
          </p>
          {body && (
            <p className="mt-1 text-xs leading-relaxed text-white/60">{body}</p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setSession(createLessonSession(synthetic));
            setFeedback(null);
            setNotice(false);
            setHint(null);
            setHintMessage(null);
          }}
          className={SECONDARY}
        >
          <IconRefresh size={14} aria-hidden="true" />
          {t("learn.player.phases.practiceTryAgain")}
        </button>
        <button
          type="button"
          onClick={onHint}
          disabled={session.completed}
          className={SECONDARY}
        >
          {t("learn.player.hint")}
        </button>
        {session.completed && (
          <button
            type="button"
            onClick={last ? onContinue : onComplete}
            className={PRIMARY}
          >
            {last
              ? t("learn.player.phases.continue")
              : t("learn.player.phases.practiceNext")}
          </button>
        )}
      </div>
      {session.completed && (
        <p className="mt-2 text-sm font-extrabold text-[#8dffd0]">
          {t("learn.player.phases.practiceComplete")}
        </p>
      )}
    </section>
  );
}

export function PracticePhaseView({
  lesson,
  positions,
  onContinue,
}: {
  lesson: Lesson;
  positions: readonly LessonPracticePosition[];
  onContinue: () => void;
}) {
  const [index, setIndex] = useState(0);
  const position = positions[index];
  if (!position) return null;

  return (
    <PracticePositionView
      key={position.id}
      lesson={lesson}
      position={position}
      index={index}
      total={positions.length}
      last={index >= positions.length - 1}
      onComplete={() => setIndex((value) => Math.min(value + 1, positions.length - 1))}
      onContinue={onContinue}
    />
  );
}

export function KnowledgeCheckView({
  check,
  onContinue,
}: {
  check: LessonKnowledgeCheck;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeCheckResult | null>(null);
  const [wrong, setWrong] = useState(false);
  const correct = result?.correct === true;

  const submit = () => {
    if (!selected || correct) return;
    const next = checkKnowledgeAnswer(check, selected);
    setResult(next);
    setWrong(next?.correct === false);
  };

  return (
    <section aria-label={t("learn.player.phases.knowledgeCheck")} className={CARD}>
      <p className={KICKER}>{t("learn.player.phases.knowledgeCheck")}</p>
      <h2 className="mt-1 text-lg font-black leading-snug text-white">
        {t(check.questionKey)}
      </h2>

      <div className="mt-3 space-y-2">
        {check.options.map((option) => {
          const chosen = selected === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={chosen}
              disabled={correct}
              onClick={() => {
                setSelected(option.id);
                setResult(null);
                setWrong(false);
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition ${
                chosen
                  ? "border-[#00e5ff]/40 bg-[#00e5ff]/10 text-white"
                  : "border-white/12 bg-white/[0.03] text-white/65 hover:bg-white/[0.06]"
              } disabled:cursor-default`}
            >
              {t(option.textKey)}
              {chosen && <IconCheck size={15} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {wrong && (
        <p
          role="status"
          className="mt-3 rounded-xl border border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06] px-3 py-2 text-xs font-semibold text-[#ffe9a3]"
        >
          {t("learn.player.phases.incorrect")}
        </p>
      )}

      {correct && (
        <div className="mt-3 rounded-xl border border-[#00ffa3]/25 bg-[#00ffa3]/[0.07] p-3">
          <p className="text-xs font-black text-[#8dffd0]">
            {t("learn.player.phases.correct")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/65">
            {t(result.explanationKey)}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!correct && (
          <button
            type="button"
            onClick={submit}
            disabled={!selected}
            className={PRIMARY}
          >
            {selected
              ? t("learn.player.phases.checkAnswer")
              : t("learn.player.phases.chooseAnswer")}
          </button>
        )}
        {correct && (
          <button type="button" onClick={onContinue} className={PRIMARY}>
            {t("learn.player.phases.continue")}
          </button>
        )}
      </div>
    </section>
  );
}

export function RecapPhaseView({
  lesson,
  recap,
  onContinue,
}: {
  lesson: Lesson;
  recap: LessonRecapContent;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const next = recap.nextLessonId
    ? lessonById(recap.nextLessonId)
    : nextLessonAfter(lesson.id);

  return (
    <section aria-label={t("learn.player.phases.recap")} className={CARD}>
      <p className={KICKER}>{t("learn.player.phases.recap")}</p>
      <h2 className="mt-1 text-2xl font-black leading-tight text-white">
        {t("learn.player.phases.summary")}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-white/70">
        {t(recap.summaryKey)}
      </p>
      <div className="mt-4 rounded-xl border border-[#00ffa3]/25 bg-[#00ffa3]/[0.07] p-3">
        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#8dffd0]/80">
          {t("learn.player.phases.remember")}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-[#b6ffe0]">
          {t(recap.rememberKey)}
        </p>
      </div>

      {next && (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#9dd8ff]/60">
            {t("learn.player.phases.suggestedNext")}
          </p>
          <Link
            href={`/learn/${next.id}`}
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-[#00e5ff] underline-offset-4 hover:underline"
          >
            {t(next.titleKey)}
            <IconArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      )}

      <button type="button" onClick={onContinue} className={`mt-4 ${PRIMARY}`}>
        {t("learn.player.phases.finish")}
      </button>
    </section>
  );
}
