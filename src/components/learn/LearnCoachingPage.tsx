"use client";

// src/components/learn/LearnCoachingPage.tsx
//
// GRYND PRO ADVANCED COACHING — the client surface.
//
// It does not compute analytics. It reads the two device-local records (lesson
// progress and practice progress), posts the player's OWN sanitized snapshot to
// /api/learn/coaching, and renders the report the server returns. The server
// decides whether the caller is a member and builds every number; this component
// decides only what to display:
//
//   * signed out            → sign-in explanation (free content note included);
//   * membership unreadable → retry, never an upgrade prompt;
//   * signed in, free       → a calm explanation of the benefit, with the
//                             free-content guarantee stated plainly;
//   * Pro                   → analytics, weak areas, recommendations, plan.
//
// There is no modal, no auto-popup and no per-exercise interruption. The page is
// reached from Practice and the Academy, and the report is only refetched when
// the local record actually changes or the player presses retry.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBulb,
  IconCalendar,
  IconChartBar,
  IconLock,
  IconRefresh,
  IconTargetArrow,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import LearnSubnav from "./LearnSubnav";
import { useLessonProgress } from "../../hooks/useLessonProgress";
import { usePracticeProgress } from "../../hooks/usePracticeProgress";
import { useTranslation } from "../../hooks/useTranslation";
import {
  COACHING_BENEFIT_KEYS,
  COACHING_PRACTICE_PATH,
  COACHING_UPGRADE_URL,
  coachingSnapshotFromLocal,
  type CoachingReport,
} from "../../lib/learn/coaching";
import {
  PRACTICE_SKILL_BY_ID,
  findPracticeExercise,
} from "../../lib/solitaire-duel/practice";
import { LESSON_BY_ID } from "../../lib/solitaire-duel/lessonCatalog";

const CARD = "rounded-2xl border border-white/10 bg-[#06152f]/90 p-4 sm:p-5";
const KICKER = "text-[10px] font-black uppercase tracking-[0.28em] text-[#00e5ff]/80";
const PRIMARY =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-4 py-2 text-sm font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]";
const SECONDARY =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-bold text-[#9dd8ff] transition hover:bg-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]";
const ROW = "flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-1.5";

type CoachingState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; report: CoachingReport }
  | { status: "error" }
  | { status: "unavailable" };

type ApiPayload = {
  success?: boolean;
  pro?: boolean;
  locked?: boolean;
  report?: CoachingReport;
  error?: string;
};

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function generatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function SkillRow({
  label,
  attempts,
  completions,
  success,
  hints,
  attemptsLabel,
  completionsLabel,
  successLabel,
  hintsLabel,
}: {
  label: string;
  attempts: number;
  completions: number;
  success: number;
  hints: number;
  attemptsLabel: string;
  completionsLabel: string;
  successLabel: string;
  hintsLabel: string;
}) {
  return (
    <div className={ROW}>
      <span className="min-w-0 truncate text-xs font-bold text-white/70">{label}</span>
      <span className="flex shrink-0 items-center gap-3 font-mono text-[10px] font-bold text-[#9dd8ff]/75">
        <span title={attemptsLabel}>{attempts}</span>
        <span title={completionsLabel}>{completions}</span>
        <span title={successLabel} className="text-[#8dffd0]">
          {success}%
        </span>
        <span title={hintsLabel}>{hints}</span>
      </span>
    </div>
  );
}

