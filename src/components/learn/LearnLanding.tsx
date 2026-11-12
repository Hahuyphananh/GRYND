"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  IconArrowRight,
  IconCards,
  IconCheck,
  IconClock,
  IconLock,
  IconSchool,
  IconStack2,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import { useLessonProgress } from "../../hooks/useLessonProgress";
import { useTranslation } from "../../hooks/useTranslation";
import {
  LESSON_COURSES,
  lessonsForCourse,
} from "../../lib/solitaire-duel/lessonCatalog";
import type { Lesson } from "../../lib/solitaire-duel/lessons";
import {
  courseDifficulty,
  courseProgress,
  courseState,
  isLessonCompleted,
  lessonStatus,
  lessonStepIndex,
  orderedLessons,
  overallProgress,
  recommendedLesson,
  type LessonStatus,
} from "../../lib/solitaire-duel/lessonProgress";

type StatusFilter = "all" | LessonStatus;

function Meter({
  percent,
  label,
  className = "",
}: {
  percent: number;
  label: string;
  className?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-label={label}
      className={`h-1.5 overflow-hidden rounded-full bg-white/10 ${className}`}
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#00e5ff] to-[#00ffa3] transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function DifficultyBadge({ value }: { value: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]">
      {t(`learn.difficulty.${value}`)}
    </span>
  );
}

