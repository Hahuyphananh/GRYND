"use client";
import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  IconArmchair,
  IconArrowUp,
  IconBolt,
  IconBomb,
  IconBook,
  IconCards,
  IconClock,
  IconDeviceGamepad,
  IconFlag,
  IconHandStop,
  IconMoodSilence,
  IconRocket,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";

/**
 * CrashArenaRulesModal — overlay popup explaining the Crash Poker rules
 * and showing a worked example of a full hand.
 *
 * Matches the styling language of BuyInModal (dark casino theme, gold/cyan
 * neon accents) and is rendered conditionally by its parent:
 *
 *   {showRules && <CrashArenaRulesModal onClose={() => setShowRules(false)} />}
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
        Pick a table by wager ($1–$100). Every table requires a minimum
        buy-in of <strong className="text-white/90">5× the wager</strong>. You buy
        in once and keep playing hand after hand from that table balance.
      </>
    ),
  },
  {
    icon: <IconCards size={24} />,
    title: "Blinds & ante",
    body: (
      <>
        The dealer button rotates every hand. The player left of the dealer
        posts the <strong className="text-amber-300">Small Blind</strong> (half the
        wager), the next posts the <strong className="text-amber-300">Big Blind</strong>{" "}
        (the full wager), and every other player posts the small blind as the{" "}
        <strong className="text-white/90">minimum opening contribution</strong>. Everyone
        starts the hand with chips committed.
      </>
    ),
  },
  {
    icon: <IconHandStop size={24} />,
    title: "Betting checkpoints",
    body: (
      <>
        The first betting decision opens at{" "}
        <strong className="text-white/90">1.25x</strong>, then every{" "}
        <strong className="text-white/90">+0.25x</strong> (1.50x, 1.75x, 2.00x, …). At each
        checkpoint you <strong className="text-emerald-300">Fold</strong>,{" "}
        <strong className="text-emerald-300">Call</strong> the required bet (check when already
        matched), or <strong className="text-emerald-300">Raise</strong> it for everyone (at least
        one big blind more).
      </>
    ),
  },
  {
    icon: <IconFlag size={24} />,
    title: "Fold = cut your losses",
    body: (
      <>
        Fold and you lose <strong className="text-white/90">only what you&apos;ve already
        committed</strong> this hand — exactly like poker. Your chips stay in the pot and
        the hand continues without you.
      </>
    ),
  },
  {
    icon: <IconBolt size={24} />,
    title: "All-in",
    body: (
      <>
        Can&apos;t cover a call or raise? You go{" "}
        <strong className="text-white/90">all-in</strong> automatically with everything you
        have left. All-in players are committed for the hand — they can&apos;t act
        again and just ride the curve to the crash.
      </>
    ),
  },
  {
    icon: <IconBomb size={24} />,
    title: "The crash",
    body: (
      <>
        The multiplier is server-decided before the hand (between{" "}
        <strong className="text-white/90">1.20x and 9.20x</strong>, provably fair) and can hit
        at <strong className="text-white/90">any moment — even between checkpoints</strong>.
        If <strong className="text-red-400">two or more players are still in</strong> when it
        crashes, they all lose. If someone folded earlier, the{" "}
        <strong className="text-amber-300">latest successful fold wins the whole pot</strong>;
        if nobody folded, the pot{" "}
        <strong className="text-amber-300">carries over</strong> to the next hand.
      </>
    ),
  },
  {
    icon: <IconTrophy size={24} />,
    title: "Fold-order winner",
    body: (
      <>
        Folding later beats folding earlier: when the crash catches the
        players still in, the player who{" "}
        <strong className="text-white/90">folded most recently</strong> wins the pot (minus
        the 5% fee). Early folders lose only their own contribution — folding
        is how you cut your losses, and the timing of your fold matters.
      </>
    ),
  },
  {
    icon: <IconHandStop size={24} />,
    title: "Last one standing wins",
    body: (
      <>
        When every other player has folded, the{" "}
        <strong className="text-white/90">last player standing takes the pot</strong> (minus a 5%
        platform fee) — immediately, no need to survive the crash.
      </>
    ),
  },
  {
    icon: <IconClock size={24} />,
    title: "Auto-fold deadline",
    body: (
      <>
        You get <strong className="text-white/90">10 seconds</strong> to act at each open
        checkpoint. Stall past the deadline and the server{" "}
        <strong className="text-red-400">folds you automatically</strong> — one player can never
        freeze the table.
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
        table (min buy-in $50). The dealer button starts on Alice.
      </>
    ),
  },
  {
    icon: <IconCards size={22} />,
    tag: "Blinds",
    title: "SB $5, BB $10, ante $5 each",
    body: (
      <>
        Bob posts the <strong className="text-amber-300">Small Blind $5</strong>, Carol the{" "}
        <strong className="text-amber-300">Big Blind $10</strong>, and Alice &amp; Dave the $5
        ante. <strong className="text-cyan-300">Pot = $25</strong>
      </>
    ),
  },
  {
    icon: <IconHandStop size={22} />,
    tag: "1.25x",
    title: "Everyone calls",
    body: (
      <>
        The first checkpoint opens. Everyone tops up to the $10 big blind.{" "}
        <strong className="text-cyan-300">Pot = $40</strong>
      </>
    ),
  },
  {
    icon: <IconArrowUp size={22} />,
    tag: "1.50x",
    title: "Dave raises, Bob folds",
    body: (
      <>
        Dave raises to <strong className="text-amber-300">$20</strong>. Bob folds — out of the
        hand, losing only his $10. Alice &amp; Carol call the extra $10.{" "}
        <strong className="text-cyan-300">Pot = $70</strong>
      </>
    ),
  },
  {
    icon: <IconArrowUp size={22} />,
    tag: "2.00x",
    title: "Alice raises again",
    body: (
      <>
        Alice raises to <strong className="text-amber-300">$30</strong>; Carol &amp; Dave call.{" "}
        <strong className="text-cyan-300">Pot = $100</strong>
      </>
    ),
  },
  {
    icon: <IconBomb size={22} />,
    crash: true,
    tag: "2.75x",
    title: "CRASH!",
    body: (
      <>
        The multiplier crashes between checkpoints with{" "}
        <strong className="text-red-400">Alice, Carol &amp; Dave still in</strong> — all three
        lose their stacks. Bob&apos;s fold at 1.50x was the{" "}
        <strong className="text-amber-300">latest successful fold</strong>, so the fold-order
        rule awards Bob the <strong className="text-amber-300">$100 pot</strong>.
      </>
    ),
  },
];

const EXAMPLE_RESULT = [
  { label: "Winner", value: "Bob (folded at 1.50x)", tone: "text-amber-300" },
  { label: "Bob wins", value: "+$95 (5% fee)", tone: "text-emerald-300" },
  { label: "Alice, Carol & Dave", value: "−$30 each", tone: "text-red-400" },
  { label: "Early folders (none here)", value: "lose only their stake", tone: "text-white/60" },
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
            The crash curve meets poker betting. Every rule, plus a full example hand.
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
                  <li>Blinds every hand: SB = half the wager, BB = the wager, everyone else antes the SB.</li>
                  <li>Bet at 1.25x, then every +0.25x: fold, call, or raise.</li>
                  <li>Fold → you lose only what you committed. All-in → committed for the hand.</li>
                  <li>Crash with 2+ still in → the <strong className="text-amber-300">latest fold before the crash wins</strong> the pot; nobody folded → pot carries over.</li>
                  <li>Last player standing wins the pot <strong className="text-amber-300">minus 5%</strong>.</li>
                  <li>10 seconds to act, or the server auto-folds you.</li>
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
                  Follow one full hand from the blinds to settlement.
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
                            : step.tag === "Blinds"
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
                  <IconTrophy size={18} className="mb-1 mr-1.5 inline" /> The Settlement
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
                  Bob folded at 1.50x and outlasted everyone — folding later
                  beat folding earlier. The pot is awarded exactly once, minus
                  the 5% fee.
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