export default function LearnCoachingPage({
  signedIn,
  pro,
  membershipUnavailable,
}: {
  signedIn: boolean;
  pro: boolean;
  membershipUnavailable: boolean;
}) {
  const { t } = useTranslation();
  const { progress: lessonProgress, isProgressLoaded } = useLessonProgress();
  const { progress: practiceProgress, isProgressLoaded: practiceLoaded } =
    usePracticeProgress();

  const snapshot = useMemo(
    () => coachingSnapshotFromLocal(lessonProgress, practiceProgress),
    [lessonProgress, practiceProgress],
  );
  const recordsReady = isProgressLoaded && practiceLoaded;

  const [state, setState] = useState<CoachingState>({
    status: signedIn && pro && !membershipUnavailable ? "loading" : "idle",
  });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!signedIn || !pro || membershipUnavailable || !recordsReady) return undefined;

    const controller = new AbortController();
    setState({ status: "loading" });

    const load = async () => {
      try {
        const response = await fetch("/api/learn/coaching", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: 1, snapshot }),
          cache: "no-store",
          signal: controller.signal,
        });

        if (response.status === 503) {
          setState({ status: "unavailable" });
          return;
        }

        const payload = (await response.json().catch(() => null)) as ApiPayload | null;
        if (response.status === 401 || !response.ok || !payload?.success) {
          setState({ status: "error" });
          return;
        }
        if (payload.locked || !payload.pro) {
          // The server re-resolved membership and refused: trust the server.
          setState({ status: "error" });
          return;
        }
        if (!payload.report) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", report: payload.report });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("[learn/coaching] Failed to load the report:", error);
        setState({ status: "error" });
      }
    };

    void load();
    return () => controller.abort();
  }, [signedIn, pro, membershipUnavailable, recordsReady, snapshot, reloadToken]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  const skillTitle = useCallback(
    (skillId: string) => {
      const skill = PRACTICE_SKILL_BY_ID[skillId];
      return skill ? t(skill.titleKey) : skillId;
    },
    [t],
  );
  const exerciseTitle = useCallback(
    (exerciseId: string) => {
      const exercise = findPracticeExercise(exerciseId);
      return exercise ? t(exercise.titleKey) : exerciseId;
    },
    [t],
  );
  const lessonTitle = useCallback(
    (lessonId: string) => {
      const lesson = LESSON_BY_ID[lessonId];
      return lesson ? t(lesson.titleKey) : lessonId;
    },
    [t],
  );
  const practiceHref = useCallback((skillId: string, difficulty?: string) => {
    const params = new URLSearchParams({ skill: skillId });
    if (difficulty) params.set("difficulty", difficulty);
    return `${COACHING_PRACTICE_PATH}?${params.toString()}`;
  }, []);

  const report = state.status === "ready" ? state.report : null;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#040712] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.12),transparent_62%)]"
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

        <LearnSubnav active="coaching" />

        <header className="mt-6">
          <p className={KICKER}>{t("learn.coaching.kicker")}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
              {t("learn.coaching.title")}
            </h1>
            <span className="rounded-full border border-[#f5ff3b]/35 bg-[#f5ff3b]/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] text-[#ffe9a3]">
              {t("learn.coaching.proBadge")}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">
            {t("learn.coaching.description")}
          </p>
        </header>

        {!signedIn ? (
          // ── Guest ────────────────────────────────────────────────────────
          <section data-testid="coaching-guest" className={`mt-6 ${CARD}`}>
            <h2 className="flex items-center gap-2 text-xl font-black text-white">
              <IconLock size={18} aria-hidden="true" className="text-[#9dd8ff]" />
              {t("learn.coaching.guest.title")}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              {t("learn.coaching.guest.body")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link href="/sign-in" className={PRIMARY}>
                {t("learn.coaching.guest.cta")}
                <IconArrowRight size={15} aria-hidden="true" />
              </Link>
              <Link href="/learn/practice" className={SECONDARY}>
                {t("learn.coaching.backToPractice")}
              </Link>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-white/40">
              {t("learn.coaching.guest.free")}
            </p>
          </section>
        ) : membershipUnavailable ? (
          // ── Membership unreadable: retry, not an upsell ───────────────────
          <section data-testid="coaching-unavailable" className={`mt-6 ${CARD}`}>
            <h2 className="text-xl font-black text-white">
              {t("learn.coaching.unavailable.title")}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              {t("learn.coaching.unavailable.body")}
            </p>
            <button type="button" onClick={retry} className={`${SECONDARY} mt-3`}>
              <IconRefresh size={14} aria-hidden="true" />
              {t("learn.coaching.retry")}
            </button>
          </section>
        ) : !pro ? (
          // ── Signed in, free: explain the benefit, never block learning ───
          <section data-testid="coaching-locked" className={`mt-6 ${CARD}`}>
            <h2 className="flex items-center gap-2 text-xl font-black text-white">
              <IconLock size={18} aria-hidden="true" className="text-[#9dd8ff]" />
              {t("learn.coaching.locked.title")}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              {t("learn.coaching.locked.body")}
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#00e5ff]/80">
                  {t("learn.coaching.locked.whatTitle")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-white/55">
                  {t("learn.coaching.locked.what")}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#00ffa3]/80">
                  {t("learn.coaching.locked.whyTitle")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-white/55">
                  {t("learn.coaching.locked.why")}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#ffe9a3]/80">
                  {t("learn.coaching.locked.extraTitle")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-white/55">
                  {t("learn.coaching.locked.extra")}
                </p>
              </div>
            </div>

            <ul className="mt-4 grid gap-1.5 sm:grid-cols-2">
              {COACHING_BENEFIT_KEYS.map((key) => (
                <li
                  key={key}
                  className="flex items-start gap-2 text-xs font-semibold text-white/55"
                >
                  <IconTargetArrow
                    size={13}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-[#8dffd0]"
                  />
                  {t(key)}
                </li>
              ))}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Link href={COACHING_UPGRADE_URL} className={PRIMARY}>
                {t("learn.coaching.locked.cta")}
                <IconArrowRight size={15} aria-hidden="true" />
              </Link>
              <Link href="/learn/practice" className={SECONDARY}>
                {t("learn.coaching.backToPractice")}
              </Link>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-white/40">
              {t("learn.coaching.locked.note")}
            </p>
          </section>
        ) : state.status === "unavailable" ? (
          <section data-testid="coaching-unavailable" className={`mt-6 ${CARD}`}>
            <h2 className="text-xl font-black text-white">
              {t("learn.coaching.unavailable.title")}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              {t("learn.coaching.unavailable.body")}
            </p>
            <button type="button" onClick={retry} className={`${SECONDARY} mt-3`}>
              <IconRefresh size={14} aria-hidden="true" />
              {t("learn.coaching.retry")}
            </button>
          </section>
        ) : state.status === "error" ? (
          <section data-testid="coaching-error" className={`mt-6 ${CARD}`}>
            <h2 className="text-xl font-black text-white">
              {t("learn.coaching.errorTitle")}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              {t("learn.coaching.errorBody")}
            </p>
            <button
              type="button"
              onClick={retry}
              className={`${SECONDARY} mt-3`}
              data-testid="coaching-retry"
            >
              <IconRefresh size={14} aria-hidden="true" />
              {t("learn.coaching.retry")}
            </button>
          </section>
        ) : !report ? (
          <p
            role="status"
            data-testid="coaching-loading"
            className="mt-8 text-sm font-semibold text-white/50"
          >
            {t("learn.coaching.loading")}
          </p>
        ) : (
          <div data-testid="coaching-report">
            <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/30">
              {t("learn.coaching.updated", { time: generatedAt(report.generatedAt) })}
            </p>

            {/* Totals */}
            <section className={`mt-3 ${CARD}`}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  {
                    key: "lessons",
                    value: report.totals.lessonsCompleted,
                    sub: t("learn.coaching.totals.lessonsSub", {
                      completed: report.totals.lessonsCompleted,
                      total: report.totals.lessonsAvailable,
                    }),
                    icon: <IconCalendar size={14} aria-hidden="true" />,
                  },
                  {
                    key: "exercises",
                    value: report.totals.exercisesCompleted,
                    sub: t("learn.coaching.totals.exercisesSub", {
                      completed: report.totals.exercisesCompleted,
                      attempted: report.totals.exercisesAttempted,
                    }),
                    icon: <IconTargetArrow size={14} aria-hidden="true" />,
                  },
                  {
                    key: "success",
                    value: `${report.totals.successRate}%`,
                    sub: t("learn.coaching.totals.practiceSub", {
                      attempts: report.totals.practiceAttempts,
                    }),
                    icon: <IconChartBar size={14} aria-hidden="true" />,
                  },
                  {
                    key: "hints",
                    value: report.totals.hints,
                    sub: t("learn.coaching.totals.practiceSub", {
                      attempts: report.totals.practiceAttempts,
                    }),
                    icon: <IconBulb size={14} aria-hidden="true" />,
                  },
                ].map((tile) => (
                  <div
                    key={tile.key}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
                  >
                    <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]/60">
                      {tile.icon}
                      {t(`learn.coaching.totals.${tile.key}`)}
                    </p>
                    <p className="mt-0.5 font-mono text-lg font-black text-white">
                      {tile.value}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] font-semibold text-white/35">
                      {tile.sub}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {/* Weak areas and recommendations */}
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <section
                aria-labelledby="coaching-weak-title"
                className={CARD}
                data-testid="coaching-weak"
              >
                <h2
                  id="coaching-weak-title"
                  className="text-base font-extrabold text-white"
                >
                  {t("learn.coaching.weak.title")}
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                  {t("learn.coaching.weak.note")}
                </p>
                {report.weakSkills.length === 0 ? (
                  <p className="mt-3 text-sm text-white/50">
                    {t("learn.coaching.weak.none")}
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {report.weakSkills.map((skill) => (
                      <div
                        key={skill.skillId}
                        className="rounded-xl border border-[#f5ff3b]/20 bg-[#f5ff3b]/[0.04] p-3"
                      >
                        <p className="text-sm font-extrabold text-white">
                          {skillTitle(skill.skillId)}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-white/55">
                          {t(
                            `learn.coaching.weak.${weakReasonKey(
                              skill,
                              report.thresholds.lowSuccessRate,
                            )}`,
                            {
                            rate: report.thresholds.lowSuccessRate,
                            attempts: skill.attempts,
                            hints: skill.hints,
                              unfinished: skill.unfinished,
                            },
                          )}
                        </p>
                        <Link
                          href={practiceHref(skill.skillId)}
                          className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-extrabold text-[#00e5ff] underline-offset-4 hover:underline"
                        >
                          {t("learn.coaching.weak.practice")}
                          <IconArrowRight size={12} aria-hidden="true" />
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section
                aria-labelledby="coaching-recommendations-title"
                className={CARD}
                data-testid="coaching-recommendations"
              >
                <h2
                  id="coaching-recommendations-title"
                  className="text-base font-extrabold text-white"
                >
                  {t("learn.coaching.recommendations.title")}
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                  {t("learn.coaching.recommendations.note")}
                </p>
                {report.recommendations.length === 0 ? (
                  <p className="mt-3 text-sm text-white/50">
                    {t("learn.coaching.recommendations.empty")}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {report.recommendations.map((recommendation) => {
                      const key =
                        recommendation.kind === "practice"
                          ? `practice:${recommendation.exerciseId}`
                          : `lesson:${recommendation.lessonId}`;
                      const href =
                        recommendation.kind === "practice"
                          ? practiceHref(
                              recommendation.skillId,
                              recommendation.difficulty,
                            )
                          : `/learn/lessons/${recommendation.lessonId}`;
                      return (
                        <li
                          key={key}
                          className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
                        >
                          <p className="text-sm font-extrabold text-white">
                            {recommendation.kind === "practice"
                              ? exerciseTitle(recommendation.exerciseId)
                              : lessonTitle(recommendation.lessonId)}
                          </p>
                          <p className="mt-0.5 text-[11px] leading-relaxed text-white/55">
                            {t(
                              `learn.coaching.recommendations.${recommendation.reasonKey}`,
                            )}
                          </p>
                          <Link
                            href={href}
                            className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-extrabold text-[#00e5ff] underline-offset-4 hover:underline"
                          >
                            {recommendation.kind === "practice"
                              ? t("learn.coaching.recommendations.openPractice")
                              : t("learn.coaching.recommendations.openLesson")}
                            <IconArrowRight size={12} aria-hidden="true" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            {/* Daily plan */}
            <section
              aria-labelledby="coaching-plan-title"
              className={`mt-4 ${CARD}`}
              data-testid="coaching-plan"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2
                  id="coaching-plan-title"
                  className="text-base font-extrabold text-white"
                >
                  {t("learn.coaching.plan.title")}
                </h2>
                {report.plan.available && (
                  <span className="rounded-full border border-[#00ffa3]/25 bg-[#00ffa3]/10 px-2 py-0.5 font-mono text-[10px] font-black text-[#8dffd0]">
                    {t("learn.coaching.plan.minutes", {
                      count: report.plan.dailyMinutes,
                    })}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                {t("learn.coaching.plan.note")}
              </p>

              {report.plan.available ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <div className={ROW}>
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]/60">
                        {t("learn.coaching.plan.focus")}
                      </span>
                      <span className="text-xs font-extrabold text-white">
                        {report.plan.focusSkillId
                          ? skillTitle(report.plan.focusSkillId)
                          : "—"}
                      </span>
                    </div>
                    <div className={ROW}>
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]/60">
                        {t("learn.coaching.plan.difficulty")}
                      </span>
                      <span className="text-xs font-extrabold text-white">
                        {report.plan.difficulty
                          ? t(
                              `learn.practice.difficulty.${report.plan.difficulty}.label`,
                            )
                          : "—"}
                      </span>
                    </div>
                    <div className={ROW}>
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]/60">
                        {t("learn.coaching.plan.lesson")}
                      </span>
                      <span className="min-w-0 truncate text-xs font-extrabold text-white">
                        {report.plan.lessonId
                          ? lessonTitle(report.plan.lessonId)
                          : "—"}
                      </span>
                    </div>
                    <p className="pt-1 text-[11px] leading-relaxed text-white/45">
                      {t(
                        `learn.coaching.plan.${report.plan.reasonKey === "focusWeakSkill" ? "focusWeakSkill" : "resumeLesson"}`,
                      )}
                    </p>
                  </div>
                  <ol className="space-y-1.5">
                    {report.plan.items.map((item, index) => (
                      <li
                        key={`${item.kind}:${index}`}
                        className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-1.5"
                      >
                        <span className="min-w-0 text-xs font-semibold text-white/65">
                          {item.kind === "practice"
                            ? t("learn.coaching.plan.itemPractice", {
                                title: exerciseTitle(item.exerciseId),
                              })
                            : t("learn.coaching.plan.itemLesson", {
                                title: lessonTitle(item.lessonId),
                              })}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] font-bold text-[#8dffd0]">
                          {t("learn.coaching.plan.minutes", {
                            count: item.minutes,
                          })}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {report.plan.focusSkillId && (
                    <Link
                      href={practiceHref(
                        report.plan.focusSkillId,
                        report.plan.difficulty ?? undefined,
                      )}
                      className={PRIMARY}
                    >
                      <IconTargetArrow size={15} aria-hidden="true" />
                      {t("learn.coaching.plan.start")}
                    </Link>
                  )}
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.02] p-3">
                  <p className="text-sm font-bold text-white/70">
                    {t("learn.coaching.plan.unavailable")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-white/45">
                    {t(
                      `learn.coaching.plan.${report.plan.reasonKey === "noPracticeData" ? "noPracticeData" : "notEnoughData"}`,
                    )}
                  </p>
                </div>
              )}
            </section>

            {/* Analytics */}
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <section className={CARD} data-testid="coaching-skills">
                <h2 className="text-base font-extrabold text-white">
                  {t("learn.coaching.skills.title")}
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                  {t("learn.coaching.skills.note", {
                    min: report.thresholds.minAttemptsPerSkill,
                  })}
                </p>
                {report.skills.length === 0 ? (
                  <p className="mt-3 text-sm text-white/50">
                    {t("learn.coaching.skills.empty")}
                  </p>
                ) : (
                  <div className="mt-3 space-y-1.5">
                    {report.skills.map((skill) => (
                      <SkillRow
                        key={skill.skillId}
                        label={skillTitle(skill.skillId)}
                        attempts={skill.attempts}
                        completions={skill.completions}
                        success={skill.successRate}
                        hints={skill.hints}
                        attemptsLabel={t("learn.coaching.skills.attempts")}
                        completionsLabel={t("learn.coaching.skills.completions")}
                        successLabel={t("learn.coaching.skills.success")}
                        hintsLabel={t("learn.coaching.skills.hints")}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className={CARD} data-testid="coaching-difficulties">
                <h2 className="text-base font-extrabold text-white">
                  {t("learn.coaching.difficulties.title")}
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                  {t("learn.coaching.difficulties.note")}
                </p>
                {report.difficulties.length === 0 ? (
                  <p className="mt-3 text-sm text-white/50">
                    {t("learn.coaching.difficulties.empty")}
                  </p>
                ) : (
                  <div className="mt-3 space-y-1.5">
                    {report.difficulties.map((entry) => (
                      <SkillRow
                        key={entry.difficulty}
                        label={t(
                          `learn.practice.difficulty.${entry.difficulty}.label`,
                        )}
                        attempts={entry.attempts}
                        completions={entry.completions}
                        success={entry.successRate}
                        hints={entry.hints}
                        attemptsLabel={t("learn.coaching.skills.attempts")}
                        completionsLabel={t("learn.coaching.skills.completions")}
                        successLabel={t("learn.coaching.skills.success")}
                        hintsLabel={t("learn.coaching.skills.hints")}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <section
                className={CARD}
                data-testid="coaching-history"
                aria-labelledby="coaching-history-title"
              >
                <h2
                  id="coaching-history-title"
                  className="text-base font-extrabold text-white"
                >
                  {t("learn.coaching.history.title")}
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                  {t("learn.coaching.history.note")}
                </p>
                {report.history.length === 0 ? (
                  <p className="mt-3 text-sm text-white/50">
                    {t("learn.coaching.history.empty")}
                  </p>
                ) : (
                  <>
                    <div className="mt-4 flex h-28 items-end gap-1">
                      {(() => {
                        const recent = report.history.slice(-14);
                        const max = Math.max(
                          1,
                          ...recent.map((entry) => entry.attempts),
                        );
                        return recent.map((entry) => (
                          <div
                            key={entry.dayKey}
                            className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
                            title={`${entry.dayKey} · ${entry.attempts}/${entry.completions}`}
                            aria-label={`${entry.dayKey}: ${entry.attempts} attempts, ${entry.completions} completed`}
                          >
                            <div
                              className="relative w-full overflow-hidden rounded-t-md bg-[#00e5ff]/25"
                              style={{
                                height: `${Math.max(6, (entry.attempts / max) * 100)}%`,
                              }}
                            >
                              <div
                                className="absolute inset-x-0 bottom-0 rounded-t-md bg-[#00ffa3]/70"
                                style={{
                                  height: `${entry.attempts > 0 ? (entry.completions / entry.attempts) * 100 : 0}%`,
                                }}
                              />
                            </div>
                            <span className="mt-1 block truncate text-center font-mono text-[8px] font-bold text-white/30">
                              {entry.dayKey.slice(5)}
                            </span>
                          </div>
                        ));
                      })()}
                    </div>
                    <p className="mt-2 text-[10px] font-semibold text-white/35">
                      {t("learn.coaching.history.legend")}
                    </p>
                  </>
                )}
              </section>

              <section className={CARD} data-testid="coaching-comparison">
                <h2 className="text-base font-extrabold text-white">
                  {t("learn.coaching.comparison.title")}
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                  {t("learn.coaching.comparison.note", {
                    min: report.thresholds.comparisonMinAttempts,
                  })}
                </p>
                {report.comparison.comparable ? (
                  <div className="mt-3 space-y-1.5">
                    {[
                      {
                        label: t("learn.coaching.comparison.success"),
                        previous: `${report.comparison.previousSuccessRate}%`,
                        current: `${report.comparison.currentSuccessRate}%`,
                        delta: `${signed(report.comparison.delta.successRate)} pts`,
                      },
                      {
                        label: t("learn.coaching.comparison.attempts"),
                        previous: report.comparison.previous.attempts,
                        current: report.comparison.current.attempts,
                        delta: signed(report.comparison.delta.attempts),
                      },
                      {
                        label: t("learn.coaching.comparison.hints"),
                        previous: report.comparison.previous.hints,
                        current: report.comparison.current.hints,
                        delta: signed(report.comparison.delta.hints),
                      },
                    ].map((row) => (
                      <div key={row.label} className={ROW}>
                        <span className="text-xs font-bold text-white/60">
                          {row.label}
                        </span>
                        <span className="flex items-center gap-2 font-mono text-[10px] font-bold text-[#9dd8ff]/75">
                          <span className="text-white/35">{row.previous}</span>
                          <span aria-hidden="true">→</span>
                          <span>{row.current}</span>
                          <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[#8dffd0]">
                            {row.delta}
                          </span>
                        </span>
                      </div>
                    ))}
                    <p className="pt-1 text-[10px] font-semibold text-white/35">
                      {t("learn.coaching.comparison.current")} /{" "}
                      {t("learn.coaching.comparison.previous")}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-sm leading-relaxed text-white/50">
                    {t("learn.coaching.comparison.notEnough")}
                  </p>
                )}
              </section>
            </div>

            <p className="mt-4 flex items-start gap-2 rounded-xl border border-white/8 bg-white/[0.02] p-3 text-[10px] leading-relaxed text-white/35">
              <IconChartBar
                size={13}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              {t("learn.coaching.privacy")}
            </p>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Link href="/learn/practice" className={SECONDARY}>
            <IconArrowLeft size={14} aria-hidden="true" />
            {t("learn.coaching.backToPractice")}
          </Link>
          <Link href="/learn" className={SECONDARY}>
            {t("learn.subnav.back")}
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}

/**
 * The reason a skill is flagged, from the recorded numbers only. Kept in the
 * component so the copy key and the badge always agree with the engine's order.
 */
function weakReasonKey(
  skill: {
    successRate: number;
    hints: number;
    attempts: number;
    unfinished: number;
  },
  lowSuccessRate: number,
): "lowSuccess" | "hintReliance" | "unfinished" {
  if (skill.successRate < lowSuccessRate) return "lowSuccess";
  if (skill.hints >= skill.attempts) return "hintReliance";
  return "unfinished";
}
