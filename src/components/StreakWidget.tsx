"use client";

// src/components/StreakWidget.tsx
//
// The daily STREAK card: a flame, the current streak, its title, and how far
// the player is from the next milestone.
//
// ── The milestone popup ─────────────────────────────────────────────────────
//
// Clicking the streak opens the milestone board (StreakMilestonesBoard): the
// familiar 14-day popup grid, now filled only with streak milestones. The card
// still shows the essentials inline and the board is a read-only view of the
// same server-derived state — nothing is claimed or unlocked from it.
//
// ── What it shows ───────────────────────────────────────────────────────────
//
// Current streak, best streak, the current title, the next milestone and the
// remaining days, plus a compact rail of every milestone. All of it comes from
// `GET /api/user/daily-streak`, which derives the title and milestone state
// from the shared `streakTitles` utility — the client never recalculates a
// threshold.
//
// ── Placement ───────────────────────────────────────────────────────────────
//
// `md:` and up: fixed at the viewport's top-right, UNDER the navbar. The bar is
// h-16 / h-20 / h-24 (96px at its tallest) and pads itself with `--safe-top` on
// Android edge-to-edge and iOS standalone, so the offset is
// `--safe-top + 112px`: the bar plus a 16px gap. It stays below the navbar in
// the stacking order (z-30 vs z-40) and below the mobile menu (z-50) and modals
// (z-100). Below `md:` a fixed card would cover the page it is meant to help, so
// the same element lays out inline at the top of the content, under the bar.
//
// ── Compact on a phone, closeable ───────────────────────────────────────────
//
// Inline on a phone this card is the first thing above the hero, so it stays a
// small strip there: tighter padding, a smaller streak number and a single
// progress line. From `md:` up the fuller card is used.
//
// The close control mirrors the floating GRYND PRO card: it hides the card for
// the rest of the browsing session (lib/streakWidget), so a player who wants the
// page can play without it, and a fresh visit starts with the streak back.

import { useEffect, useState } from "react";
import { IconCheck, IconRefresh } from "@tabler/icons-react";
import { useDailyStreak } from "../hooks/useDailyStreak";
import FlameMark from "./FlameMark";
import StreakMilestonesBoard from "./StreakMilestonesBoard";
import { MilestoneRail } from "./streaks/MilestoneRail";
import { StreakProgress } from "./streaks/StreakProgress";
import {
  dismissStreakWidget,
  isStreakWidgetDismissed,
} from "../lib/streakWidget";

// Inline under the navbar on small screens; pinned to the top-right corner on
// `md:` and up. The horizontal padding only applies while inline (the pages
// that mount it have no padding of their own at that point).
const POSITION_CLASS = [
  "mt-3 px-4 md:mt-0 md:px-0",
  "md:fixed md:right-4 md:top-[calc(var(--safe-top,0px)_+_112px)] md:z-30 md:w-[20rem] md:max-w-[calc(100vw-2rem)]",
].join(" ");

const CARD =
  "relative rounded-2xl border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] p-3 shadow-xl backdrop-blur-md md:p-4";