function CourseCard({
  course,
  index,
}: {
  course: (typeof LESSON_COURSES)[number];
  index: number;
}) {
  const { t } = useTranslation();
  const { progress } = useLessonProgress();
  const state = courseState(progress, course.id);
  const stats = courseProgress(progress, course.id);
  const lessons = lessonsForCourse(course.id);
  const first = lessons[0];
  const percent = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;
  const locked = state === "locked";

  const stateClasses =
    state === "completed"
      ? "border-[#00ffa3]/30 bg-[#00ffa3]/[0.06]"
      : state === "available"
        ? "border-[#00e5ff]/30 bg-[#00e5ff]/[0.05]"
        : "border-white/10 bg-white/[0.02]";

  return (
    <article
      data-testid="learn-course-card"
      data-course-id={course.id}
      data-state={state}
      className={`flex flex-col rounded-2xl border p-4 transition-colors sm:p-5 ${stateClasses}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-black uppercase tracking-[0.28em] text-[#00e5ff]/80">
          {t("learn.path.courseNumber", { number: index + 1 })}
        </p>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${
            state === "completed"
              ? "bg-[#00ffa3]/15 text-[#8dffd0]"
              : state === "available"
                ? "bg-[#00e5ff]/10 text-[#9dd8ff]"
                : "bg-white/5 text-white/40"
          }`}
        >
          {state === "completed" ? (
            <IconCheck size={11} aria-hidden="true" />
          ) : locked ? (
            <IconLock size={11} aria-hidden="true" />
          ) : null}
          {t(`learn.status.${state}`)}
        </span>
      </div>

      <h3 className="mt-3 text-xl font-black tracking-tight text-white">
        {t(course.titleKey)}
      </h3>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-white/55">
        {t(course.descriptionKey)}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <DifficultyBadge value={courseDifficulty(course.id)} />
        <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold text-[#9dd8ff]">
          <IconCards size={12} aria-hidden="true" />
          {t("learn.path.lessons", { count: stats.total })}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-white/45">
          <IconClock size={12} aria-hidden="true" />
          {t("learn.path.progress", { completed: stats.completed, total: stats.total })}
        </span>
      </div>

      <Meter
        percent={percent}
        label={t("learn.path.progress", { completed: stats.completed, total: stats.total })}
        className="mt-4"
      />

      <div className="mt-4">
        {locked ? (
          <p className="flex items-center gap-2 text-xs font-semibold text-white/40">
            <IconLock size={14} aria-hidden="true" />
            {t("learn.path.lockedHint")}
          </p>
        ) : (
          first && (
            <Link
              href={`/learn/${first.id}`}
              className="inline-flex items-center gap-1.5 text-xs font-extrabold text-[#00e5ff] underline-offset-4 transition hover:text-[#8df6ff] hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              {state === "completed" ? t("learn.path.review") : t("learn.path.open")}
              <IconArrowRight size={14} aria-hidden="true" />
            </Link>
          )
        )}
      </div>
    </article>
  );
}

function LessonCard({ lesson }: { lesson: Lesson }) {
  const { t } = useTranslation();
  const { progress } = useLessonProgress();
  const course = LESSON_COURSES.find((item) => item.id === lesson.courseId);
  const state = course ? courseState(progress, course.id) : "locked";
  const status = lessonStatus(progress, lesson);
  const step = lessonStepIndex(progress, lesson);
  const locked = state === "locked";
  const percent = Math.round((step / lesson.steps.length) * 100);

  return (
    <article
      data-testid="learn-lesson-card"
      data-lesson-id={lesson.id}
      data-status={status}
      className="flex flex-col rounded-2xl border border-white/10 bg-[#071128]/80 p-4 transition-colors hover:border-[#00e5ff]/25"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#00e5ff]/70">
          {course ? t(course.titleKey) : ""}
        </p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
            status === "completed"
              ? "bg-[#00ffa3]/15 text-[#8dffd0]"
              : status === "in-progress"
                ? "bg-[#f5ff3b]/10 text-[#f5ff3b]"
                : locked
                  ? "bg-white/5 text-white/40"
                  : "bg-[#00e5ff]/10 text-[#9dd8ff]"
          }`}
        >
          {t(`learn.status.${status === "not-started" ? (locked ? "locked" : "notStarted") : status === "in-progress" ? "inProgress" : "completed"}`)}
        </span>
      </div>

      <h3 className="mt-2 text-base font-extrabold leading-snug text-white">
        {t(lesson.titleKey)}
      </h3>
      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-white/50">
        {t(lesson.descriptionKey)}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <DifficultyBadge value={lesson.difficulty} />
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-white/40">
          <IconClock size={12} aria-hidden="true" />
          {t("learn.lesson.minutes", { minutes: lesson.estimatedMinutes })}
        </span>
      </div>

      {status === "in-progress" && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-bold text-[#9dd8ff]/80">
            {t("learn.lesson.stepProgress", { step, total: lesson.steps.length })}
          </p>
          <Meter
            percent={percent}
            label={t("learn.lesson.stepProgress", { step, total: lesson.steps.length })}
          />
        </div>
      )}

      <div className="mt-4">
        {locked ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-white/35">
            <IconLock size={13} aria-hidden="true" />
            {t("learn.lesson.locked")}
          </span>
        ) : (
          <Link
            href={`/learn/${lesson.id}`}
            className="inline-flex items-center gap-1.5 text-xs font-extrabold text-[#00e5ff] underline-offset-4 transition hover:text-[#8df6ff] hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {status === "completed"
              ? t("learn.lesson.review")
              : status === "in-progress"
                ? t("learn.lesson.resume")
                : t("learn.lesson.start")}
            <IconArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
    </article>
  );
}

export default function LearnLanding() {
  const { t } = useTranslation();
  const { progress, userId, isLoaded } = useLessonProgress();
  const [courseFilter, setCourseFilter] = useState("all");
  const [difficultyFilter, setDifficultyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const stats = useMemo(() => overallProgress(progress), [progress]);
  const recommended = useMemo(() => recommendedLesson(progress), [progress]);
  const recommendedCourse = recommended
    ? LESSON_COURSES.find((course) => course.id === recommended.courseId)
    : null;
  const recommendedStep = recommended
    ? lessonStepIndex(progress, recommended)
    : 0;
  const allLessons = useMemo(() => orderedLessons(), []);

  const filteredLessons = useMemo(
    () =>
      allLessons.filter((lesson) => {
        if (courseFilter !== "all" && lesson.courseId !== courseFilter) return false;
        if (difficultyFilter !== "all" && lesson.difficulty !== difficultyFilter) {
          return false;
        }
        if (statusFilter !== "all" && lessonStatus(progress, lesson) !== statusFilter) {
          return false;
        }
        return true;
      }),
    [allLessons, courseFilter, difficultyFilter, statusFilter, progress],
  );

  const hasFilters =
    courseFilter !== "all" || difficultyFilter !== "all" || statusFilter !== "all";

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#040712] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.14),transparent_62%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 top-72 h-80 w-80 rounded-full bg-[#00ffa3]/[0.05] blur-3xl"
      />

      <NavigationBar currentPath="/learn" />

      <main className="relative mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
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
            className="flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-[#071128]/90 p-4 lg:w-auto lg:min-w-[340px]"
          >
            <div
              className="relative h-20 w-20 shrink-0 rounded-full p-[7px]"
              style={{
                background: `conic-gradient(#00e5ff ${stats.percent}%, rgba(255,255,255,0.08) 0)`,
              }}
              aria-hidden="true"
            >
              <div className="flex h-full w-full items-center justify-center rounded-full bg-[#071128]">
                <span className="text-lg font-black text-white">{stats.percent}%</span>
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#9dd8ff]/70">
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
                <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">
                  {userId ? t("learn.progress.account") : t("learn.progress.guest")}
                </p>
              )}
            </div>
          </section>
        </div>

        {/* Continue Learning ------------------------------------------------ */}
        <section className="mt-8" aria-labelledby="learn-continue-title">
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
            {t("learn.continue.kicker")}
          </p>
          <h2 id="learn-continue-title" className="mt-1 text-lg font-extrabold text-white">
            {t("learn.continue.title")}
          </h2>

          {recommended ? (
            <div className="mt-3 grid gap-4 rounded-2xl border border-[#00e5ff]/25 bg-gradient-to-br from-[#0a2044] via-[#07132b] to-[#061020] p-4 sm:p-5 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#00e5ff]/30 bg-[#00e5ff]/10 text-[#00e5ff]">
                <IconStack2 size={24} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#9dd8ff]/65">
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
                  <span className="shrink-0 text-[11px] font-bold text-[#9dd8ff]/80">
                    {t("learn.continue.step", {
                      step: recommendedStep,
                      total: recommended.steps.length,
                    })}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <DifficultyBadge value={recommended.difficulty} />
                  <span className="text-[11px] font-semibold text-white/40">
                    {t("learn.lesson.minutes", {
                      minutes: recommended.estimatedMinutes,
                    })}
                  </span>
                </div>
              </div>
              <Link
                href={`/learn/${recommended.id}`}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-5 py-2.5 text-sm font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#07132b]"
              >
                {recommendedStep > 0
                  ? t("learn.continue.resume")
                  : t("learn.continue.start")}
                <IconArrowRight size={17} aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-4 rounded-2xl border border-[#00ffa3]/25 bg-[#00ffa3]/[0.06] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#00ffa3]/15 text-[#8dffd0]">
                  <IconCheck size={22} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-base font-extrabold text-[#c8ffe6]">
                    {t("learn.continue.allDone")}
                  </h3>
                  <p className="mt-1 max-w-xl text-xs leading-relaxed text-[#9dd8ff]/70">
                    {t("learn.continue.allDoneBody")}
                  </p>
                </div>
              </div>
              {allLessons[0] && (
                <Link
                  href={`/learn/${allLessons[0].id}`}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-[#00ffa3]/35 px-4 py-2 text-sm font-extrabold text-[#8dffd0] transition hover:bg-[#00ffa3]/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00ffa3]"
                >
                  {t("learn.continue.allDoneButton")}
                  <IconArrowRight size={16} aria-hidden="true" />
                </Link>
              )}
            </div>
          )}
        </section>

        {/* Learning path ---------------------------------------------------- */}
        <section className="mt-10" aria-labelledby="learn-path-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
                {t("learn.path.kicker")}
              </p>
              <h2 id="learn-path-title" className="mt-1 text-2xl font-black tracking-tight">
                {t("learn.path.title")}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/50">
                {t("learn.path.description")}
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/40">
              <IconSchool size={15} aria-hidden="true" />
              {t("learn.progress.lessons", {
                completed: stats.completedLessons,
                total: stats.totalLessons,
              })}
            </span>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {[...LESSON_COURSES]
              .sort((a, b) => a.order - b.order)
              .map((course, index) => (
                <CourseCard key={course.id} course={course} index={index} />
              ))}
          </div>
        </section>

        {/* Lesson library --------------------------------------------------- */}
        <section className="mt-10" aria-labelledby="learn-library-title">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
              {t("learn.library.kicker")}
            </p>
            <h2 id="learn-library-title" className="mt-1 text-2xl font-black tracking-tight">
              {t("learn.library.title")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/50">
              {t("learn.library.description")}
            </p>
          </div>

          <div className="mt-4 grid gap-3 rounded-2xl border border-white/10 bg-[#061020]/80 p-3 sm:grid-cols-3 sm:p-4">
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                {t("learn.library.course")}
              </span>
              <select
                value={courseFilter}
                onChange={(event) => setCourseFilter(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-white/10 bg-[#071128] px-3 text-sm font-semibold text-white outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                <option value="all">{t("learn.library.allCourses")}</option>
                {[...LESSON_COURSES]
                  .sort((a, b) => a.order - b.order)
                  .map((course) => (
                    <option key={course.id} value={course.id}>
                      {t(course.titleKey)}
                    </option>
                  ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                {t("learn.library.difficulty")}
              </span>
              <select
                value={difficultyFilter}
                onChange={(event) => setDifficultyFilter(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-white/10 bg-[#071128] px-3 text-sm font-semibold text-white outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                <option value="all">{t("learn.library.allDifficulties")}</option>
                <option value="beginner">{t("learn.difficulty.beginner")}</option>
                <option value="intermediate">
                  {t("learn.difficulty.intermediate")}
                </option>
                <option value="advanced">{t("learn.difficulty.advanced")}</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                {t("learn.library.status")}
              </span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                className="min-h-10 w-full rounded-lg border border-white/10 bg-[#071128] px-3 text-sm font-semibold text-white outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                <option value="all">{t("learn.library.allStatuses")}</option>
                <option value="not-started">{t("learn.status.notStarted")}</option>
                <option value="in-progress">{t("learn.status.inProgress")}</option>
                <option value="completed">{t("learn.status.completed")}</option>
              </select>
            </label>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold text-white/40" aria-live="polite">
              {t("learn.library.results", { count: filteredLessons.length })}
            </p>
            {hasFilters && (
              <button
                type="button"
                onClick={() => {
                  setCourseFilter("all");
                  setDifficultyFilter("all");
                  setStatusFilter("all");
                }}
                className="text-[11px] font-bold text-[#00e5ff] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                {t("learn.library.clear")}
              </button>
            )}
          </div>

          {filteredLessons.length > 0 ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredLessons.map((lesson) => (
                <LessonCard key={lesson.id} lesson={lesson} />
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center">
              <p className="text-sm font-semibold text-white/50">
                {t("learn.library.empty")}
              </p>
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
