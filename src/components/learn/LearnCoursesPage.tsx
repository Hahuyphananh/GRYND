"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { IconArrowLeft, IconSchool } from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import { CourseCard, LessonCard } from "./LearnCards";
import LearnSubnav from "./LearnSubnav";
import { useLessonProgress } from "../../hooks/useLessonProgress";
import { useTranslation } from "../../hooks/useTranslation";
import { LESSON_COURSES, lessonsForCourse } from "../../lib/solitaire-duel/lessonCatalog";
import {
  lessonStatus,
  orderedLessons,
  overallProgress,
  type LessonStatus,
} from "../../lib/solitaire-duel/lessonProgress";

type StatusFilter = "all" | LessonStatus;

export default function LearnCoursesPage() {
  const { t } = useTranslation();
  const { progress } = useLessonProgress();
  const [courseFilter, setCourseFilter] = useState("all");
  const [difficultyFilter, setDifficultyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const stats = useMemo(() => overallProgress(progress), [progress]);
  const allLessons = useMemo(() => orderedLessons(), []);
  const courses = useMemo(
    () => [...LESSON_COURSES].sort((a, b) => a.order - b.order),
    [],
  );

  const filteredLessons = useMemo(
    () =>
      allLessons.filter((lesson) => {
        if (courseFilter !== "all" && lesson.courseId !== courseFilter) return false;
        if (difficultyFilter !== "all" && lesson.difficulty !== difficultyFilter) return false;
        if (statusFilter !== "all" && lessonStatus(progress, lesson) !== statusFilter) return false;
        return true;
      }),
    [allLessons, courseFilter, difficultyFilter, statusFilter, progress],
  );

  const hasFilters =
    courseFilter !== "all" || difficultyFilter !== "all" || statusFilter !== "all";

  return (
    <div className="relative min-h-dvh overflow-hidden bg-page pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.13),transparent_62%)]"
      />
      <NavigationBar currentPath="/learn" />

      <div className="relative mx-auto max-w-6xl px-4 pt-6 sm:px-6 md:pt-8">
        <Link
          href="/learn"
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 transition hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          {t("learn.subnav.back")}
        </Link>

        <LearnSubnav active="courses" />

        <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
              {t("learn.path.kicker")}
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
              {t("learn.path.title")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">
              {t("learn.path.description")}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-white/45">
            <IconSchool size={14} aria-hidden="true" />
            {t("learn.progress.lessons", {
              completed: stats.completedLessons,
              total: stats.totalLessons,
            })}
          </span>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {courses.map((course, index) => {
            const first = lessonsForCourse(course.id)[0];
            return (
              <CourseCard
                key={course.id}
                course={course}
                index={index}
                href={first ? `/learn/${first.id}` : undefined}
              />
            );
          })}
        </div>

        <section className="mt-10" aria-labelledby="learn-library-title">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
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
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                {t("learn.library.course")}
              </span>
              <select
                value={courseFilter}
                onChange={(event) => setCourseFilter(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-white/10 bg-surface px-3 text-sm font-semibold text-white outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                <option value="all">{t("learn.library.allCourses")}</option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {t(course.titleKey)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                {t("learn.library.difficulty")}
              </span>
              <select
                value={difficultyFilter}
                onChange={(event) => setDifficultyFilter(event.target.value)}
                className="min-h-10 w-full rounded-lg border border-white/10 bg-surface px-3 text-sm font-semibold text-white outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
              >
                <option value="all">{t("learn.library.allDifficulties")}</option>
                <option value="beginner">{t("learn.difficulty.beginner")}</option>
                <option value="intermediate">{t("learn.difficulty.intermediate")}</option>
                <option value="advanced">{t("learn.difficulty.advanced")}</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.16em] text-[#9dd8ff]/70">
                {t("learn.library.status")}
              </span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                className="min-h-10 w-full rounded-lg border border-white/10 bg-surface px-3 text-sm font-semibold text-white outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
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
      </div>

      <Footer />
    </div>
  );
}
