"use client";

// src/components/stats/SolitaireAcademyStats.tsx
//
// Solitaire Academy analytics on /stats.
//
// PRO: the server-built coaching report (POST /api/learn/coaching) — the SAME
// entitlement-gated endpoint the coaching page uses, so a client cannot unlock
// it by flipping a prop.
//
// FREE / GUEST: the player's own device-local summary is shown BLURRED behind a
// lock, with the upgrade path. The blur is presentation only; the advanced skill
// analytics are never sent to a non-member because the API refuses them.
//
// No fabricated numbers: the blurred preview is the player's real local record
// (or an honest empty state).

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconArrowRight,
  IconBulb,
  IconChartBar,
  IconLock,
  IconRefresh,
  IconTargetArrow,
} from "@tabler/icons-react";

import { useLessonProgress } from "../../hooks/useLessonProgress";
import { usePracticeProgress } from "../../hooks/usePracticeProgress";
import { useTranslation } from "../../hooks/useTranslation";
import {
  coachingSnapshotFromLocal,
  type CoachingReport,
} from "../../lib/learn/coaching";
import { overallProgress } from "../../lib/solitaire-duel/lessonProgress";
import { practiceStats } from "../../lib/solitaire-duel/practiceProgress";
import { PRACTICE_SKILL_BY_ID } from "../../lib/solitaire-duel/practice";

type LoadState = "idle" | "loading" | "ready" | "error";

function Tile({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]/60">
        {icon}
        {label}
      </p>
      <p className="mt-0.5 font-mono text-lg font-black text-white">{value}</p>
    </div>
  );
}

