"use client";

// src/components/DailyRewardWidget.tsx
//
// The daily login reward as a compact corner widget — the same reward the
// /rewards card shows, in the top-right of the page, under the navbar.
//
// ── Why a second surface ────────────────────────────────────────────────────
//
// The reward is gated on winning a match today, online or vs the AI (see
// lib/tokens/dailyReward.ts), so the one place it must be visible is where a
// player decides what to play next: the home page and the games hub. /rewards
// remains the full explanation; this widget is the actionable summary, and it
// points at /games when the gate is what stands in the way.
//
// ── One source of truth ─────────────────────────────────────────────────────
//
// The status read, the claim and the 14-day board all come from
// `useDailyReward` + `DailyRewardBoard`, shared with DailyRewardCard, so neither
// surface can invent an amount or credit anything itself — the server owns the
// curve, the gate and the idempotency. A claim here credits the balance the
// navbar shows, which is why the hook fires the shared coin-balance event.
//
// ── Placement ───────────────────────────────────────────────────────────────
//
// `md:` and up: fixed to the viewport's top-right, below the navbar (which is
// fixed at h-16 / h-20 / h-24, so top-104px clears the tallest of the three),
// stacked BELOW the navbar (z-30 vs its z-40) and below the mobile menu (z-50)
// and the modals (z-100). Below `md:` the fixed card would cover the page it is
// meant to help, so the same element lays out inline at the top of the page
// content instead — under the navbar, right where the reading starts.
//
// A signed-out visitor gets nothing: there is no reward without a player, and a
// permanent "sign in" pitch in the corner of every page is noise. (The navbar
// already owns the signed-out call to action.)

import { useState } from "react";
import Link from "next/link";
import { IconCheck, IconGift, IconLock, IconRefresh } from "@tabler/icons-react";
import { useDailyReward } from "../hooks/useDailyReward";
import DailyRewardBoard from "./DailyRewardBoard";

// Inline under the navbar on small screens; pinned to the top-right corner on
// `md:` and up. The horizontal padding only applies while the widget is inline
// (the pages that mount it have no padding of their own at that point).
const POSITION_CLASS = [
  "mt-3 px-4 md:mt-0 md:px-0",
  "md:fixed md:right-4 md:top-[104px] md:z-30 md:w-72 md:max-w-[calc(100vw-2rem)]",
].join(" ");

const CARD =
  "rounded-xl border border-[#f5ff3b]/40 bg-[#040d24]/90 px-4 py-3 shadow-[0_0_25px_rgba(245,255,59,0.18)] backdrop-blur-md";

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

  return (
    <div className={POSITION_CLASS} data-testid="daily-reward-widget">
      <section aria-labelledby="daily-reward-widget-heading" className={CARD}>
        <div className="flex items-center justify-between gap-2">
          <h2
            id="daily-reward-widget-heading"
            className="flex items-center gap-1.5 text-sm font-bold text-[#f5ff3b]"
          >
            <IconGift size={16} aria-hidden="true" /> Daily Reward
          </h2>
          {status && (
            <span className="rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#00e5ff]">
              Day {status.cycleDay}/{status.cycleDays}
            </span>
          )}
        </div>

        {loading && !status ? (
          <p className="mt-2 text-xs text-[#9dd8ff]/70" aria-hidden="true">
            Loading your reward…
          </p>
        ) : !status ? (
          <p className="mt-2 text-xs text-[#c9f7ff]/80">
            Your daily reward isn&apos;t available right now.
            <button
              type="button"
              onClick={load}
              className="ml-1 inline-flex items-center gap-1 font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
            >
              <IconRefresh size={12} aria-hidden="true" /> Try again
            </button>
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {claimedNow !== null ? (
              <p
                className="flex items-center gap-1.5 text-xs font-semibold text-[#f5ff3b]"
                role="status"
              >
                <IconCheck size={14} aria-hidden="true" /> Claimed {formatCoins(claimedNow)} coins —
                back tomorrow.
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
            ) : status.claimable && status.walletFull ? (
              // The server would refuse this claim — the wallet is at its
              // ceiling. Show the reason here rather than a Claim button whose
              // only outcome is a refusal.
              <div className="space-y-1.5">
                <p
                  className="flex items-start gap-1.5 text-xs font-semibold text-[#ff4fd8]"
                  data-testid="daily-reward-widget-wallet-full"
                >
                  <IconLock size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                  Wallet full ({formatCoins(status.walletCap)} coin limit) — spend some coins to
                  claim {formatCoins(status.reward)}.
                </p>
                <Link
                  href="/games"
                  className="inline-block text-xs font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
                >
                  Play a game
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  data-testid="daily-reward-widget-open"
                  className="flex w-full items-center gap-1.5 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-3 py-2 text-xs font-semibold text-[#c9f7ff] transition hover:bg-[#00e5ff]/20"
                >
                  <IconGift size={13} aria-hidden="true" /> See the board
                </button>
              </div>
            ) : status.claimable ? (
              <button
                type="button"
                onClick={() => setOpen(true)}
                data-testid="daily-reward-widget-open"
                className="w-full rounded-lg border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-3 py-2 text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.3)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
              >
                Claim day {status.cycleDay} — {formatCoins(status.reward)} coins
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setOpen(true)}
                data-testid="daily-reward-widget-open"
                className="flex w-full items-center gap-1.5 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-3 py-2 text-xs font-semibold text-[#c9f7ff] transition hover:bg-[#00e5ff]/20"
              >
                <IconCheck size={13} aria-hidden="true" /> Claimed today — see the board
              </button>
            )}

            {error && (
              <p className="text-xs text-[#ff4fd8]" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </section>

      <DailyRewardBoard open={open} onClose={() => setOpen(false)} reward={reward} />
    </div>
  );
}
