"use client";
import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  IconArmchair,
  IconBolt,
  IconBomb,
  IconBook,
  IconClock,
  IconDeviceGamepad,
  IconMoneybag,
  IconMoodSilence,
  IconRefresh,
  IconRocket,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";

/**
 * CrashArenaRulesModal — overlay popup explaining the Crash Arena PvP rules
 * and showing a worked example of a full round.
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
        buy-in of <strong className="text-[#d8fbff]">5× the wager</strong>. You buy
        in once and keep playing round after round from that table balance.
      </>
    ),
  },
  {
    icon: <IconMoneybag size={24} />,
    title: "Everyone antes up",
    body: (
      <>
        At the start of each round, every seated player who isn&apos;t sitting out
        stakes the table wager. The pot grows with each player:{" "}
        <strong className="text-[#d8fbff]">pot = players × wager</strong>.
      </>
    ),
  },
  {
    icon: <IconRocket size={24} />,
    title: "Watch it fly",
    body: (
      <>
        The multiplier climbs from 1.00x and keeps going up. The crash point is
        decided by the server before the round starts — it&apos;s always between{" "}
        <strong className="text-[#d8fbff]">1.20x and 9.20x</strong>, and its seed
        hash is shown in advance so every round is provably fair.
      </>
    ),
  },
  {
    icon: <IconClock size={24} />,
    title: "Cash out — or bust",
    body: (
      <>
        Hit <strong className="text-[#00ffa6]">Cash Out</strong> at any moment to
        survive at the current multiplier. The longer you wait, the higher the
        number — but if the rocket crashes before you cash out, you{" "}
        <strong className="text-red-400">lose your wager</strong>.
      </>
    ),
  },
  {
    icon: <IconTrophy size={24} />,
    title: "Winner takes all",
    body: (
      <>
        The player with the <strong className="text-[#d8fbff]">highest successful cashout</strong>{" "}
        wins the <strong className="text-[#FFD700]">entire pot</strong>, minus a 5%
        platform fee. Cash out too early and someone can still out-multiply you —
        only the top number takes the pot.
      </>
    ),
  },
  {
    icon: <IconRefresh size={24} />,
    title: "No winners? Pot carries over",
    body: (
      <>
        If every player busts, nobody gets paid — the full pot{" "}
        <strong className="text-[#d8fbff]">carries over</strong> and is added on
        top of the next round&apos;s pot.
      </>
    ),
  },
  {
    icon: <IconMoodSilence size={24} />,
    title: "Sit out or leave anytime",
    body: (
      <>
        Use <strong className="text-[#d8fbff]">Sit Out</strong> to skip a round while
        keeping your balance. In the waiting phase you can leave the table and take
        your remaining balance with you.
      </>
    ),
  },
];

// ── Worked example: one full round on a $10 table ──────────────────────────

const EXAMPLE_STEPS = [
  {
    icon: <IconArmchair size={22} />,
    tag: "Setup",
    title: "4 players take a seat",
    body: (
      <>
        Alice, Bob, Carol and Dave join a <strong className="text-[#FFD700]">$10</strong>{" "}
        table. Each buys in with the $50 minimum and opts in to play.
      </>
    ),
  },
  {
    icon: <IconMoneybag size={22} />,
    tag: "Ante",
    title: "Everyone stakes $10",
    body: (
      <>
        The wager is deducted from each balance.{" "}
        <strong className="text-[#00e5ff]">Pot = 4 × $10 = $40</strong>
      </>
    ),
  },
  {
    icon: <IconRocket size={22} />,
    tag: "1.50x",
    title: "Dave cashes out",
    body: (
      <>
        The multiplier hits 1.50x — Dave locks it in and survives. He&apos;s safe, but
        his number can still be beaten.
      </>
    ),
  },
  {
    icon: <IconRocket size={22} />,
    tag: "2.10x",
    title: "Alice cashes out",
    body: (
      <>
        Alice holds out a little longer and locks in{" "}
        <strong className="text-[#00ffa6]">2.10x</strong> — the new highest cashout.
      </>
    ),
  },
  {
    icon: <IconBomb size={22} />,
    crash: true,
    tag: "3.20x",
    title: "CRASH!",
    body: (
      <>
        Bob and Carol chase a bigger number… the multiplier crashes at 3.20x before
        they cash out. <strong className="text-red-400">Both bust and lose their $10.</strong>
      </>
    ),
  },
  {
    icon: <IconTrophy size={22} />,
    tag: "Settle",
    title: "Alice wins the pot",
    body: (
      <>
        Alice&apos;s 2.10x is the highest cashout — she wins the whole pot, minus the
        platform fee.
      </>
    ),
  },
];

const EXAMPLE_RESULT = [
  { label: "Pot", value: "$40", tone: "text-[#00e5ff]" },
  { label: "Platform fee (5%)", value: "−$2", tone: "text-red-400" },
  { label: "Alice wins", value: "+$38", tone: "text-[#00ffa6]" },
  { label: "Bob, Carol & Dave", value: "−$10 each", tone: "text-red-400" },
];

/**
 * Tabbed modal — "Rules" tab lists all the rules, "Example Round" tab walks
 * through a complete round step by step.
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
        className="relative w-full max-w-2xl max-h-[88vh] overflow-hidden rounded-3xl border-2 border-[#FFD700]/40 bg-gradient-to-b from-[#0a1a2e] to-[#040d24] shadow-[0_0_60px_rgba(255,215,0,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top glow line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#FFD700] to-transparent" />

        {/* ═══ Header ═══ */}
        <div className="relative px-6 pt-6 pb-4 border-b border-[#00e5ff]/15">
          <button
            onClick={onClose}
            aria-label="Close rules"
            className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full border border-gray-500/30 text-gray-400 hover:text-white hover:bg-gray-500/15 transition-all"
          >
            <IconX size={16} />
          </button>
          <h2 className="text-2xl font-black text-[#f5ff3b]">
            <IconRocket size={24} className="mb-1 mr-2 inline" /> Crash Arena
          </h2>
          <p className="text-sm text-[#9dd8ff] mt-1">
            How the PvP rocket race works — every rule, plus a full example round.
          </p>

          {/* Tab switcher */}
          <div className="mt-4 flex gap-2">
            {[
              { id: "rules", label: "The Rules", icon: <IconBook size={16} /> },
              { id: "example", label: "Example Round", icon: <IconDeviceGamepad size={16} /> },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all duration-200 ${
                  tab === t.id
                    ? "bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-black border-[#FFD700] shadow-[0_0_14px_rgba(255,215,0,0.5)]"
                    : "bg-[#08142f] text-[#FFD700]/70 border-[#FFD700]/25 hover:bg-[#FFD700]/15 hover:text-[#FFD700]"
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
                  className="flex gap-3 rounded-2xl border border-[#00e5ff]/20 bg-[#050d1f]/70 p-4 hover:border-[#00e5ff]/40 hover:bg-[#08142f]/70 transition-all duration-200"
                >
                  <span className="shrink-0 leading-none text-[#00e5ff]">{rule.icon}</span>
                  <div>
                    <h3 className="font-bold text-[#d8fbff]">
                      <span className="text-[#00e5ff]/60 mr-1.5">{i + 1}.</span>
                      {rule.title}
                    </h3>
                    <p className="text-sm text-gray-300 mt-1 leading-relaxed">{rule.body}</p>
                  </div>
                </motion.div>
              ))}

              {/* Quick recap */}
              <div className="mt-2 rounded-2xl border border-[#ff4fd8]/25 bg-[#ff4fd8]/5 p-4">
                <h3 className="text-xs uppercase tracking-wider text-[#ff4fd8]/80 font-bold mb-2">
                  <IconBolt size={14} className="mb-0.5 mr-1 inline" /> Quick recap
                </h3>
                <ul className="text-sm text-gray-300 space-y-1.5 list-disc list-inside">
                  <li>Cash out before the crash to survive.</li>
                  <li>Highest cashout wins the <strong className="text-[#FFD700]">whole pot</strong> minus 5%.</li>
                  <li>Everyone else — even survivors — loses their wager.</li>
                  <li>No cashouts at all? The pot carries over to the next round.</li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Round summary header */}
              <div className="rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/5 p-4 text-center">
                <h3 className="text-sm font-black text-[#FFD700]">
                  <IconDeviceGamepad size={18} className="mb-1 mr-1.5 inline" /> Example Round — $10 Table, 4 Players
                </h3>
                <p className="text-xs text-[#9dd8ff] mt-1">
                  Follow one full round from seats to settlement.
                </p>
              </div>

              {/* Timeline */}
              <div className="relative pl-5">
                <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-gradient-to-b from-[#00e5ff] via-[#FFD700] to-[#ff4fd8] rounded-full" />
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
                            : step.tag === "Settle"
                              ? "bg-[#FFD700]/30 border-[#FFD700]"
                              : "bg-[#00e5ff]/20 border-[#00e5ff]"
                        }`}
                      />
                      <div className="rounded-2xl border border-[#00e5ff]/20 bg-[#050d1f]/70 p-4 hover:border-[#00e5ff]/40 transition-all duration-200">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="leading-none text-[#00e5ff]">{step.icon}</span>
                          <span className="text-xs font-black px-2 py-0.5 rounded-full bg-[#00e5ff]/15 text-[#00e5ff] border border-[#00e5ff]/25">
                            {step.tag}
                          </span>
                          <h4 className="font-bold text-[#d8fbff] text-sm">{step.title}</h4>
                        </div>
                        <p className="text-sm text-gray-300 mt-1.5 leading-relaxed">{step.body}</p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>

              {/* Final settlement box */}
              <div className="rounded-2xl border-2 border-[#FFD700]/40 bg-gradient-to-b from-[#0a1a2e] to-[#040d24] p-4 shadow-[0_0_20px_rgba(255,215,0,0.15)]">
                <h3 className="text-sm font-black text-[#f5ff3b] text-center mb-3">
                  <IconTrophy size={18} className="mb-1 mr-1.5 inline" /> The Payout
                </h3>
                <div className="space-y-2">
                  {EXAMPLE_RESULT.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-[#9dd8ff]">{row.label}</span>
                      <span className={`font-black tabular-nums ${row.tone}`}>{row.value}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-[#9dd8ff]/80 text-center mt-3">
                  Alice&apos;s balance: $50 − $10 wager + $38 win ={" "}
                  <strong className="text-[#00ffa6]">$78</strong>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ═══ Footer ═══ */}
        <div className="relative px-6 py-4 border-t border-[#00e5ff]/15">
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.4)] hover:shadow-[0_0_35px_rgba(0,229,255,0.7)] hover:scale-[1.02] transition-all duration-300"
          >
            Got it — let&apos;s play <IconRocket size={16} className="mb-0.5 ml-1 inline" />
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
