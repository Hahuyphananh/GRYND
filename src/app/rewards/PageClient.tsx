"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { motion, useReducedMotion } from "framer-motion";
import { IconCoins, IconGift, IconSwords } from "@tabler/icons-react";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import DailyRewardCard from "../../components/DailyRewardCard";
import QuestBoard from "../../components/QuestBoard";
import CoinShopOffers from "../../components/CoinShopOffers";
import { useCoinBalance } from "../../hooks/useCoinBalance";

/**
 * The Rewards surface (/rewards).
 *
 * ── What is live here ─────────────────────────────────────────────────────
 *
 *   * the daily login reward (components/DailyRewardCard) — unchanged;
 *   * daily and weekly QUESTS (components/QuestBoard), which pay virtual coins
 *     for completed matches against real players.
 *
 * Both are paid by the server. This page owns no reward rule: it renders the
 * status each system reports, and the only interactive control (a quest claim)
 * posts a quest id to an authenticated endpoint that validates the row itself.
 *
 * ── The coin balance ─────────────────────────────────────────────────────
 *
 * The header shows the caller's current coin balance through the EXISTING coin
 * system: the shared `useCoinBalance()` hook, which reads the same
 * `/api/get-user-tokens` endpoint the lobby wager pickers use. This page never
 * creates, derives or writes a balance — it only displays the number that
 * system already returns. A signed-out visitor, or a read that has not resolved
 * yet, gets an honest loading / sign-in state rather than a fabricated "0".
 *
 * ── Optional coin packs ──────────────────────────────────────────────────
 *
 * `CoinShopOffers` is the only paid surface that may ever appear here. It is
 * server-gated (COIN_PURCHASES_ENABLED) and renders NOTHING by default — not
 * even a placeholder — and while payment fulfilment is unimplemented it shows
 * the resolved offers with no active purchase action. Every amount and price
 * it displays is resolved server-side from `token_packages`.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────
 *
 * No gift-card teasers and no redemption of any kind: coins are virtual, have no
 * cash value, and cannot be exchanged for money, gift cards or anything else.
 */

function formatCoins(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * The balance value for a signed-in caller. Mounted ONLY when there is a
 * session, so the public page never fires an authenticated balance read for a
 * signed-out visitor. `null` from the hook means "not resolved yet" (or the
 * read failed) and renders as a placeholder — never a fabricated 0.
 */
function SignedInCoinBalance() {
  const balance = useCoinBalance();

  if (balance === null) {
    return (
      <p className="mt-0.5 text-2xl font-bold text-[#f5ff3b]/50" aria-hidden="true">
        …
      </p>
    );
  }

  return (
    <p
      className="mt-0.5 text-2xl font-bold text-[#f5ff3b]"
      data-testid="rewards-coin-balance"
      aria-live="polite"
    >
      {formatCoins(balance)}
      <span className="ml-2 align-middle text-xs font-semibold uppercase tracking-wider text-[#f5ff3b]/70">
        Coins
      </span>
    </p>
  );
}

/**
 * The header's coin balance. Reads the existing coin system (through a child
 * that only mounts when signed in) and renders an honest state for each case:
 * Clerk still loading, signed out, and signed in with a live balance.
 */
function CoinBalanceCard() {
  const { isLoaded, isSignedIn } = useUser();

  return (
    <section
      aria-label="Your coin balance"
      className="mb-10 rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-5 backdrop-blur-sm sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 text-[#f5ff3b]"
            aria-hidden="true"
          >
            <IconCoins size={22} />
          </span>
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-[#9dd8ff]">
              Your balance
            </p>
            {!isLoaded ? (
              <p className="mt-0.5 text-2xl font-bold text-[#f5ff3b]/50" aria-hidden="true">
                —
              </p>
            ) : isSignedIn ? (
              <SignedInCoinBalance />
            ) : (
              <p className="mt-0.5 text-sm text-[#c9f7ff]">
                <Link
                  href="/sign-in"
                  className="text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]"
                >
                  Sign in
                </Link>{" "}
                to see your coin balance.
              </p>
            )}
          </div>
        </div>
        <p className="max-w-xs text-xs leading-relaxed text-[#c9f7ff]/60">
          Coins are GRYND&apos;s virtual in-game currency. They have no cash value and
          cannot be exchanged for money.
        </p>
      </div>
    </section>
  );
}

export default function RewardsPage() {
  const shouldReduceMotion = useReducedMotion();
  const rise = (delay = 0) => ({
    initial: shouldReduceMotion ? false : { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.45, delay: shouldReduceMotion ? 0 : delay },
  });

  return (
    <div className="relative min-h-screen overflow-x-clip">
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/rewards" />

      <div className="mx-auto max-w-5xl px-4 py-10 sm:py-14">
        {/* ── Page header ────────────────────────────────────────────── */}
        <motion.header className="mb-8" {...rise()}>
          <span className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#f5ff3b]">
            <IconGift size={14} aria-hidden="true" /> Rewards
          </span>
          <h1 className="mb-4 text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00e5ff] to-[#f5ff3b] sm:text-4xl">
            Rewards
          </h1>
          <p className="max-w-2xl text-base text-[#9dd8ff] sm:text-lg">
            Your daily reward, your quests, and the coins they pay — all in one place.
          </p>
        </motion.header>

        {/* ── Coin balance (from the existing coin system) ───────────── */}
        <motion.div {...rise(0.05)}>
          <CoinBalanceCard />
        </motion.div>

        {/* ── Optional coin packs ─────────────────────────────────────
            Renders nothing unless the deployment explicitly enables coin
            purchases (server flag) AND the catalog resolves offers. The
            component owns the whole surface, so this page still holds no
            button, no click handler and no price of its own. */}
        <motion.div className="mb-10" {...rise(0.07)}>
          <CoinShopOffers />
        </motion.div>

        {/* ── Daily Reward — unchanged ───────────────────────────────── */}
        <motion.div className="mb-10" {...rise(0.08)}>
          <DailyRewardCard />
        </motion.div>

        {/* ── Quests — daily and weekly, paid by the server ──────────── */}
        <motion.div className="mb-10" {...rise(0.1)}>
          <QuestBoard />
        </motion.div>

        {/* ── How rewards work ──────────────────────────────────────── */}
        <motion.section
          aria-labelledby="rewards-note-heading"
          className="rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-6 backdrop-blur-sm"
          {...rise(0.15)}
        >
          <h2
            id="rewards-note-heading"
            className="mb-3 flex items-center gap-2 text-lg font-bold text-[#00e5ff]"
          >
            <IconSwords size={18} aria-hidden="true" /> How rewards work
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed text-[#c9f7ff]/85">
            <li>
              Quest progress comes from{" "}
              <strong className="text-[#c9f7ff]">
                completed matches against real players
              </strong>
              . Games against the AI or the practice bot never count towards a quest.
            </li>
            <li>
              Each quest pays its coins once, and only after it is complete — the
              button appears when the server has confirmed the objective.
            </li>
            <li>
              Coins are virtual and have{" "}
              <strong className="text-[#c9f7ff]">no cash value</strong>. They cannot be
              withdrawn, exchanged for money, or redeemed for gift cards.
            </li>
          </ul>
        </motion.section>
      </div>

      <Footer />
    </div>
  );
}
