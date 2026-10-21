"use client";

// src/components/DailyRewardCard.tsx
//
// The Daily Reward card on /rewards — the summary that OPENS the 14-day board
// (components/DailyRewardBoard).
//
// ── What this is, and what it is not ────────────────────────────────────────
//
// A thin, honest view over `/api/rewards/daily`. The server owns the whole
// reward: the curated 14-day curve, whether today has been claimed, and whether
// the player has won a match today, online or vs the AI (the gate that unlocks the
// claim). This component never computes an amount and never credits anything; it
// renders the
// status the server reports and opens the board, which asks the server to claim.
//
// ── Why the board is behind a click ─────────────────────────────────────────
//
// The board is where the decision is made — it shows all 14 days, today's
// highlighted, and what the fortnight pays. The card is the doorway: streak,
// today's worth, and one button. Keeping the tiles in one place (the board)
// means the card can be short without hiding the curve.
//
// The three states a player can be in, in the order they meet them:
//
//   * `winGateSatisfied === false` — locked. The reward requires one win
//     today; the card says so and links to the games, which is the only
//     action that unlocks it.
//   * `claimable` — the button, which opens the board.
//   * neither — claimed today; the card says come back tomorrow.
//
// The status/claim plumbing lives in `useDailyReward`, shared with the compact
// corner widget on the home and games pages, so both surfaces ask the server in
// exactly the same way.

import { useState } from "react";
import Link from "next/link";
import { IconCheck, IconGift, IconLock, IconRefresh } from "@tabler/icons-react";
import { useDailyReward } from "../hooks/useDailyReward";
import DailyRewardBoard from "./DailyRewardBoard";

const CARD = "rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-5 backdrop-blur-sm sm:p-6";

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function DailyRewardCard() {
  const reward = useDailyReward();
  const { isLoaded, isSignedIn, status, loading, claimedNow, error, load } = reward;
  const [open, setOpen] = useState(false);

  return (
    <section aria-labelledby="daily-reward-heading" className={CARD}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2
          id="daily-reward-heading"
          className="flex items-center gap-2 text-xl font-bold text-[#f5ff3b] sm:text-2xl"
        >
          <IconGift size={20} aria-hidden="true" /> Daily Reward
        </h2>
        {status && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#00e5ff]">
            {formatCoins(status.streakDay)}-day streak
          </span>
        )}
        {status && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#f5ff3b]">
            Day {status.cycleDay} of {status.cycleDays}
          </span>
        )}
      </div>

      {!isLoaded ? (
        <p className="text-sm text-[#9dd8ff]/70" aria-hidden="true">
          Loading your reward…
        </p>
      ) : !isSignedIn ? (
        <p className="text-sm text-[#c9f7ff]/80">
          <Link
            href="/sign-in"
            className="text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
          >
            Sign in
          </Link>{" "}
          to collect a coin reward every day you play.
        </p>
      ) : loading && !status ? (
        <p className="text-sm text-[#9dd8ff]/70" aria-hidden="true">
          Loading your reward…
        </p>
      ) : !status ? (
        <p className="text-sm text-[#c9f7ff]/80">
          Your daily reward isn&apos;t available right now.
        </p>
      ) : (
        <>
          <p className="mb-4 max-w-3xl text-sm leading-relaxed text-[#c9f7ff]/80">
            Win one match each day — online or vs the AI — and today&apos;s coins are yours. The board climbs for
            14 days, and missing a day starts the streak over at day 1.
          </p>

          {claimedNow !== null ? (
            <p
              className="flex items-center gap-2 text-sm font-semibold text-[#f5ff3b]"
              role="status"
              data-testid="daily-reward-claimed"
            >
              <IconCheck size={16} aria-hidden="true" /> You claimed {formatCoins(claimedNow)}{" "}
              coins. Come back tomorrow for more.
            </p>
          ) : !status.winGateSatisfied ? (
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 px-3 py-2 text-sm font-semibold text-[#ff4fd8]"
                data-testid="daily-reward-locked"
              >
                <IconLock size={15} aria-hidden="true" /> Win a match to unlock today&apos;s
                reward
              </span>
              <Link
                href="/games"
                className="text-sm font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
              >
                Choose a game
              </Link>
              <button
                type="button"
                onClick={() => setOpen(true)}
                data-testid="daily-reward-open"
                className="text-sm font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
              >
                See the 14-day board
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setOpen(true)}
                data-testid="daily-reward-open"
                className="inline-flex items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-3 text-base font-bold text-[#1f1700] shadow-[0_0_25px_rgba(245,255,59,0.35)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817]"
              >
                {status.claimable
                  ? `Daily reward — day ${status.cycleDay} (${formatCoins(status.reward)} coins)`
                  : "Already claimed — see the board"}
              </button>
            </div>
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
        </>
      )}

      <DailyRewardBoard open={open} onClose={() => setOpen(false)} reward={reward} />
    </section>
  );
}
