"use client";

import Link from "next/link";
import {
  IconArrowRight,
  IconCards,
  IconCheck,
  IconClock,
  IconLock,
} from "@tabler/icons-react";

import { useLessonProgress } from "../../hooks/useLessonProgress";
import { useTranslation } from "../../hooks/useTranslation";
import { LESSON_COURSES, lessonsForCourse } from "../../lib/solitaire-duel/lessonCatalog";
import type { Lesson } from "../../lib/solitaire-duel/lessons";
import {
  courseDifficulty,
  courseProgress,
  courseState,
  lessonStatus,
  lessonStepIndex,
} from "../../lib/solitaire-duel/lessonProgress";

export function Meter({
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

export function DifficultyBadge({ value }: { value: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]">
      {t(`learn.difficulty.${value}`)}
    </span>
  );
}

export function CourseCard({
  course,
  index,
  href,
}: {
  course: (typeof LESSON_COURSES)[number];
  index: number;
  href?: string;
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
      id={`course-${course.id}`}
      data-testid="learn-course-card"
      data-course-id={course.id}
      data-state={state}
      className={`flex flex-col rounded-2xl border p-4 transition-colors sm:p-5 ${stateClasses}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-black uppercase tracking-[0.28em] text-[#00e5ff]/80">
          {t("learn.path.courseNumber", { number: index + 1 })}
        </p>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] ${
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
        <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-bold text-[#9dd8ff]">
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
              href={href ?? `/learn/courses#course-${course.id}`}
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

export function LessonCard({ lesson }: { lesson: Lesson }) {
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
      className="flex flex-col rounded-2xl border border-white/10 bg-surface/80 p-4 transition-colors hover:border-[#00e5ff]/25"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#00e5ff]/70">
          {course ? t(course.titleKey) : ""}
        </p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
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
          <p className="mb-1.5 text-[11px] font-bold text-[#9dd8ff]/80">
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