export default function SolitaireAcademyStats({
  signedIn,
  pro,
  membershipUnavailable = false,
}: {
  signedIn: boolean;
  pro: boolean;
  membershipUnavailable?: boolean;
}) {
  const { t } = useTranslation();
  const lessons = useLessonProgress();
  const practice = usePracticeProgress();

  const snapshot = useMemo(
    () => coachingSnapshotFromLocal(lessons.progress, practice.progress),
    [lessons.progress, practice.progress],
  );
  const local = useMemo(() => overallProgress(lessons.progress), [lessons.progress]);
  const practiceLocal = useMemo(
    () => practiceStats(practice.progress),
    [practice.progress],
  );
  const localSkills = useMemo(
    () =>
      Object.entries(practice.progress.bySkill)
        .filter(([, bucket]) => bucket.attempts > 0)
        .sort((a, b) => b[1].attempts - a[1].attempts)
        .slice(0, 3)
        .map(([skillId, bucket]) => ({
          skillId,
          attempts: bucket.attempts,
          successRate:
            bucket.attempts > 0
              ? Math.round((bucket.completions / bucket.attempts) * 100)
              : 0,
        })),
    [practice.progress],
  );

  const [state, setState] = useState<LoadState>(pro ? "idle" : "idle");
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!signedIn || !pro || membershipUnavailable) return undefined;
    if (!lessons.isProgressLoaded || !practice.isProgressLoaded) return undefined;

    const controller = new AbortController();
    setState("loading");
    fetch("/api/learn/coaching", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, snapshot }),
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { success?: boolean; report?: CoachingReport }
          | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !body?.success || !body.report) {
          setState("error");
          return;
        }
        setReport(body.report);
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });

    return () => controller.abort();
  }, [
    signedIn,
    pro,
    membershipUnavailable,
    lessons.isProgressLoaded,
    practice.isProgressLoaded,
    snapshot,
    reloadToken,
  ]);

  const totals = report
    ? {
        lessons: report.totals.lessonsCompleted,
        exercises: report.totals.exercisesCompleted,
        success: `${report.totals.successRate}%`,
        hints: report.totals.hints,
      }
    : {
        lessons: local.completedLessons,
        exercises: practiceLocal.exercisesCompleted,
        success: `${practiceLocal.successRate}%`,
        hints: practiceLocal.hints,
      };

  const skills = report
    ? report.skills.slice(0, 3).map((skill) => ({
        skillId: skill.skillId,
        attempts: skill.attempts,
        successRate: skill.successRate,
      }))
    : localSkills;

  return (
    <section
      data-testid="stats-solitaire"
      aria-labelledby="stats-solitaire-title"
      className="mb-6 overflow-hidden rounded-2xl border border-[#00e5ff]/25 bg-[#06152f]/90"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#00e5ff]/80">
            {t("learn.coaching.kicker")}
          </p>
          <h2
            id="stats-solitaire-title"
            className="mt-1 text-xl font-black text-white sm:text-2xl"
          >
            {t("learn.coaching.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/50">
            {t("learn.coaching.description")}
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] ${
            pro
              ? "border-[#00ffa3]/35 bg-[#00ffa3]/10 text-[#8dffd0]"
              : "border-[#f5ff3b]/35 bg-[#f5ff3b]/10 text-[#ffe9a3]"
          }`}
        >
          {pro ? t("playHub.pro") : t("playHub.free")}
        </span>
      </div>

      <div className="relative border-t border-white/8 p-5">
        {pro && membershipUnavailable ? (
          <p className="text-sm text-white/55">
            {t("learn.coaching.unavailable.body")}
          </p>
        ) : pro && state === "error" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-white/55">{t("learn.coaching.errorBody")}</p>
            <button
              type="button"
              onClick={() => setReloadToken((token) => token + 1)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-bold text-[#9dd8ff]"
            >
              <IconRefresh size={13} aria-hidden="true" />
              {t("learn.coaching.retry")}
            </button>
          </div>
        ) : pro && state !== "ready" ? (
          <p role="status" className="text-sm font-semibold text-white/45">
            {t("learn.coaching.loading")}
          </p>
        ) : (
          <div className={pro ? undefined : "relative"}>
            <div
              className={pro ? undefined : "pointer-events-none select-none blur-[5px]"}
              aria-hidden={pro ? undefined : "true"}
              data-testid={pro ? undefined : "stats-solitaire-blurred"}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile
                  label={t("learn.coaching.totals.lessons")}
                  value={totals.lessons}
                  icon={<IconChartBar size={12} aria-hidden="true" />}
                />
                <Tile
                  label={t("learn.coaching.totals.exercises")}
                  value={totals.exercises}
                  icon={<IconTargetArrow size={12} aria-hidden="true" />}
                />
                <Tile
                  label={t("learn.coaching.totals.success")}
                  value={totals.success}
                  icon={<IconChartBar size={12} aria-hidden="true" />}
                />
                <Tile
                  label={t("learn.coaching.totals.hints")}
                  value={totals.hints}
                  icon={<IconBulb size={12} aria-hidden="true" />}
                />
              </div>

              <div className="mt-3 space-y-1.5">
                {skills.length === 0 ? (
                  <p className="text-xs text-white/45">
                    {t("learn.coaching.skills.empty")}
                  </p>
                ) : (
                  skills.map((skill) => (
                    <div
                      key={skill.skillId}
                      className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-1.5"
                    >
                      <span className="truncate text-xs font-semibold text-white/60">
                        {PRACTICE_SKILL_BY_ID[skill.skillId]
                          ? t(PRACTICE_SKILL_BY_ID[skill.skillId].titleKey)
                          : skill.skillId}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] font-bold text-[#9dd8ff]/75">
                        {skill.attempts} · {skill.successRate}%
                      </span>
                    </div>
                  ))
                )}
              </div>

              {report && report.history.length > 0 && (
                <div className="mt-3 flex h-16 items-end gap-1">
                  {report.history.slice(-14).map((day) => (
                    <div
                      key={day.dayKey}
                      className="min-w-0 flex-1 rounded-t bg-[#00e5ff]/35"
                      style={{
                        height: `${Math.max(
                          6,
                          (day.attempts /
                            Math.max(1, ...report.history.map((entry) => entry.attempts))) *
                            100,
                        )}%`,
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            {!pro && (
              <div
                data-testid="stats-solitaire-lock"
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-surface/60 p-4 text-center backdrop-blur-[1px]"
              >
                <IconLock size={22} aria-hidden="true" className="text-[#f5ff3b]" />
                <p className="text-sm font-black text-[#f5ff3b]">
                  {t("stats.locked.title")}
                </p>
                <p className="max-w-md text-[11px] leading-relaxed text-white/60">
                  {t("learn.coaching.locked.body")}
                </p>
                <Link
                  href={signedIn ? "/upgrade-pro" : "/sign-in"}
                  className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-[#f5ff3b] px-4 py-2 text-xs font-black text-[#04122b] transition hover:bg-yellow-300"
                >
                  {signedIn ? t("stats.locked.cta") : t("stats.locked.signin")}
                  <IconArrowRight size={13} aria-hidden="true" />
                </Link>
              </div>
            )}

            {pro && (
              <Link
                href="/learn/coaching"
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-extrabold text-[#00e5ff] underline-offset-4 hover:underline"
              >
                {t("learn.coaching.title")}
                <IconArrowRight size={13} aria-hidden="true" />
              </Link>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
