"use client";

import { motion } from "framer-motion";
import { IconGift, IconSwords } from "@tabler/icons-react";
import { useTranslation } from "../../hooks/useTranslation";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import StreakMilestonesCard from "../../components/StreakMilestonesCard";

/**
 * The Rewards surface (/rewards).
 *
 * ── What is live here ─────────────────────────────────────────────────────
 *
 *   * the daily STREAK and its milestones (components/StreakMilestonesCard).
 *
 * Streak progression is server-owned: the card renders the state the read
 * endpoint reports (current/best streak, title, next milestone) and holds no
 * claim, no payout and no milestone arithmetic of its own.
 */

export default function RewardsPage() {
  const { t } = useTranslation();
  // Content must be visible even when hydration or animation is delayed. The
  // previous opacity-0 initial state left the whole page blank if the client
  // never ran (and the background layer also sat above the unpositioned body).
  const rise = (delay = 0) => ({
    initial: false,
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.45, delay },
  });

  return (
    <div className="relative min-h-dvh overflow-x-clip bg-page text-[color:var(--text-primary)]">
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/rewards" />

      <div className="relative z-10 mx-auto max-w-5xl px-4 py-10 sm:py-14">
        {/* ── Page header ────────────────────────────────────────────── */}
        <motion.header className="mb-8" {...rise()}>
          <span className="mb-3 inline-flex items-center gap-2 rounded-full border border-[color:var(--state-gold)] bg-[color:var(--bg-panel)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--state-gold)]">
            <IconGift size={14} aria-hidden="true" /> {t("rewards.pageKicker", "Rewards")}
          </span>
          <h1 className="mb-4 text-3xl font-extrabold text-[color:var(--text-primary)] sm:text-4xl">
            {t("rewards.pageTitle", "Rewards")}
          </h1>
          <p className="max-w-2xl text-base text-[color:var(--text-secondary)] sm:text-lg">
            {t("rewards.pageSubtitle", "Your daily streak, the titles it earns, and every milestone ahead.")}
          </p>
        </motion.header>

        {/* ── Streak milestones ───────────────────────────────────────── */}
        <motion.div className="mb-10" {...rise(0.08)}>
          <StreakMilestonesCard />
        </motion.div>

        {/* ── How rewards work ──────────────────────────────────────── */}
        <motion.section
          aria-labelledby="rewards-note-heading"
          className="rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-6 backdrop-blur-xs"
          {...rise(0.15)}
        >
          <h2
            id="rewards-note-heading"
            className="mb-3 flex items-center gap-2 text-lg font-bold text-[color:var(--text-primary)]"
          >
            <IconSwords size={18} aria-hidden="true" /> {t("rewards.howTitle", "How streaks work")}
          </h2>
          <ul className="space-y-2 text-sm leading-relaxed text-[color:var(--text-secondary)]">
            <li>
              {t("rewards.how1Before", "The streak advances when you")}{" "}
              <strong className="text-[color:var(--text-primary)]">
                {t("rewards.how1Strong", "finish a game")}
              </strong>{" "}
              {t(
                "rewards.how1After",
                "— any mode, any deal. One credit per day, so several games on the same day count once; miss a day and the current streak starts again at day 1.",
              )}
            </li>
            <li>
              {t(
                "rewards.how2",
                "Every milestone can unlock a title or cosmetic. Your best streak and earned rewards are kept when a current streak resets.",
              )}
            </li>
          </ul>
        </motion.section>
      </div>

      <Footer />
    </div>
  );
}
