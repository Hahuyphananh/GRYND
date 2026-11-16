"use client";

// src/components/DailyRewardWidget.tsx
//
// The daily STREAK card: a flame, the streak number, and — on click — the
// 14-day reward popup (components/DailyRewardBoard).
//
// ── What it shows ───────────────────────────────────────────────────────────
//
// The number is the player's streak day (`status.streakDay`), not the day of
// the repeating curve: a player on day 16 sees 16, and the popup beside it
// shows days 15–28. The card itself only says what today is worth; the popup
// is where the whole window and the claim live.
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
// ── One claim path ──────────────────────────────────────────────────────────
//
// The card never claims and never fetches: it opens the shared board, which is
// the ONLY surface with a claim button and drives the shared `useDailyReward`
// hook. A signed-out visitor gets nothing — there is no streak without a
// player.
//
// ── No rewards, no popup ────────────────────────────────────────────────────
//
// The window comes from the server (`status.window`, absolute days + amounts).
// If it is empty — or every amount is zero — the opener is not rendered at all,
// so the popup can never open onto an empty board.

import { useState } from "react";
import Link from "next/link";
import { IconCheck, IconLock, IconRefresh } from "@tabler/icons-react";
import { useDailyReward } from "../hooks/useDailyReward";
import DailyRewardBoard from "./DailyRewardBoard";
import FlameMark from "./FlameMark";

// Inline under the navbar on small screens; pinned to the top-right corner on
// `md:` and up. The horizontal padding only applies while inline (the pages
// that mount it have no padding of their own at that point).
const POSITION_CLASS = [
  "mt-3 px-4 md:mt-0 md:px-0",
  "md:fixed md:right-4 md:top-[calc(var(--safe-top,0px)_+_112px)] md:z-30 md:w-[20rem] md:max-w-[calc(100vw-2rem)]",
].join(" ");

const CARD =
  "rounded-2xl border border-[#f5ff3b]/40 bg-[#040d24]/95 p-4 shadow-[0_0_28px_rgba(245,255,59,0.2)] backdrop-blur-md";

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function DailyRewardWidget() {
  const reward = useDailyReward();
  const { isLoaded, isSignedIn, status, loading, claimedNow, error, load } = reward;
  const [open, setOpen] = useState(false);

  // No session yet (or no session at all) — nothing to show and nothing to
  // flash, so the corner stays empty.
  if (!isLoaded || !isSignedIn) return null;

  // Absolute day numbers, straight from the server: 1–14 on the first
  // fortnight, 15–28 after it, then 29–42, ...
  const windowDays = Array.isArray(status?.window) ? status.window : [];
  const rewards = windowDays.filter((entry) => Number(entry?.amount) > 0);
  const hasRewards = rewards.length > 0;
  const streak = status ? Math.max(1, Number(status.streakDay) || 1) : null;

  return (
    <div className={POSITION_CLASS} data-testid="daily-reward-widget">
      <section aria-labelledby="daily-streak-heading" className={CARD}>
        <div className="flex items-start gap-3">
          <FlameMark />
          <div className="min-w-0 flex-1">
            <h2
              id="daily-streak-heading"
              className="text-[11px] font-black uppercase tracking-[0.22em] text-[#f5ff3b]"
            >
              Daily Streak
            </h2>
            <div className="mt-1 flex items-end gap-2">
              <span
                data-testid="daily-streak-count"
                className="text-4xl font-black leading-none tracking-tight text-white"
              >
                {streak === null ? "—" : formatCoins(streak)}
              </span>
              <span className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9dd8ff]/70">
                {streak === 1 ? "day" : "days"}
              </span>
            </div>
          </div>
          {status && (
            <span className="shrink-0 rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff]">
              Days {status.windowStart}–{status.windowEnd}
            </span>
          )}
        </div>

        <div className="mt-3">
          {loading && !status ? (
            <p className="text-xs text-[#9dd8ff]/70" aria-hidden="true">
              Loading your streak…
            </p>
          ) : !status ? (
            <p className="text-xs text-[#c9f7ff]/80">
              Your daily reward isn&apos;t available right now.
              <button
                type="button"
                onClick={load}
                className="ml-1 inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
              >
                <IconRefresh size={12} aria-hidden="true" /> Try again
              </button>
            </p>
          ) : claimedNow !== null ? (
            <p
              className="flex items-center gap-1.5 text-xs font-semibold text-[#f5ff3b]"
              role="status"
            >
              <IconCheck size={14} aria-hidden="true" /> Claimed {formatCoins(claimedNow)} coins
            </p>
          ) : !status.winGateSatisfied ? (
            <div className="space-y-1.5">
              <p className="flex items-start gap-1.5 text-xs font-semibold text-[#ff4fd8]">
                <IconLock size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                Win a match to unlock today&apos;s reward
              </p>
              <Link
                href="/games"
                className="inline-block text-xs font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
              >
                Choose a game
              </Link>
            </div>
          ) : status.claimable ? (
            <p className="text-xs font-semibold text-[#f5ff3b]">
              {formatCoins(status.reward)} coins ready today
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#9dd8ff]">
              <IconCheck size={13} aria-hidden="true" /> Claimed today — back tomorrow
            </p>
          )}

          {status && error && (
            <p className="mt-2 text-xs text-[#ff4fd8]" role="alert">
              {error}
            </p>
          )}
        </div>

        {hasRewards && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            data-testid="daily-reward-widget-open"
            aria-label="Open the 14-day reward list"
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#f5ff3b]/60 bg-linear-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-3 py-2 text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.3)] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
          >
            View 14-day rewards
          </button>
        )}
      </section>

      <DailyRewardBoard open={open} onClose={() => setOpen(false)} reward={reward} />
    </div>
  );
}
