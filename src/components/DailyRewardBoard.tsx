"use client";

// src/components/DailyRewardBoard.tsx
//
// The daily-streak POPUP — the 14 rewards of the player's CURRENT window,
// opened from the streak card (components/DailyRewardWidget) and from the
// /rewards card (components/DailyRewardCard).
//
// ── Absolute days, not cycle days ───────────────────────────────────────────
//
// The board shows the window the server sends (`status.window`): absolute
// streak days and what each pays. A player on day 16 sees days 15–28 with
// today at 16 — the curve's index wraps every 14 days, but the day NUMBER does
// not, so the popup never looks like the streak reset on day 15.
//
// ── Presentational, deliberately ────────────────────────────────────────────
//
// It never fetches and never computes an amount. It renders the
// `useDailyReward()` result it is handed — the server owns the curve, the
// streak, the gate and the idempotency, so there is exactly one claim path in
// the app.
//
// ── Empty window, no popup ──────────────────────────────────────────────────
//
// If the server sends no window (or only zero-value days) there is nothing to
// show, so the component renders nothing at all rather than an empty modal.
//
// ── Why it is portalled ─────────────────────────────────────────────────────
//
// Both hosts mount it inside framer-motion wrappers (the /rewards card sits in
// a `motion.div` whose entrance animates a transform). A transformed ancestor
// becomes the containing block for `position: fixed` descendants AND opens a
// new stacking context, so an overlay rendered in place would be sized to that
// wrapper and could be painted under the fixed navbar. Portalling to
// `document.body` puts the board at the top of the document where `fixed
// inset-0` and `z-[100]` mean what they say.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { IconCheck, IconCoins, IconLock, IconRefresh, IconX } from "@tabler/icons-react";
import type { DailyRewardStatus, UseDailyReward } from "../hooks/useDailyReward";
import { useTranslation } from "../hooks/useTranslation";
import GlitchSay from "./mascot/GlitchSay";
import FlameMark from "./FlameMark";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The shared reward state, owned by the surface that opened the board. */
  reward: UseDailyReward;
};

type WindowDay = DailyRewardStatus["window"][number];

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** One day of the window. Purely presentational. */
function DayTile({
  day,
  amount,
  isToday,
  isCollected,
}: {
  day: number;
  amount: number;
  isToday: boolean;
  isCollected: boolean;
}) {
  return (
    <li
      data-testid={`daily-reward-day-${day}`}
      data-state={isCollected ? "collected" : isToday ? "today" : "upcoming"}
      aria-current={isToday ? "step" : undefined}
      className={[
        "relative flex flex-col items-center gap-0.5 rounded-lg border px-1 py-2 text-center",
        isToday && !isCollected
          ? "border-[#f5ff3b] bg-[#f5ff3b]/15 text-[#f5ff3b] shadow-[0_0_18px_rgba(245,255,59,0.25)]"
          : isCollected
            ? "border-[#00e5ff]/25 bg-[#00e5ff]/5 text-[#9dd8ff]/60"
            : "border-[#00e5ff]/15 bg-surface/60 text-[#9dd8ff]/80",
      ].join(" ")}
    >
      <span className="text-[9px] font-semibold uppercase tracking-wider opacity-80">
        Day {day}
      </span>
      <span className="flex items-center gap-0.5 text-xs font-bold sm:text-sm">
        {isCollected ? (
          <IconCheck size={14} aria-hidden="true" />
        ) : (
          <>
            <IconCoins size={11} className="shrink-0 opacity-70" aria-hidden="true" />
            {formatCoins(amount)}
          </>
        )}
      </span>
      {isCollected && <span className="sr-only">Collected</span>}
    </li>
  );
}

/** The window's days, in order, with the absolute current day highlighted. */
function Board({ status, rewards }: { status: DailyRewardStatus; rewards: WindowDay[] }) {
  const currentDay = Math.max(1, Number(status.streakDay) || 1);

  return (
    <ol
      role="list"
      data-testid="daily-reward-board"
      className="grid grid-cols-4 gap-1.5 sm:grid-cols-7 sm:gap-2"
    >
      {rewards.map(({ day, amount }) => {
        const isToday = day === currentDay;
        // Days already behind us in this window are collected; today counts as
        // collected the moment the claim lands.
        const isCollected = day < currentDay || (isToday && !status.claimable);
        return (
          <DayTile
            key={day}
            day={day}
            amount={amount}
            isToday={isToday}
            isCollected={isCollected}
          />
        );
      })}
    </ol>
  );
}

