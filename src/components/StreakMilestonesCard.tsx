"use client";

// src/components/StreakMilestonesCard.tsx
//
// The streak progression card on /rewards.
//
// ── What this is ────────────────────────────────────────────────────────────
//
// A view over `GET /api/user/daily-streak`: the current streak, the best
// streak, the title the current streak has earned, the next milestone and the
// full threshold list with achieved / next / locked states. There is no reward
// to claim and no token amount anywhere on this surface.
//
// ── Why it is a progression system, not a daily login reward ────────────────
//
// The streak advances when a player FINISHES A GAME — the authoritative
// completion route credits the day through the shared streak writer — and
// never from opening the site. One credit per calendar day, so several games
// on the same day cannot double-count. Missing a day resets the current
// streak to 1; the best streak and every title already earned stay put.
//
// The milestone arithmetic lives in src/lib/streakTitles.js and is applied by
// the read endpoint, so this component renders numbers rather than deriving
// them.

import Link from "next/link";
import { IconCheck, IconRefresh } from "@tabler/icons-react";
import { useDailyStreak } from "../hooks/useDailyStreak";
import FlameMark from "./FlameMark";
import { StreakProgress } from "./streaks/StreakProgress";

const CARD =
  "rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] p-5 backdrop-blur-xs sm:p-6";

export default function StreakMilestonesCard() {
  const { isLoaded, isSignedIn, streak, loading, error, load } = useDailyStreak();

  const current = Math.max(0, Number(streak?.current) || 0);
  const best = Math.max(0, Number(streak?.best) || 0);
  const next = streak?.nextMilestone ?? null;

  return (
    <section
      aria-labelledby="streak-milestones-heading"
      data-testid="streak-milestones-card"
      className={CARD}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2
          id="streak-milestones-heading"
          className="flex items-center gap-2 text-xl font-bold text-[color:var(--text-primary)] sm:text-2xl"
        >
          <FlameMark size={26} /> Streak Milestones
        </h2>
        {streak && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-panel)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent-strong)]">
            {current}-day streak
          </span>
        )}
      </div>

      {!isLoaded ? (
        <p className="text-sm text-[color:var(--text-muted)]" aria-hidden="true">
          Loading your streak…
        </p>
      ) : !isSignedIn ? (
        <p className="text-sm text-[color:var(--text-secondary)]">
          <Link
            href="/sign-in"
            className="text-[color:var(--accent-strong)] underline underline-offset-2 hover:text-[color:var(--text-primary)]"
          >
            Sign in
          </Link>{" "}
          to start a streak: finish a game and day one is yours.
        </p>
      ) : loading && !streak ? (
        <p className="text-sm text-[color:var(--text-muted)]" aria-hidden="true">
          Loading your streak…
        </p>
      ) : !streak ? (
        <p className="text-sm text-[color:var(--text-secondary)]">
          Your streak isn&apos;t available right now.{" "}
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1 font-semibold text-[color:var(--accent-strong)] underline underline-offset-2 hover:text-[color:var(--text-primary)]"
          >
            <IconRefresh size={13} aria-hidden="true" /> Try again
          </button>
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                Current streak
              </p>
              <p className="mt-1 text-2xl font-black text-[color:var(--text-primary)]">
                {current}
                <span className="ml-1 align-middle text-xs font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                  {current === 1 ? "day" : "days"}
                </span>
              </p>
            </div>
            <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                Best streak
              </p>
              <p className="mt-1 text-2xl font-black text-[color:var(--text-primary)]">
                {best}
                <span className="ml-1 align-middle text-xs font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                  {best === 1 ? "day" : "days"}
                </span>
              </p>
            </div>
            <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                Current title
              </p>
              <p className="mt-1 text-lg font-bold text-[color:var(--accent-strong)]">
                {streak.title ?? "New streak"}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-4">
            {next ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                    Next milestone:{" "}
                    <span className="text-[color:var(--accent-strong)]">
                      {next.days} days — {next.title}
                    </span>
                  </p>
                  <p className="text-sm font-bold text-[color:var(--accent-strong)]">
                    {Math.min(current, next.days)}/{next.days} days
                  </p>
                </div>
                <StreakProgress
                  current={current}
                  target={next.days}
                  label={`Streak progress: ${Math.min(current, next.days)} of ${next.days} days to ${next.title}`}
                  className="mt-2"
                />
                <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
                  {streak.daysRemaining === 1
                    ? "1 more day to reach it."
                    : `${streak.daysRemaining} more days to reach it.`}
                  {streak.shieldAvailable && " A streak shield is ready to protect one missed day."}
                </p>
              </>
            ) : (
              <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                Every milestone reached — {current} days and counting. Best streak: {best} days.
              </p>
            )}
          </div>

          <h3 className="mt-6 text-[11px] font-black uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
            All milestones
          </h3>
          <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {streak.milestones.map((milestone) => (
              <li
                key={milestone.days}
                data-testid={`streak-milestone-${milestone.days}`}
                data-state={
                  milestone.achieved ? "achieved" : milestone.isNext ? "next" : "locked"
                }
                className={[
                  "rounded-lg border p-2.5",
                  milestone.achieved
                    ? "border-[color:var(--accent-strong)] bg-[color:var(--bg-panel)]"
                    : milestone.isNext
                      ? "border-[color:var(--accent)] bg-[color:var(--bg-panel)]"
                      : "border-[color:var(--border-hairline)]",
                ].join(" ")}
              >
                <p className="flex items-center justify-between gap-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                  Day {milestone.days}
                  {milestone.achieved && (
                    <IconCheck
                      size={12}
                      className="text-[color:var(--accent-strong)]"
                      aria-hidden="true"
                    />
                  )}
                </p>
                <p
                  className={[
                    "mt-0.5 text-sm font-semibold",
                    milestone.achieved || milestone.isNext
                      ? "text-[color:var(--text-primary)]"
                      : "text-[color:var(--text-muted)]",
                  ].join(" ")}
                >
                  {milestone.title}
                </p>
                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                  {milestone.achieved ? "Achieved" : milestone.isNext ? "Next" : "Locked"}
                </p>
              </li>
            ))}
          </ol>

          <p className="mt-4 text-xs leading-relaxed text-[color:var(--text-muted)]">
            Finish a game to advance one day. Several games on the same day count once, and
            missing a day starts the current streak again at day 1 — your best streak and
            earned titles stay.
          </p>
        </>
      )}

      {error && streak && (
        <p className="mt-3 text-sm text-[color:var(--text-secondary)]" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
