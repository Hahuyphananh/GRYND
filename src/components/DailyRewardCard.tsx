"use client";

import Link from "next/link";
import {
  IconCheck,
  IconGift,
  IconLock,
  IconRefresh,
} from "@tabler/icons-react";
import { useDailyReward } from "../hooks/useDailyReward";

/**
 * The Daily Reward card.
 *
 * A thin, honest view over `/api/rewards/daily` — the server owns the whole
 * reward: the curated 7-day curve, whether today has been claimed, and whether
 * the player has played a game today (the gate that unlocks the claim). This
 * component never computes an amount and never credits anything itself; it
 * renders the status the server reports and asks the server to claim.
 *
 * The three states a player can be in, in the order they meet them:
 *
 *   * `playGateSatisfied === false` — locked. The reward requires one game
 *     today (1v1 PvP or vs AI); the card says so and links to the games, which
 *     is the only action that unlocks it.
 *   * `claimable` — the button. It claims for today and reports the payout.
 *   * neither — claimed today; the card says come back tomorrow.
 *
 * Copy is plain English, matching the rest of the /rewards surface.
 *
 * The status/claim plumbing lives in `useDailyReward`, shared with the compact
 * corner widget on the home and games pages, so both surfaces ask the server in
 * exactly the same way.
 */

const CARD =
  "rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-5 backdrop-blur-sm sm:p-6";

function formatCoins(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A 7-chip strip of the cycle, with today highlighted and past days ticked. */
function CycleStrip({
  cycle,
  cycleDay,
}: {
  cycle: number[];
  cycleDay: number;
}) {
  return (
    <ol role="list" className="grid grid-cols-7 gap-1.5 sm:gap-2">
      {cycle.map((amount, index) => {
        const day = index + 1;
        const isToday = day === cycleDay;
        const isPast = day < cycleDay;
        return (
          <li key={day} className="flex flex-col items-center gap-1">
            <span
              className={[
                "flex w-full flex-col items-center rounded-lg border px-1 py-2 text-center",
                isToday
                  ? "border-[#f5ff3b] bg-[#f5ff3b]/15 text-[#f5ff3b]"
                  : isPast
                    ? "border-[#00e5ff]/25 bg-[#00e5ff]/5 text-[#9dd8ff]/60"
                    : "border-[#00e5ff]/15 bg-[#040d24]/60 text-[#9dd8ff]/70",
              ].join(" ")}
              aria-current={isToday ? "step" : undefined}
            >
              <span className="text-[9px] font-semibold uppercase tracking-wider opacity-80">
                Day {day}
              </span>
              <span className="text-xs font-bold sm:text-sm">
                {isPast ? <IconCheck size={14} aria-hidden="true" /> : formatCoins(amount)}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function DailyRewardCard() {
  const {
    isLoaded,
    isSignedIn,
    status,
    loading,
    claiming,
    claimedNow,
    error,
    load,
    claim,
  } = useDailyReward();

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
            Play one game each day — against a player or the AI — and today&apos;s
            coins are yours. Miss a day and the streak starts over.
          </p>

          <div className="mb-5">
            <CycleStrip cycle={status.cycle} cycleDay={status.cycleDay} />
          </div>

          {claimedNow !== null ? (
            <p
              className="flex items-center gap-2 text-sm font-semibold text-[#f5ff3b]"
              role="status"
              data-testid="daily-reward-claimed"
            >
              <IconCheck size={16} aria-hidden="true" /> You claimed{" "}
              {formatCoins(claimedNow)} coins. Come back tomorrow for more.
            </p>
          ) : !status.playGateSatisfied ? (
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 px-3 py-2 text-sm font-semibold text-[#ff4fd8]"
                data-testid="daily-reward-locked"
              >
                <IconLock size={15} aria-hidden="true" /> Play one game to unlock
                today&apos;s reward
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
              className="inline-flex items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-3 text-base font-bold text-[#1f1700] shadow-[0_0_25px_rgba(245,255,59,0.35)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:opacity-60"
            >
              {claiming
                ? "Claiming…"
                : `Claim ${formatCoins(status.reward)} coins`}
            </button>
          ) : (
            <p className="text-sm text-[#c9f7ff]/80" data-testid="daily-reward-claimed">
              Already claimed today — tomorrow&apos;s reward is waiting.
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
        </>
      )}
    </section>
  );
}