export default function DailyRewardBoard({ open, onClose, reward }: Props) {
  const { t } = useTranslation();
  const { status, claiming, claimedNow, error, load, claim } = reward;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Escape closes, the page behind stops scrolling, focus moves into the board
  // and returns to whatever opened it. All three are restored on close.
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

  // `open` only ever becomes true from a click, so the browser is guaranteed
  // here — no mount flag is needed, and a server render never reaches the
  // portal (the state starts closed).
  if (!open) return null;
  if (typeof document === "undefined") return null;

  // Only days that actually pay are shown. Nothing payable means no popup:
  // an empty modal would just be a dead end.
  const rewards = (status?.window ?? []).filter((entry) => Number(entry?.amount) > 0);
  if (!status || rewards.length === 0) return null;

  const currentDay = Math.max(1, Number(status.streakDay) || 1);
  // The server owns the window bounds; the tile list is only the fallback.
  const windowStart = Number(status.windowStart) || rewards[0].day;
  const windowEnd = Number(status.windowEnd) || rewards[rewards.length - 1].day;

  // Says what the player has banked so far (streak and window) — the numbers
  // are the server's own status fields, inline in the flow, so it cannot cover
  // a tile or the claim button.
  const dailyGlitchLine = t("rewards.glitch.dailySummary", {
    day: currentDay,
    days: rewards.length,
    streak: status.streakDay,
    remaining: Math.max(0, windowEnd - currentDay),
  });

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-xs sm:p-6"
      data-testid="daily-reward-board-overlay"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-reward-board-heading"
        tabIndex={-1}
        data-testid="daily-reward-board-dialog"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#f5ff3b]/40 bg-surface p-4 shadow-[0_0_40px_rgba(245,255,59,0.25)] outline-hidden sm:p-6"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <FlameMark size={32} />
            <div>
              <h2
                id="daily-reward-board-heading"
                className="text-lg font-bold text-[#f5ff3b] sm:text-xl"
              >
                Daily Streak
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[#c9f7ff]/75 sm:text-sm">
                Log in and win one match each day — online or vs the AI. Each day of the
                14-day window pays more than the one before; miss a day and the streak
                starts again at day 1.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close daily streak"
            data-testid="daily-reward-board-close"
            className="shrink-0 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 p-2 text-[#d8fbff] transition hover:bg-[#00e5ff]/25 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
          >
            <IconX size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#00e5ff]">
            {formatCoins(status.streakDay)}-day streak
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#f5ff3b]">
            Days {windowStart}–{windowEnd}
          </span>
        </div>

        <div className="mb-4" data-testid="daily-reward-glitch">
          <GlitchSay
            expression="wink"
            message={dailyGlitchLine}
            placement="inline"
            size="sm"
            dismissible
            dismissLabel="Close"
          />
        </div>

        <Board status={status} rewards={rewards} />

        <div className="mt-5">
          {claimedNow !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <p
                className="flex items-center gap-2 text-sm font-semibold text-[#f5ff3b]"
                role="status"
                data-testid="daily-reward-claimed"
              >
                <IconCheck size={16} aria-hidden="true" /> You claimed {formatCoins(claimedNow)}{" "}
                coins. Day {currentDay + 1} is next.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-4 py-2 text-sm font-semibold text-[#d8fbff] transition hover:bg-[#00e5ff]/25"
              >
                Nice!
              </button>
            </div>
          ) : !status.winGateSatisfied ? (
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 px-3 py-2 text-sm font-semibold text-[#ff4fd8]"
                data-testid="daily-reward-locked"
              >
                <IconLock size={15} aria-hidden="true" /> Win a match to unlock today&apos;s reward
              </span>
              <Link
                href="/games"
                className="text-sm font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
              >
                Choose a game
              </Link>
            </div>
          ) : status.claimable ? (
            <button
              type="button"
              onClick={claim}
              disabled={claiming}
              data-testid="daily-reward-claim"
              className="inline-flex w-full items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-linear-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-3 text-base font-bold text-[#1f1700] shadow-[0_0_25px_rgba(245,255,59,0.35)] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:opacity-60 sm:w-auto"
            >
              {claiming
                ? "Claiming…"
                : `Claim day ${currentDay} — ${formatCoins(status.reward)} coins`}
            </button>
          ) : (
            <p
              className="flex items-center gap-2 text-sm text-[#c9f7ff]/80"
              data-testid="daily-reward-claimed"
            >
              <IconCheck size={15} aria-hidden="true" /> Already claimed today — tomorrow&apos;s
              reward is waiting.
            </p>
          )}

          {error && (
            <p className="mt-3 text-sm text-[#ff4fd8]" role="alert">
              {error}{" "}
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
              >
                <IconRefresh size={13} aria-hidden="true" /> Try again
              </button>
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
