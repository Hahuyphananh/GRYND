"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { motion, useReducedMotion } from "framer-motion";
import {
  IconClockHour4,
  IconCoins,
  IconCreditCard,
  IconDeviceGamepad2,
  IconGift,
  IconLock,
  IconShoppingCart,
  IconSparkles,
} from "@tabler/icons-react";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import DailyRewardCard from "../../components/DailyRewardCard";
import { useCoinBalance } from "../../hooks/useCoinBalance";

/**
 * The Rewards surface (/rewards).
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 *
 * This page is PRESENTATIONAL. Gift-card rewards are NOT available: every card
 * below is a teaser of a POSSIBLE future reward and is explicitly labelled
 * "Coming Soon". There is deliberately no redemption button, no price, and no
 * coin cost anywhere on the page — nothing here can be bought or claimed.
 *
 * ── The coin balance ─────────────────────────────────────────────────────
 *
 * The header shows the caller's current coin balance, and it does so through
 * the EXISTING coin system: the shared `useCoinBalance()` hook, which reads the
 * same `/api/get-user-tokens` endpoint the lobby wager pickers use. This page
 * never creates, derives or writes a balance — it only displays the number that
 * system already returns. A signed-out visitor, or a read that has not resolved
 * yet, gets an honest loading / sign-in state rather than a fabricated "0".
 *
 * ── Brand assets ─────────────────────────────────────────────────────────
 *
 * Cards use brand-NEUTRAL Tabler icons (a cart, a gamepad, a generic card) —
 * never a partner's official logo — because no gift-card partnership is
 * confirmed and the project ships no approved partner artwork.
 */

type GiftCardTeaser = {
  id: string;
  name: string;
  blurb: string;
  Icon: typeof IconGift;
  accent: string;
};

// Examples of the kinds of rewards we are exploring — NOT confirmed
// partnerships and NOT available products. Copy is kept deliberately
// non-committal ("could", "exploring") so nothing here reads as a promise.
const GIFT_CARD_TEASERS: GiftCardTeaser[] = [
  {
    id: "amazon",
    name: "Amazon gift card",
    blurb: "Shop almost anything, anywhere.",
    Icon: IconShoppingCart,
    accent: "#f5ff3b",
  },
  {
    id: "steam",
    name: "Steam gift card",
    blurb: "Grow your games library.",
    Icon: IconDeviceGamepad2,
    accent: "#00e5ff",
  },
  {
    id: "prepaid",
    name: "Visa / Mastercard prepaid card",
    blurb: "Spend it wherever prepaid cards are accepted.",
    Icon: IconCreditCard,
    accent: "#ff4fd8",
  },
];

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
            Your next achievement could unlock something more.
          </p>
        </motion.header>

        {/* ── Coin balance (from the existing coin system) ───────────── */}
        <motion.div {...rise(0.05)}>
          <CoinBalanceCard />
        </motion.div>

        {/* ── Daily Reward — the one reward that IS live ─────────────── */}
        <motion.div className="mb-10" {...rise(0.08)}>
          <DailyRewardCard />
        </motion.div>

        {/* ── Gift Cards — teasers only, nothing redeemable ──────────── */}
        <motion.section
          id="gift-cards"
          aria-labelledby="gift-cards-heading"
          className="mb-10 scroll-mt-28"
          {...rise(0.1)}
        >
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 id="gift-cards-heading" className="text-xl font-bold text-[#00e5ff] sm:text-2xl">
              Gift Cards
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#ff4fd8]/50 bg-[#ff4fd8]/15 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#ff4fd8]">
              <IconClockHour4 size={13} aria-hidden="true" /> Coming Soon
            </span>
          </div>
          <p className="mb-6 max-w-3xl text-sm leading-relaxed text-[#c9f7ff]/80">
            The cards below are examples of the kinds of rewards we are exploring. None of
            them can be redeemed today — there is no coin cost, no price and no claim
            button, because no gift-card reward is available yet.
          </p>

          <ul role="list" className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
            {GIFT_CARD_TEASERS.map(({ id, name, blurb, Icon, accent }) => (
              <li key={id} className="h-full">
                <article
                  className="flex h-full flex-col rounded-xl border border-[#00e5ff]/15 bg-[#040d24]/60 p-5 backdrop-blur-sm transition-colors hover:border-[#00e5ff]/30"
                  data-testid={`gift-card-${id}`}
                >
                  {/* Brand-neutral placeholder — a generic Tabler icon tinted with
                      the card's accent, never a partner logo. */}
                  <span
                    className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg border"
                    style={{
                      borderColor: `${accent}59`,
                      backgroundColor: `${accent}14`,
                      color: accent,
                    }}
                    aria-hidden="true"
                  >
                    <Icon size={28} />
                  </span>
                  <h3 className="mb-1 text-base font-semibold text-[#c9f7ff]">{name}</h3>
                  <p className="mb-4 flex-1 text-sm leading-relaxed text-[#9dd8ff]/80">
                    {blurb}
                  </p>
                  <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#f5ff3b]">
                    <IconLock size={12} aria-hidden="true" /> Coming Soon
                  </span>
                </article>
              </li>
            ))}
          </ul>

          <p className="mt-5 text-xs leading-relaxed text-[#c9f7ff]/60">
            Brand names are shown only as examples of possible future rewards. No
            partnership is confirmed, no gift card is available today, and nothing on this
            page can be purchased or redeemed.
          </p>
        </motion.section>

        {/* ── Explanatory message ───────────────────────────────────── */}
        <motion.section
          aria-labelledby="rewards-note-heading"
          className="mb-10 rounded-xl border border-[#00e5ff]/20 bg-[#040d24]/70 p-6 backdrop-blur-sm"
          {...rise(0.15)}
        >
          <h2
            id="rewards-note-heading"
            className="mb-3 flex items-center gap-2 text-lg font-bold text-[#00e5ff]"
          >
            <IconSparkles size={18} aria-hidden="true" /> Rewards are on the way
          </h2>
          <p className="leading-relaxed text-[#c9f7ff]/90">
            Rewards are coming to GRYND. We&apos;re working on bringing you exciting ways
            to use your coins. Stay tuned!
          </p>
          <ul className="mt-4 space-y-2 text-sm leading-relaxed text-[#c9f7ff]/80">
            <li>
              Gift-card redemption is <strong className="text-[#c9f7ff]">not available yet</strong>{" "}
              — there is nothing to redeem and no way to spend coins on rewards today.
            </li>
            <li>
              Coins are virtual and have{" "}
              <strong className="text-[#c9f7ff]">no cash value</strong>. They cannot be
              withdrawn or exchanged for money.
            </li>
            <li>
              Everything shown on this page is an example of a possible future reward, not a
              confirmed partnership or an available product.
            </li>
          </ul>
        </motion.section>

        {/* ── Optional supporting section ───────────────────────────── */}
        <motion.section
          aria-labelledby="rewards-future-heading"
          className="rounded-xl border border-[#f5ff3b]/20 bg-[#f5ff3b]/5 p-6"
          {...rise(0.2)}
        >
          <h2
            id="rewards-future-heading"
            className="mb-3 text-lg font-bold text-[#f5ff3b]"
          >
            More rewards may be introduced in the future
          </h2>
          <p className="text-sm leading-relaxed text-[#c9f7ff]/80">
            Gift cards are one direction we are exploring, and more rewards may be
            introduced in the future. Nothing beyond what is described on this page is
            confirmed today, and this page will be updated if and when new rewards become
            available.
          </p>
        </motion.section>
      </div>

      <Footer />
    </div>
  );
}
