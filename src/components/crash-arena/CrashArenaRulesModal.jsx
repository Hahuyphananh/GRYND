"use client";
import React, { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { withReducedMotion } from "../../lib/animations";
import {
  IconArmchair,
  IconBolt,
  IconBomb,
  IconBook,
  IconCards,
  IconDeviceGamepad,
  IconFlag,
  IconMoodSilence,
  IconRocket,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";

/**
 * CrashArenaRulesModal — overlay popup explaining the Crash Arena v2 rules
 * and showing a worked example of a full hand.
 *
 * v2 rules: flat ante, one Fold button, ranked payouts.
 *
 * Props:
 *   onClose — () => void — called when the user dismisses the popup
 */

const RULES = [
  {
    icon: <IconArmchair size={24} />,
    title: "Take a seat",
    body: (
      <>
        Pick a table by wager ($1 up to $100,000). Every table requires a
        minimum buy-in of <strong className="text-white/90">5× the wager</strong>. You
        buy in once and keep playing hand after hand from that table balance.
      </>
    ),
  },
  {
    icon: <IconCards size={24} />,
    title: "Both players ante",
    body: (
      <>
        At the start of every hand, <strong className="text-white/90">both players
        post the same ante</strong> — the table wager. No blinds, no dealer, no
        roles. The pot is simply the two antes (plus any carry-over).
      </>
    ),
  },
  {
    icon: <IconRocket size={24} />,
    title: "The curve",
    body: (
      <>
        The multiplier climbs from <strong className="text-white/90">1.00x</strong>,
        faster and faster, until it crashes. The crash point is decided by the
        server before the hand (between <strong className="text-white/90">1.20x and
        9.20x</strong>, provably fair) and is <strong className="text-red-400">never revealed
        until it happens</strong>. The longer you stay, the more dangerous it gets.
      </>
    ),
  },
  {
    icon: <IconFlag size={24} />,
    title: "Fold — anytime, one button",
    body: (
      <>
        Your <strong className="text-white/90">only decision</strong>: stay in or{" "}
        <strong className="text-amber-300">Fold</strong>. Fold at any moment — no
        checkpoints, no timers. Your ante stays in the pot as dead money, and
        your <strong className="text-white/90">fold rank</strong> decides what you take
        home.
      </>
    ),
  },
  {
    icon: <IconTrophy size={24} />,
    title: "Ranked payouts",
    body: (
      <>
        Fold later than your opponent and you take 1st place — and with it the
        bigger share of the pot (minus a 5% fee). The player who folds first
        takes 2nd and still recovers part of their ante, so{" "}
        <strong className="text-amber-300">folding late beats folding
        early</strong>. The longer you dare to ride, the more you take home.
      </>
    ),
  },
  {
    icon: <IconBolt size={24} />,
    title: "Last one standing",
    body: (
      <>
        If a fold leaves <strong className="text-white/90">exactly one player still
        in</strong>, that player wins the hand immediately — no need to survive the
        crash. In a head-to-head duel that is what ends almost every hand.
      </>
    ),
  },
  {
    icon: <IconBomb size={24} />,
    title: "The crash",
    body: (
      <>
        If you <strong className="text-red-400">both ride into the crash</strong>,
        you both lose your ante. Because nobody folded, no one wins and the whole
        pot <strong className="text-amber-300">carries over</strong> to the next
        hand — so the ante you just lost is playing for a bigger pot next time.
      </>
    ),
  },
  {
    icon: <IconMoodSilence size={24} />,
    title: "Sit out or leave anytime",
    body: (
      <>
        Sit out to skip a hand while keeping your balance. In the waiting
        phase you can leave the table and take your remaining balance with you.
      </>
    ),
  },
];

// ── Worked example: one full hand on a $10 table ───────────────────────────

const EXAMPLE_STEPS = [
  {
    icon: <IconArmchair size={22} />,
    tag: "Setup",
    title: "Two players take a seat",
    body: (
      <>
        Alice and Bob join a <strong className="text-amber-300">$10</strong> table
        (min buy-in $50). Crash Arena is head-to-head, so the table is full — no
        blinds, no dealer, both players on the same game.
      </>
    ),
  },
  {
    icon: <IconCards size={22} />,
    tag: "Ante",
    title: "Both players ante $10",
    body: (
      <>
        Both players post the <strong className="text-amber-300">$10 ante</strong>.
        The curve starts climbing from 1.00x.{" "}
        <strong className="text-cyan-300">Pot = $20</strong>
      </>
    ),
  },
  {
    icon: <IconFlag size={22} />,
    tag: "1.40x",
    title: "Bob folds",
    body: (
      <>
        Bob bails out at <strong className="text-amber-300">1.40x</strong> — his $10
        stays in the pot as dead money, and he&apos;s locked into 2nd place.
      </>
    ),
  },
  {
    icon: <IconBolt size={22} />,
    tag: "Fold-out",
    title: "Alice is the last player standing",
    body: (
      <>
        Bob&apos;s fold left exactly <strong className="text-white/90">one player
        still in</strong>, so the hand ends right there — Alice wins it without ever
        having to survive a crash. Had <em>she</em> folded instead, the two
        finishes would simply swap.
      </>
    ),
  },
];

const EXAMPLE_RESULT = [
  { label: "Pot", value: "$20", tone: "text-cyan-300" },
  { label: "5% fee", value: "−$1.00", tone: "text-white/60" },
  { label: "Alice (1st)", value: "+$12.67", tone: "text-emerald-300" },
  { label: "Bob (2nd, folded)", value: "+$6.33", tone: "text-emerald-300" },
];

/**
 * Tabbed modal — "Rules" tab lists all the rules, "Example Hand" tab walks
 * through a complete hand step by step.
 */
export default function CrashArenaRulesModal({ onClose }) {
  const [tab, setTab] = useState("rules");
  // Reduced motion: the dialog and its staggered rule/example reveals appear
  // in place (same shared helper the rest of the game uses) — the delays it
  // carries are dropped with it, so nothing is still sliding in seconds later.
  const shouldReduce = useReducedMotion();

  // Close on Escape for keyboard users + lock background scroll while open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <motion.div
      {...withReducedMotion(shouldReduce, {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
      })}
      role="dialog"
      aria-modal="true"
      aria-label="Crash Arena rules and how to play"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        {...withReducedMotion(shouldReduce, {
          initial: { scale: 0.9, opacity: 0, y: 20 },
          animate: { scale: 1, opacity: 1, y: 0 },
          transition: { type: "spring", stiffness: 300, damping: 25 },
        })}
        className="relative w-full max-w-2xl max-h-[88vh] overflow-hidden rounded-3xl border-2 border-amber-700/60 bg-gradient-to-b from-[#12042a] to-[#0a0118] shadow-[0_0_60px_rgba(251,191,36,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top glow line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />

        {/* ═══ Header ═══ */}
        <div className="relative px-6 pt-6 pb-4 border-b border-amber-700/30">
          <button
            onClick={onClose}
            aria-label="Close rules"
            className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full border border-gray-500/30 text-gray-400 hover:text-white hover:bg-gray-500/15 transition-all"
          >
            <IconX size={16} />
          </button>
          <h2 className="text-2xl font-black text-amber-300">
            <IconCards size={24} className="mb-1 mr-2 inline" /> Crash Arena
          </h2>
          <p className="text-sm text-white/60 mt-1">
            Ante up, ride the curve, and fold at the right moment. Every rule, plus a full example hand.
          </p>

          {/* Tab switcher */}
          <div className="mt-4 flex gap-2">
            {[
              { id: "rules", label: "The Rules", icon: <IconBook size={16} /> },
              { id: "example", label: "Example Hand", icon: <IconDeviceGamepad size={16} /> },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all duration-200 ${
                  tab === t.id
                    ? "bg-amber-400 text-black border-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.5)]"
                    : "bg-slate-900/80 text-amber-200/70 border-amber-600/30 hover:bg-amber-500/15 hover:text-amber-300"
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {t.icon}
                  {t.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ═══ Scrollable content ═══ */}
        <div className="relative max-h-[calc(88vh-180px)] overflow-y-auto px-6 py-5">
          {tab === "rules" ? (
            <div className="space-y-3">
              {RULES.map((rule, i) => (
                <motion.div
                  key={rule.title}
                  {...withReducedMotion(shouldReduce, {
                    initial: { opacity: 0, x: -12 },
                    animate: { opacity: 1, x: 0 },
                    transition: { delay: i * 0.05, duration: 0.25 },
                  })}
                  className="flex gap-3 rounded-2xl border border-cyan-700/30 bg-black/40 p-4 hover:border-cyan-500/50 hover:bg-slate-900/70 transition-all duration-200"
                >
                  <span className="shrink-0 leading-none text-cyan-300">{rule.icon}</span>
                  <div>
                    <h3 className="font-bold text-white/90">
                      <span className="text-cyan-300/60 mr-1.5">{i + 1}.</span>
                      {rule.title}
                    </h3>
                    <p className="text-sm text-gray-300 mt-1 leading-relaxed">{rule.body}</p>
                  </div>
                </motion.div>
              ))}

              {/* Quick recap */}
              <div className="mt-2 rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/10 p-4">
                <h3 className="text-xs uppercase tracking-wider text-fuchsia-400 font-bold mb-2">
                  <IconBolt size={14} className="mb-0.5 mr-1 inline" /> Quick recap
                </h3>
                <ul className="text-sm text-gray-300 space-y-1.5 list-disc list-inside">
                  <li>Both players ante the wager each hand — no blinds.</li>
                  <li>One decision: <strong className="text-amber-300">Fold</strong>, any time.</li>
                  <li>Fold <strong className="text-amber-300">later</strong> than your opponent → 1st; fold first → 2nd and still part of your ante back.</li>
                  <li>Last one standing wins the hand immediately.</li>
                  <li>Pot split by rank, <strong className="text-amber-300">minus 5%</strong>.</li>
                  <li>Both riders crash → pot <strong className="text-amber-300">carries over</strong>.</li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Hand summary header */}
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-center">
                <h3 className="text-sm font-black text-amber-300">
                  <IconDeviceGamepad size={18} className="mb-1 mr-1.5 inline" /> Example Hand: $10 Table, Head-to-Head
                </h3>
                <p className="text-xs text-white/60 mt-1">
                  Follow one full duel from the ante to the ranked payouts.
                </p>
              </div>

              {/* Timeline */}
              <div className="relative pl-5">
                <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-gradient-to-b from-cyan-400 via-amber-400 to-fuchsia-400 rounded-full" />
                <div className="space-y-4">
                  {EXAMPLE_STEPS.map((step, i) => (
                    <motion.div
                      key={step.tag}
                      {...withReducedMotion(shouldReduce, {
                        initial: { opacity: 0, y: 10 },
                        animate: { opacity: 1, y: 0 },
                        transition: { delay: i * 0.08, duration: 0.25 },
                      })}
                      className="relative"
                    >
                      <span
                        className={`absolute -left-5 top-1 w-[19px] h-[19px] rounded-full border-2 flex items-center justify-center text-[9px] ${
                          step.crash
                            ? "bg-red-500/30 border-red-400"
                            : step.tag === "Ante"
                              ? "bg-amber-400/30 border-amber-400"
                              : "bg-cyan-400/20 border-cyan-400"
                        }`}
                      />
                      <div className="rounded-2xl border border-cyan-700/30 bg-black/40 p-4 hover:border-cyan-500/50 transition-all duration-200">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="leading-none text-cyan-300">{step.icon}</span>
                          <span className="text-xs font-black px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                            {step.tag}
                          </span>
                          <h4 className="font-bold text-white/90 text-sm">{step.title}</h4>
                        </div>
                        <p className="text-sm text-gray-300 mt-1.5 leading-relaxed">{step.body}</p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>

              {/* Final settlement box */}
              <div className="rounded-2xl border-2 border-amber-700/60 bg-gradient-to-b from-[#12042a] to-[#0a0118] p-4 shadow-[0_0_20px_rgba(251,191,36,0.15)]">
                <h3 className="text-sm font-black text-amber-300 text-center mb-3">
                  <IconTrophy size={18} className="mb-1 mr-1 inline" /> The Settlement
                </h3>
                <div className="space-y-2">
                  {EXAMPLE_RESULT.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-white/60">{row.label}</span>
                      <span className={`font-black tabular-nums ${row.tone}`}>{row.value}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-cyan-100/70 text-center mt-3">
                  $20 pot − $1 fee = $19 split by rank weights (2 : 1) — Alice
                  12.67, Bob 6.33. Neither player crashed: Bob bowed out early
                  and still recovered part of his ante, while Alice rode to the
                  fold-out and took the bigger share.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ═══ Footer ═══ */}
        <div className="relative px-6 py-4 border-t border-amber-700/30">
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl font-bold text-sm bg-cyan-500 text-black border-b-4 border-cyan-700 shadow-[0_0_20px_rgba(34,211,238,0.35)] hover:shadow-[0_0_35px_rgba(34,211,238,0.6)] hover:scale-[1.02] transition-all duration-300"
          >
            Got it. Let&apos;s play <IconCards size={16} className="mb-0.5 ml-1 inline" />
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}