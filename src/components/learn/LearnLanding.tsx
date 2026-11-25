"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import {
  IconArrowRight,
  IconCards,
  IconChartBar,
  IconCheck,
  IconPlayerPlay,
  IconSchool,
  IconStack2,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import GlitchSay from "../mascot/GlitchSay";
import { CourseCard, DifficultyBadge, Meter } from "./LearnCards";
import { useAcademyVideoProgress } from "../../hooks/useAcademyVideoProgress";
import { useLessonProgress } from "../../hooks/useLessonProgress";
import { useTranslation } from "../../hooks/useTranslation";
import { watchedVideoCount } from "../../lib/academyVideoProgress";
import { ACADEMY_VIDEOS } from "../../lib/academyVideos";
import { LESSON_COURSES } from "../../lib/solitaire-duel/lessonCatalog";
import {
  lessonStepIndex,
  orderedLessons,
  overallProgress,
  recommendedLesson,
} from "../../lib/solitaire-duel/lessonProgress";

function DestinationCard({
  href,
  icon,
  title,
  description,
  meta,
  cta,
  tone,
  testId,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  description: string;
  meta: string;
  cta: string;
  tone: "cyan" | "green" | "amber";
  testId: string;
}) {
  const tones = {
    cyan: "border-[color:var(--accent)] bg-[color:var(--accent-fill)] text-[color:var(--text-secondary)]",
    green: "border-[color:var(--state-win)] bg-[color:var(--bg-panel)] text-[color:var(--state-win)]",
    amber: "border-[color:var(--state-gold)] bg-[color:var(--bg-panel)] text-[color:var(--state-gold)]",
  } as const;

  return (
    <Link
      href={href}
      data-testid={testId}
      className="group flex min-h-full flex-col rounded-2xl border border-white/10 bg-[color:var(--bg-surface)] p-4 transition hover:border-[color:var(--accent)] hover:bg-[color:var(--bg-panel)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] sm:p-5"
    >
      <span className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border ${tones[tone]}`}>
        {icon}
      </span>
      <h3 className="mt-3 text-lg font-black tracking-tight text-white">{title}</h3>
      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-white/55">{description}</p>
      <span className="mt-3 text-[11px] font-bold uppercase tracking-[0.16em] text-white/35">
        {meta}
      </span>
      <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-extrabold text-[color:var(--accent-strong)]">
        {cta}
        <IconArrowRight
          size={14}
          aria-hidden="true"
          className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
        />
      </span>
    </Link>
  );
}

export default function LearnLanding() {
  const { t } = useTranslation();
  const { progress, userId, isLoaded } = useLessonProgress();
  const { progress: videoProgress } = useAcademyVideoProgress();
  const watched = watchedVideoCount(videoProgress);

  const stats = useMemo(() => overallProgress(progress), [progress]);
  const recommended = useMemo(() => recommendedLesson(progress), [progress]);
  const recommendedCourse = recommended
    ? LESSON_COURSES.find((course) => course.id === recommended.courseId)
    : null;
  const recommendedStep = recommended
    ? lessonStepIndex(progress, recommended)
    : 0;
  const allLessons = useMemo(() => orderedLessons(), []);

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[color:var(--bg-page)] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.14),transparent_62%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 top-72 h-80 w-80 rounded-full bg-[color:var(--bg-panel)] blur-3xl"
      />

      <NavigationBar currentPath="/learn" />

      <div className="relative mx-auto max-w-6xl px-4 pt-6 sm:px-6 md:pt-8">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
          {t("learn.kicker")}
        </p>
        <div className="mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl">
              {t("learn.title")}
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
              {t("learn.description")}
            </p>
          </div>

          <section
            aria-label={t("learn.progress.title")}
            className="flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-[color:var(--bg-surface)] p-4 lg:w-auto lg:min-w-[340px]"
          >
            <div
              className="relative h-20 w-20 shrink-0 rounded-full p-[7px]"
              style={{
                background: `conic-gradient(var(--accent) ${stats.percent}%, rgba(255,255,255,0.08) 0)`,
              }}
              aria-hidden="true"
            >
              <div className="flex h-full w-full items-center justify-center rounded-full bg-[color:var(--bg-surface)]">
                <span className="text-lg font-black text-white">{stats.percent}%</span>
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
                {t("learn.progress.title")}
              </p>
              <p className="mt-1 text-sm font-extrabold text-white">
                {t("learn.progress.lessons", {
                  completed: stats.completedLessons,
                  total: stats.totalLessons,
                })}
              </p>
              <p className="mt-0.5 text-xs font-semibold text-white/45">
                {t("learn.progress.steps", {
                  completed: stats.completedSteps,
                  total: stats.totalSteps,
                })}
              </p>
              {isLoaded && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-white/35">
                  {userId ? t("learn.progress.account") : t("learn.progress.guest")}
                </p>
              )}
            </div>
          </section>
        </div>

        <div className="mt-6 rounded-2xl border border-[#00e5ff]/25 bg-[#06152f]/90 p-3">
          <GlitchSay
            size="sm"
            message="Start with a lesson or a demo. Glitch explains each objective, shows the move, then lets you play it on the real board."
          />
        </div>

        <section className="mt-8" aria-labelledby="learn-continue-title">
          <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[color:var(--accent-strong)]">
            {t("learn.continue.kicker")}
          </p>
          <h2 id="learn-continue-title" className="mt-1 text-lg font-extrabold text-white">
            {t("learn.continue.title")}
          </h2>

          {recommended ? (
            <div className="mt-3 grid gap-4 rounded-2xl border border-[color:var(--accent)] bg-gradient-to-br from-[color:var(--bg-surface)] via-[color:var(--bg-panel)] to-[color:var(--bg-surface)] p-4 sm:p-5 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--accent-fill)] text-[color:var(--accent-strong)]">
                <IconStack2 size={24} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                  {recommendedCourse ? t(recommendedCourse.titleKey) : ""}
                </p>
                <h3 className="mt-1 truncate text-xl font-black tracking-tight text-white">
                  {t(recommended.titleKey)}
                </h3>
                <div className="mt-3 flex max-w-md items-center gap-3">
                  <Meter
                    percent={(recommendedStep / recommended.steps.length) * 100}
                    label={t("learn.continue.step", {
                      step: recommendedStep,
                      total: recommended.steps.length,
                    })}
                    className="flex-1"
                  />
                  <span className="shrink-0 text-[11px] font-bold text-[color:var(--text-secondary)]">
                    {t("learn.continue.step", {
                      step: recommendedStep,
                      total: recommended.steps.length,
                    })}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <DifficultyBadge value={recommended.difficulty} />
                  <span className="text-[11px] font-semibold text-white/40">
                    {t("learn.lesson.minutes", { minutes: recommended.estimatedMinutes })}
                  </span>
                </div>
              </div>
              <Link
                href={`/learn/${recommended.id}`}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[color:var(--accent)] px-5 py-2.5 text-sm font-black text-[color:var(--on-accent)] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-page)]"
              >
                {recommendedStep > 0 ? t("learn.continue.resume") : t("learn.continue.start")}
                <IconArrowRight size={17} aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-4 rounded-2xl border border-[color:var(--state-win)] bg-[color:var(--bg-panel)] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--bg-panel)] text-[color:var(--state-win)]">
                  <IconCheck size={22} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-base font-extrabold text-[color:var(--state-win)]">
                    {t("learn.continue.allDone")}
                  </h3>
                  <p className="mt-1 max-w-xl text-xs leading-relaxed text-[color:var(--text-muted)]">
                    {t("learn.continue.allDoneBody")}
                  </p>
                </div>
              </div>
              {allLessons[0] && (
                <Link
                  href={`/learn/${allLessons[0].id}`}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-[color:var(--state-win)] px-4 py-2 text-sm font-extrabold text-[color:var(--state-win)] transition hover:bg-[color:var(--bg-panel)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--state-win)]"
                >
                  {t("learn.continue.allDoneButton")}
                  <IconArrowRight size={16} aria-hidden="true" />
                </Link>
              )}
            </div>
          )}
        </section>

        <section className="mt-10" aria-labelledby="learn-destinations-title">
          <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[color:var(--accent-strong)]">
            {t("learn.destinations.kicker")}
          </p>
          <h2 id="learn-destinations-title" className="mt-1 text-2xl font-black tracking-tight">
            {t("learn.destinations.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/50">
            {t("learn.destinations.description")}
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <DestinationCard
              href="/learn/courses"
              icon={<IconSchool size={21} aria-hidden="true" />}
              title={t("learn.destinations.courses.title")}
              description={t("learn.destinations.courses.description")}
              meta={t("learn.progress.lessons", {
                completed: stats.completedLessons,
                total: stats.totalLessons,
              })}
              cta={t("learn.destinations.courses.cta")}
              tone="cyan"
              testId="learn-destination-courses"
            />
            <DestinationCard
              href="/learn/practice"
              icon={<IconCards size={21} aria-hidden="true" />}
              title={t("learn.destinations.practice.title")}
              description={t("learn.destinations.practice.description")}
              meta={t("learn.destinations.practice.meta")}
              cta={t("learn.destinations.practice.cta")}
              tone="green"
              testId="learn-destination-practice"
            />
            <DestinationCard
              href="/learn/videos"
              icon={<IconPlayerPlay size={21} aria-hidden="true" />}
              title={t("learn.destinations.videos.title")}
              description={t("learn.destinations.videos.description")}
              meta={t("learn.videos.watchedCount", {
                watched,
                total: ACADEMY_VIDEOS.length,
              })}
              cta={t("learn.destinations.videos.cta")}
              tone="amber"
              testId="learn-destination-videos"
            />
            <DestinationCard
              href="/learn/coaching"
              icon={<IconChartBar size={21} aria-hidden="true" />}
              title={t("learn.destinations.coaching.title")}
              description={t("learn.destinations.coaching.description")}
              meta={t("learn.destinations.coaching.meta")}
              cta={t("learn.destinations.coaching.cta")}
              tone="cyan"
              testId="learn-destination-coaching"
            />
          </div>
        </section>

        <section className="mt-10" aria-labelledby="learn-path-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[color:var(--accent-strong)]">
                {t("learn.path.kicker")}
              </p>
              <h2 id="learn-path-title" className="mt-1 text-2xl font-black tracking-tight">
                {t("learn.path.title")}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/50">
                {t("learn.path.description")}
              </p>
            </div>
            <Link
              href="/learn/courses"
              className="inline-flex items-center gap-1.5 text-xs font-extrabold text-[color:var(--accent-strong)] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
            >
              {t("learn.path.allCourses")}
              <IconArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {[...LESSON_COURSES]
              .sort((a, b) => a.order - b.order)
              .map((course, index) => (
                <CourseCard key={course.id} course={course} index={index} />
              ))}
          </div>
        </section>
      </div>

      <Footer />
    </div>
  );
}
