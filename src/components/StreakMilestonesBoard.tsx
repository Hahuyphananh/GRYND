"use client";

// src/components/StreakMilestonesBoard.tsx
//
// The daily-streak POPUP, opened by clicking the streak card on the home page.
//
// ── The old board, with milestones instead of payouts ───────────────────────
//
// This restores the shape players already know: the 14-day reward board's
// two-row grid of day tiles. The retired token reward is NOT back — every tile
// is a streak milestone (day + title + achieved / next / locked). There is no
// amount, no claim button and no request; the popup is a read-only view over
// the same server-derived milestone state the streak card uses.
//
// Fifteen thresholds exist. The first fourteen fill the familiar 4×/7× grid and
// the final 365-day "King" tile spans the last row, so the board keeps the
// 14-day silhouette while still showing the whole ladder.
//
// ── Portalled ───────────────────────────────────────────────────────────────
//
// The home widget is mounted inside framer-motion wrappers whose transforms
// become containing blocks for `position: fixed` descendants. Portalling to
// `document.body` keeps the overlay full-viewport and above the fixed navbar.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { IconCheck, IconLock, IconX } from "@tabler/icons-react";
import type { DailyStreakStatus, StreakMilestone } from "../hooks/useDailyStreak";
import FlameMark from "./FlameMark";
import { StreakProgress } from "./streaks/StreakProgress";

/** The tile grid itself, exported so the render contract can be tested. */
export function MilestoneGrid({ milestones }: { milestones: StreakMilestone[] }) {
  return (
    <ol
      data-testid="streak-milestones-grid"
      className="grid grid-cols-4 gap-1.5 sm:grid-cols-7 sm:gap-2"
    >
      {milestones.map((milestone, index) => {
        // The ladder has fifteen entries: fourteen fill the two familiar rows
        // and the 365-day finale spans the third.
        const isFinal = index === milestones.length - 1;
        const state = milestone.achieved
          ? "achieved"
          : milestone.isNext
            ? "next"
            : "locked";

        return (
          <li
            key={milestone.days}
            data-testid={`streak-board-day-${milestone.days}`}
            data-state={state}
            aria-current={milestone.isNext ? "step" : undefined}
            className={[
              "flex min-h-20 flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-2 text-center",
              isFinal ? "col-span-4 sm:col-span-7" : "",
              milestone.isNext
                ? "border-[color:var(--accent)] bg-[color:var(--bg-panel)]"
                : milestone.achieved
                  ? "border-[color:var(--accent-strong)] bg-[color:var(--bg-panel)]"
                  : "border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)]",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-[color:var(--text-muted)]">
              Day {milestone.days}
            </span>
            <span
              className={[
                "text-[11px] font-bold leading-tight sm:text-xs",
                milestone.achieved || milestone.isNext
                  ? "text-[color:var(--text-primary)]"
                  : "text-[color:var(--text-muted)]",
              ].join(" ")}
            >
              {milestone.title}
            </span>
            <span className="mt-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider">
              {milestone.achieved ? (
                <>
                  <IconCheck
                    size={12}
                    className="text-[color:var(--accent-strong)]"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Achieved</span>
                </>
              ) : milestone.isNext ? (
                <span className="text-[color:var(--accent-strong)]">Next</span>
              ) : (
                <>
                  <IconLock
                    size={11}
                    className="text-[color:var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Locked</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function StreakMilestonesBoard({
  open,
  onClose,
  streak,
}: {
  open: boolean;
  onClose: () => void;
  /** The same server-derived status the streak card renders. */
  streak: DailyStreakStatus | null;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Escape closes, the page behind stops scrolling, focus moves into the
  // board and returns to the streak card on close.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      const previous = previouslyFocused.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, onClose]);

  // `open` only becomes true from a click, so the browser is guaranteed here.
  if (!open) return null;
  if (typeof document === "undefined") return null;
  if (!streak) return null;

  const current = Math.max(0, Number(streak.current) || 0);
  const best = Math.max(0, Number(streak.best) || 0);
  const next = streak.nextMilestone;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-xs sm:p-6"
      data-testid="streak-milestones-board-overlay"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="streak-milestones-board-heading"
        tabIndex={-1}
        data-testid="streak-milestones-board-dialog"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] p-4 shadow-2xl outline-hidden sm:p-6"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <FlameMark size={32} />
            <div>
              <h2
                id="streak-milestones-board-heading"
                className="text-lg font-bold text-[color:var(--accent-strong)] sm:text-xl"
              >
                Streak Milestones
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-secondary)] sm:text-sm">
                Finish a game each day to climb. Every tile is a streak milestone — the
                streak only advances when a game is completed.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close streak milestones"
            data-testid="streak-milestones-board-close"
            className="shrink-0 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg-panel)] p-2 text-[color:var(--text-primary)] transition hover:bg-[color:var(--bg-surface)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)]"
          >
            <IconX size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-panel)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent-strong)]">
            {current}-day streak
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
            Best {best} {best === 1 ? "day" : "days"}
          </span>
          {streak.title && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] px-3 py-1 text-[11px] font-semibold text-[color:var(--text-primary)]">
              {streak.title}
            </span>
          )}
        </div>

        <MilestoneGrid milestones={streak.milestones} />

        <div className="mt-4 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-4">
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
                  {Math.min(current, next.days)}/{next.days}
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
                {streak.shieldAvailable &&
                  " A streak shield is ready to protect one missed day."}
              </p>
            </>
          ) : (
            <p className="text-sm font-semibold text-[color:var(--text-primary)]">
              Every milestone reached — {current} days and counting.
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs leading-relaxed text-[color:var(--text-muted)]">
            One day is credited per calendar day you finish a game. Several games on the
            same day count once; a missed day starts the current streak again.
          </p>
          <Link
            href="/rewards"
            onClick={onClose}
            className="text-xs font-semibold text-[color:var(--accent-strong)] underline underline-offset-2 hover:text-[color:var(--text-primary)]"
          >
            Full milestone page
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}
