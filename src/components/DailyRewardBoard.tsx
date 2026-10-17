"use client";

// src/components/DailyRewardBoard.tsx
//
// The daily login reward's BOARD — the 14-day cycle laid out as tiles, opened
// from the claim button on /rewards (components/DailyRewardCard) and from the
// corner widget (components/DailyRewardWidget).
//
// ── Why a board ─────────────────────────────────────────────────────────────
//
// A single "Claim 60 coins" button hides the thing that makes a login streak
// worth keeping: tomorrow is worth more than today, and the fortnight ends in a
// payday. The board makes the whole cycle visible at once, so the day a player
// is on, the day they would be paid, and what completing the cycle is worth are
// all on screen before they commit.
//
// ── Presentational, deliberately ────────────────────────────────────────────
//
// This component never fetches and never computes an amount. It is handed the
// `useDailyReward()` result and renders it — the server owns the curve, the
// streak and the gate. That keeps ONE claim path in the app (the hook) no
// matter how many surfaces open the board.
//
// ── The three states a tile can be in ───────────────────────────────────────
//
//   * before today — already collected in this cycle (ticked);
//   * today       — highlighted; ticked once today's claim has landed;
//   * after today — still to come, showing what it will pay.
//
// A tile is never a second claim button: the single action lives in the footer,
// so there is exactly one thing to press and exactly one request it can send.
//
// ── Why it is portalled ─────────────────────────────────────────────────────
//
// Both hosts mount this inside framer-motion wrappers (the /rewards card sits in
// a `motion.div` whose entrance animates a transform). A transformed ancestor
// becomes the containing block for `position: fixed` descendants AND opens a new
// stacking context, so an overlay rendered in place would be sized to that
// wrapper and could be painted under the fixed navbar. Portalling to
// `document.body` puts the board at the top of the document where `fixed
// inset-0` and `z-[100]` mean what they say.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { IconCheck, IconCoins, IconGift, IconLock, IconRefresh, IconX } from "@tabler/icons-react";
import type { DailyRewardStatus, UseDailyReward } from "../hooks/useDailyReward";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The shared reward state, owned by the surface that opened the board. */
  reward: UseDailyReward;
};

function formatCoins(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** One day of the cycle. Purely presentational — see the file header. */
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
            : "border-[#00e5ff]/15 bg-[#040d24]/60 text-[#9dd8ff]/80",
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

/** The 14 tiles, in cycle order, with today highlighted. */
function Board({ status }: { status: DailyRewardStatus }) {
  return (
    <ol
      role="list"
      data-testid="daily-reward-board"
      className="grid grid-cols-4 gap-1.5 sm:grid-cols-7 sm:gap-2"
    >
      {status.cycle.map((amount, index) => {
        const day = index + 1;
        const isToday = day === status.cycleDay;
        // Days already behind us in this cycle are collected; today counts as
        // collected the moment the claim lands.
        const isCollected = day < status.cycleDay || (isToday && !status.claimable);
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

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
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
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#f5ff3b]/40 bg-[#040d24] p-4 shadow-[0_0_40px_rgba(245,255,59,0.25)] outline-none sm:p-6"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2
              id="daily-reward-board-heading"
              className="flex items-center gap-2 text-lg font-bold text-[#f5ff3b] sm:text-xl"
            >
              <IconGift size={20} aria-hidden="true" /> Daily Reward
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#c9f7ff]/75 sm:text-sm">
              Log in and play one game each day. The streak climbs for 14 days — miss a day and it
              starts again at day 1.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close daily reward"
            data-testid="daily-reward-board-close"
            className="shrink-0 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 p-2 text-[#d8fbff] transition hover:bg-[#00e5ff]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
          >
            <IconX size={16} aria-hidden="true" />
          </button>
        </div>

        {!status ? (
          <p className="py-4 text-sm text-[#9dd8ff]/70" aria-hidden="true">
            Loading your reward…
          </p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#00e5ff]">
                {formatCoins(status.streakDay)}-day streak
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#f5ff3b]">
                Day {status.cycleDay} of {status.cycleDays}
              </span>
            </div>

            <Board status={status} />

            <div className="mt-5">
              {claimedNow !== null ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p
                    className="flex items-center gap-2 text-sm font-semibold text-[#f5ff3b]"
                    role="status"
                    data-testid="daily-reward-claimed"
                  >
                    <IconCheck size={16} aria-hidden="true" /> You claimed {formatCoins(claimedNow)}{" "}
                    coins. Come back tomorrow — day{" "}
                    {status.cycleDay === status.cycleDays ? 1 : status.cycleDay + 1} is next.
                  </p>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-4 py-2 text-sm font-semibold text-[#d8fbff] transition hover:bg-[#00e5ff]/25"
                  >
                    Nice!
                  </button>
                </div>
              ) : !status.playGateSatisfied ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 px-3 py-2 text-sm font-semibold text-[#ff4fd8]"
                    data-testid="daily-reward-locked"
                  >
                    <IconLock size={15} aria-hidden="true" /> Play one game to unlock today&apos;s
                    reward
                  </span>
                  <Link
                    href="/games"
                    className="text-sm font-semibold text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
                  >
                    Choose a game
                  </Link>
                </div>
              ) : status.claimable && status.walletFull ? (
                // The ONE claim button lives here, so it must carry the same
                // verdict the card and the widget show: an at-ceiling wallet
                // cannot take the credit, and the server would refuse it.
                <span
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 px-3 py-2 text-sm font-semibold text-[#ff4fd8]"
                  data-testid="daily-reward-wallet-full"
                >
                  <IconLock size={15} aria-hidden="true" /> Wallet full (
                  {formatCoins(status.walletCap)} coin limit) — spend some coins to claim
                  today&apos;s {formatCoins(status.reward)} coins.
                </span>
              ) : status.claimable ? (
                <button
                  type="button"
                  onClick={claim}
                  disabled={claiming}
                  data-testid="daily-reward-claim"
                  className="inline-flex w-full items-center justify-center rounded-xl border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-3 text-base font-bold text-[#1f1700] shadow-[0_0_25px_rgba(245,255,59,0.35)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#030817] disabled:opacity-60 sm:w-auto"
                >
                  {claiming
                    ? "Claiming…"
                    : `Claim day ${status.cycleDay} — ${formatCoins(status.reward)} coins`}
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
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
