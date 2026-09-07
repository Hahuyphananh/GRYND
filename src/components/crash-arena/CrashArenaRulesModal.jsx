"use client";
import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
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
    title: "Everyone antes",
    body: (
      <>
        At the start of every hand, <strong className="text-white/90">every player
        posts the same ante</strong> — the table wager. No blinds, no dealer, no
        roles. The pot is simply the antes (plus any carry-over).
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
        The <strong className="text-white/90">last player to fold</strong> before the
        crash takes 1st place, the second-to-last takes 2nd, and so on. The pot
        (minus a 5% fee) is split by rank: 1st gets the biggest share, every
        folder gets something, and{" "}
        <strong className="text-red-400">players still in when it crashes get
        nothing</strong>. The longer you dare to ride, the bigger your rank.
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
        crash. Everyone else ranks by fold order.
      </>
    ),
  },
  {
    icon: <IconBomb size={24} />,
    title: "The crash",
    body: (
      <>
        If <strong className="text-red-400">two or more players are still in</strong>{" "}
        when it crashes, they all lose their ante. The folders keep their ranked
        shares. If <strong className="text-white/90">nobody folded</strong>, no one
        wins and the whole pot <strong className="text-amber-300">carries over</strong>{" "}
        to the next hand.
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
    title: "4 players take a seat",
    body: (
      <>
        Alice, Bob, Carol and Dave join a <strong className="text-amber-300">$10</strong>{" "}
        table (min buy-in $50). No blinds, no dealer — everyone plays the same game.
      </>
    ),
  },
  {
    icon: <IconCards size={22} />,
    tag: "Ante",
    title: "Everyone antes $10",
    body: (
      <>
        All four players post the <strong className="text-amber-300">$10 ante</strong>.
        The curve starts climbing from 1.00x.{" "}
        <strong className="text-cyan-300">Pot = $40</strong>
      </>
    ),
  },
  {
    icon: <IconFlag size={22} />,
    tag: "1.40x",
    title: "Dave folds first",
    body: (
      <>
        Dave bails out at <strong className="text-amber-300">1.40x</strong> — his $10
        stays in the pot as dead money, but he&apos;s now guaranteed last place among
        the folders.
      </>
    ),
  },
  {
    icon: <IconFlag size={22} />,
    tag: "1.90x",
    title: "Carol folds",
    body: (
      <>
        Carol folds at <strong className="text-amber-300">1.90x</strong> — she outlasted
        Dave, so she ranks above him. Alice and Bob stay in.
      </>
    ),
  },
  {
    icon: <IconFlag size={22} />,
    tag: "2.40x",
    title: "Bob folds",
    body: (
      <>
        Bob folds at <strong className="text-amber-300">2.40x</strong> — the latest fold
        so far, which means he&apos;s currently in 1st place… if Alice doesn&apos;t
        outlast him.
      </>
    ),
  },
  {
    icon: <IconBomb size={22} />,
    crash: true,
    tag: "2.60x",
    title: "CRASH!",
    body: (
      <>
        The curve crashes at <strong className="text-amber-300">2.60x</strong> with Alice
        still in — she <strong className="text-red-400">gets nothing</strong>. The folders
        rank by fold order: Bob (2.40x) 1st, Carol (1.90x) 2nd, Dave (1.40x) 3rd.
      </>
    ),
  },
];

const EXAMPLE_RESULT = [
  { label: "Pot", value: "$40", tone: "text-cyan-300" },
  { label: "5% fee", value: "−$2.00", tone: "text-white/60" },
  { label: "Bob (1st)", value: "+$19.00", tone: "text-emerald-300" },
  { label: "Carol (2nd)", value: "+$12.67", tone: "text-emerald-300" },
  { label: "Dave (3rd)", value: "+$6.33", tone: "text-emerald-300" },
  { label: "Alice (crashed)", value: "−$10.00", tone: "text-red-400" },
];

/**
 * Tabbed modal — "Rules" tab lists all the rules, "Example Hand" tab walks
 * through a complete hand step by step.
 */
export default function CrashArenaRulesModal({ onClose }) {
  const [tab, setTab] = useState("rules");

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
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      role="dialog"
      aria-modal="true"
      aria-label="Crash Arena rules and how to play"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
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
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.25 }}
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
                  <li>Everyone antes the wager each hand — no blinds.</li>
                  <li>One decision: <strong className="text-amber-300">Fold</strong>, any time.</li>
                  <li>The <strong className="text-amber-300">last player to fold</strong> takes 1st; every folder ranks below; crash victims get nothing.</li>
                  <li>Last one standing wins the hand immediately.</li>
                  <li>Pot split by rank, <strong className="text-amber-300">minus 5%</strong>.</li>
                  <li>Nobody folded + crash → pot <strong className="text-amber-300">carries over</strong>.</li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Hand summary header */}
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-center">
                <h3 className="text-sm font-black text-amber-300">
                  <IconDeviceGamepad size={18} className="mb-1 mr-1.5 inline" /> Example Hand: $10 Table, 4 Players
                </h3>
                <p className="text-xs text-white/60 mt-1">
                  Follow one full hand from the ante to the ranked payouts.
                </p>
              </div>

              {/* Timeline */}
              <div className="relative pl-5">
                <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-gradient-to-b from-cyan-400 via-amber-400 to-fuchsia-400 rounded-full" />
                <div className="space-y-4">
                  {EXAMPLE_STEPS.map((step, i) => (
                    <motion.div
                      key={step.tag}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.08, duration: 0.25 }}
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
                  $40 pot − $2 fee = $38 split by rank weights (3 : 2 : 1) —
                  Bob 19, Carol 12.67, Dave 6.33. Alice rode into the crash and
                  lost her ante. Folding later beat folding earlier.
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