export default function StreakWidget() {
  const { isLoaded, isSignedIn, streak, loading, error, load } = useDailyStreak();
  const [dismissed, setDismissed] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  // sessionStorage is read after mount: rendering it during the server pass
  // would mean a card that has been closed flashes back on every navigation.
  useEffect(() => {
    setDismissed(isStreakWidgetDismissed());
  }, []);

  const close = () => {
    dismissStreakWidget();
    setDismissed(true);
  };

  // No session yet (or no session at all) — nothing to show and nothing to
  // flash, so the corner stays empty.
  if (!isLoaded || !isSignedIn) return null;

  // Closed for this browsing session: not there at all.
  if (dismissed) return null;

  const current = Math.max(0, Number(streak?.current) || 0);
  const best = Math.max(0, Number(streak?.best) || 0);
  const next = streak?.nextMilestone ?? null;

  return (
    <div className={POSITION_CLASS} data-testid="streak-widget">
      <section aria-labelledby="daily-streak-heading" className={CARD}>
        <button
          type="button"
          onClick={close}
          aria-label="Dismiss the daily streak card"
          data-testid="streak-widget-dismiss"
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none text-[color:var(--text-muted)] transition hover:bg-[color:var(--bg-panel)] hover:text-[color:var(--text-primary)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
        >
          ×
        </button>

        <button
          type="button"
          onClick={() => setBoardOpen(true)}
          aria-haspopup="dialog"
          data-testid="streak-widget-open"
          className="flex w-full items-start gap-3 rounded-lg pr-7 text-left transition hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
        >
          <FlameMark size={36} />
          <span className="block min-w-0 flex-1">
            <span
              id="daily-streak-heading"
              className="block text-[11px] font-black uppercase tracking-[0.22em] text-[color:var(--accent-strong)]"
            >
              Daily Streak
            </span>
            <span className="mt-1 flex items-end gap-2">
              <span
                data-testid="daily-streak-count"
                className="text-2xl font-black leading-none tracking-tight text-[color:var(--text-primary)] md:text-4xl"
              >
                {current}
              </span>
              <span className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                {current === 1 ? "day" : "days"}
              </span>
            </span>
          </span>
        </button>

        <div className="mt-2 md:mt-3">
          {loading && !streak ? (
            <p className="text-xs text-[color:var(--text-muted)]" aria-hidden="true">
              Loading your streak…
            </p>
          ) : !streak ? (
            <p className="text-xs text-[color:var(--text-secondary)]">
              Your streak isn&apos;t available right now.
              <button
                type="button"
                onClick={load}
                className="ml-1 inline-flex items-center gap-1 font-semibold text-[color:var(--accent-strong)] underline underline-offset-2 hover:text-[color:var(--text-primary)]"
              >
                <IconRefresh size={12} aria-hidden="true" /> Try again
              </button>
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs">
                <p
                  data-testid="streak-widget-title"
                  className="font-bold text-[color:var(--text-primary)]"
                >
                  {streak.title ?? "New streak"}
                </p>
                <p
                  data-testid="streak-widget-best"
                  className="text-[color:var(--text-muted)]"
                >
                  Best {best} {best === 1 ? "day" : "days"}
                </p>
              </div>

              <MilestoneRail milestones={streak.milestones} className="mt-2" />

              <div className="mt-2 flex items-baseline justify-between gap-2 text-xs">
                <p className="min-w-0 text-[color:var(--text-secondary)]">
                  {next ? (
                    <>
                      Next:{" "}
                      <span className="font-semibold text-[color:var(--text-primary)]">
                        {next.days} days — {next.title}
                      </span>
                    </>
                  ) : (
                    <span className="font-semibold text-[color:var(--text-primary)]">
                      Every milestone reached
                    </span>
                  )}
                </p>
                <p className="shrink-0 font-bold text-[color:var(--accent-strong)]">
                  {next ? `${Math.min(current, next.days)}/${next.days}` : `${current}/${current}`}
                </p>
              </div>

              <StreakProgress
                current={current}
                target={next?.days ?? Math.max(1, current)}
                label={
                  next
                    ? `Streak progress: ${Math.min(current, next.days)} of ${next.days} days to ${next.title}`
                    : "Every streak milestone reached"
                }
                className="mt-1.5"
              />

              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <p className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                  {next ? (
                    <>
                      <span>
                        {streak.daysRemaining === 1
                          ? "1 day to go"
                          : `${streak.daysRemaining} days to go`}
                      </span>
                      {streak.shieldAvailable && (
                        <span className="inline-flex items-center gap-1 font-semibold text-[color:var(--accent-strong)]">
                          <IconCheck size={11} aria-hidden="true" /> Shield ready
                        </span>
                      )}
                    </>
                  ) : (
                    <span>Best streak: {best} days</span>
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => setBoardOpen(true)}
                  className="text-[11px] font-semibold text-[color:var(--accent-strong)] underline underline-offset-2 hover:text-[color:var(--text-primary)]"
                >
                  View milestones
                </button>
              </div>
            </>
          )}

          {streak && error && (
            <p className="mt-2 text-xs text-[color:var(--text-secondary)]" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>

      <StreakMilestonesBoard
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        streak={streak}
      />
    </div>
  );
}
