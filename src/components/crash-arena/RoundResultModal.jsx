"use client";
import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { IconBomb, IconConfetti, IconFlag, IconTarget, IconTrophy } from "@tabler/icons-react";

/**
 * RoundResultModal — shown when a Crash Arena hand ends. Displays the
 * ranked payout table (every folder gets a share by fold order; crash
 * victims get nothing), the player's own result, and then advances to the
 * next hand (manual button or auto-dismiss).
 *
 * Winner semantics (v2 rank rules):
 *   • fold-out — exactly one player was still active when everyone else
 *     folded; they take rank 1 and the pot is split by rank.
 *   • crash with 2+ active — the LAST player to fold before the crash is
 *     rank 1; remaining folders rank below by fold order; crash victims
 *     get nothing.
 *   • nobody folded and 2+ active at the crash — no winner; the pot
 *     carries over to the next hand.
 *
 * Payout: pot − 5% fee, split by linear weights — rank r of R gets
 * weight (R − r + 1).
 *
 * Rendered conditionally by ArenaTable:
 *   {phase === "settling" && results && <RoundResultModal ... />}
 *
 * Props:
 *   roundNumber — number of the hand that just ended
 *   results     — roundState.results from settleRound
 *   you         — the current player object (from roundState.players) or null
 *   wager       — table wager / ante (used to show net profit / loss)
 *   pot         — the hand pot (used for the carry-over message)
 *   onNextRound — () => void — dismiss + advance to the next hand
 */
export default function RoundResultModal({
  roundNumber = 1,
  results,
  you = null,
  wager = 0,
  pot = 0,
  onNextRound,
}) {
  // Auto-dismiss after 8 seconds so hands keep flowing.
  const [remaining, setRemaining] = useState(8);

  useEffect(() => {
    if (remaining <= 0) {
      onNextRound?.();
      return;
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining, onNextRound]);

  const winner = results?.winner ?? null;
  const winnerMultiplier = results?.winnerMultiplier ?? null;
  const fee = results?.fee ?? 0;
  const payoutGross = results?.payoutGross ?? 0;
  const carryOver = results?.winner === null ? (results?.carryOver ?? pot) : 0;
  const wonByFold = Boolean(results?.wonByFold);
  // Ranked payouts — sorted rank 1 first (server-authoritative when
  // provided; the local mirror computes the same numbers otherwise).
  const payouts = Array.isArray(results?.payouts) ? results.payouts : [];

  const youWon = winner !== null && you?.name === winner;
  const myPayout = you?.userId != null
    ? payouts.find((p) => p.userId === you.userId)?.amount ?? 0
    : 0;
  const myRank = you?.userId != null
    ? payouts.find((p) => p.userId === you.userId)?.rank ?? null
    : null;
  const youCommitted = you?.contributed ?? (you ? wager : 0);
  const youFolded = you?.folded && !youWon;
  const youBusted = you?.busted && !youWon;
  const net = myPayout - youCommitted;
  const bustedPlayers = Array.isArray(results?.bustedPlayers) ? results.bustedPlayers : [];

  const rankLabel = (rank) => {
    if (rank === 1) return "1st";
    if (rank === 2) return "2nd";
    if (rank === 3) return "3rd";
    return `${rank}th`;
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      role="dialog"
      aria-modal="true"
      aria-label="Hand results"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm"
      onClick={onNextRound}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
        className="relative w-full max-w-md overflow-hidden rounded-3xl border-2 border-[#FFD700]/40 bg-gradient-to-b from-[#0a1a2e] to-[#040d24] p-6 shadow-[0_0_60px_rgba(255,215,0,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top glow line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#FFD700] to-transparent" />

        <h2 className="text-2xl font-black text-[#f5ff3b] text-center">
          <IconTarget size={24} className="mb-1 mr-2 inline" /> Hand {roundNumber} Results
        </h2>

        {/* ── Winner banner ─────────────────────────────────────────── */}
        {winner ? (
          <div className="mt-4 rounded-2xl border border-[#FFD700]/40 bg-[#FFD700]/10 p-4 text-center">
            <p className="inline-flex items-center gap-1.5 text-sm text-[#9dd8ff]">
              <IconTrophy size={16} className="text-[#FFD700]" />
              <span className="font-black text-[#FFD700]">{winner}{youWon ? " (You!)" : ""}</span>{" "}
              {wonByFold ? "wins the hand — last fold before the crash" : "wins the hand — last one standing"}
            </p>
            <p className="text-xs text-[#9dd8ff]/80 mt-1">
              {wonByFold ? (
                <>
                  Folded at <span className="font-bold text-[#00ffa6]">{winnerMultiplier?.toFixed(2)}x</span>
                  {" · "}Pot ${payoutGross.toLocaleString()}
                </>
              ) : (
                <>
                  Everyone else folded {" · "}Pot ${payoutGross.toLocaleString()}
                </>
              )}
            </p>
            <p className="mt-2 text-3xl font-black text-[#00ffa6] drop-shadow-[0_0_16px_rgba(0,255,166,0.6)]">
              +${(payouts[0]?.amount ?? 0).toLocaleString()}
            </p>
            {fee > 0 && (
              <p className="text-[10px] text-[#9dd8ff]/60 mt-1">5% platform fee: ${fee.toLocaleString()}</p>
            )}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-center">
            <p className="inline-flex items-center justify-center gap-2 text-2xl font-black text-red-400">
              <IconBomb size={24} /> No winners!
            </p>
            <p className="text-sm text-[#9dd8ff] mt-1">
              Everyone stayed in and busted at the crash. ${carryOver.toLocaleString()} carries over to the next hand.
            </p>
          </div>
        )}

        {/* ── Ranked payout table ───────────────────────────────────── */}
        {payouts.length > 0 && (
          <div className="mt-4 rounded-2xl border border-[#00e5ff]/25 bg-[#050d1f]/70 p-4">
            <p className="text-xs uppercase tracking-wider text-[#9dd8ff]/60 mb-2">
              Ranked payouts — the later you fold, the bigger your share
            </p>
            <div className="flex flex-col gap-1.5">
              {payouts.map((p) => (
                <div
                  key={p.userId ?? p.name ?? `rank-${p.rank}`}
                  className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${
                    p.userId === you?.userId
                      ? "border border-[#FFD700]/40 bg-[#FFD700]/10"
                      : "bg-white/[0.03]"
                  }`}
                >
                  <span className="flex items-center gap-2 text-[#d8fbff] font-semibold">
                    <span
                      className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${
                        p.rank === 1
                          ? "bg-[#FFD700]/20 text-[#FFD700] border border-[#FFD700]/40"
                          : "bg-[#00e5ff]/10 text-[#00e5ff] border border-[#00e5ff]/30"
                      }`}
                    >
                      {rankLabel(p.rank)}
                    </span>
                    {p.name ?? "Player"}
                    {p.userId === you?.userId ? " (You)" : ""}
                  </span>
                  <span className="font-black text-[#00ffa6] tabular-nums">
                    +${Number(p.amount || 0).toLocaleString()}
                  </span>
                </div>
              ))}
              {bustedPlayers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {bustedPlayers.map((name) => (
                    <span
                      key={`b-${name}`}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20"
                    >
                      {name}: busted — nothing
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Your result ───────────────────────────────────────────── */}
        {you && (
          <div className="mt-3 rounded-2xl border border-[#00e5ff]/25 bg-[#050d1f]/70 p-4">
            <p className="text-xs uppercase tracking-wider text-[#9dd8ff]/60 mb-2">Your Result</p>
            {youWon ? (
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#d8fbff] font-bold">
                  <IconTrophy size={16} className="mr-1 inline text-[#FFD700]" /> Rank {myRank} — you won the hand
                </span>
                <span className="text-lg font-black text-[#00ffa6]">
                  +${net.toLocaleString()} net
                </span>
              </div>
            ) : myPayout > 0 ? (
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-sm text-[#d8fbff] font-bold">
                  <IconFlag size={15} className="text-yellow-400" /> Rank {myRank} — you folded
                </span>
                <span className="text-lg font-black text-[#00ffa6]">
                  +${net.toLocaleString()} net
                </span>
              </div>
            ) : youFolded ? (
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-sm text-[#d8fbff] font-bold">
                  <IconFlag size={15} className="text-yellow-400" /> You folded
                </span>
                <span className="text-lg font-black text-red-400">
                  −${youCommitted.toLocaleString()}
                </span>
              </div>
            ) : youBusted ? (
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-sm text-[#d8fbff] font-bold">
                  <IconBomb size={15} className="text-red-400" /> You busted at the crash
                </span>
                <span className="text-lg font-black text-red-400">−${youCommitted.toLocaleString()}</span>
              </div>
            ) : (
              <p className="text-sm text-[#9dd8ff]">You weren&apos;t in this hand.</p>
            )}
            {myPayout > 0 && (
              <p className="text-xs text-[#00ffa6]/80 mt-2">
                Your ${youCommitted.toLocaleString()} ante returned ${myPayout.toLocaleString()} from the pot —{" "}
                <strong>{net >= 0 ? "+" : ""}{net.toLocaleString()}</strong> net <IconConfetti size={14} className="mb-0.5 ml-0.5 inline text-[#00ffa6]" />
              </p>
            )}
            {!youWon && myPayout === 0 && (youFolded || youBusted) && (
              <p className="text-xs text-[#9dd8ff]/60 mt-2">
                Fold earlier and you lose only your ante — fold later to climb the ranks.
              </p>
            )}
          </div>
        )}

        {/* ── Next hand + auto-dismiss progress ─────────────────────── */}
        <div className="mt-5">
          <button
            onClick={onNextRound}
            className="w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.4)] hover:shadow-[0_0_35px_rgba(0,229,255,0.7)] hover:scale-[1.02] transition-all duration-300"
          >
            Next Hand → ({remaining}s)
          </button>
          <div className="mt-2 h-1 rounded-full bg-[#00e5ff]/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] transition-all duration-1000 ease-linear"
              style={{ width: `${(remaining / 8) * 100}%` }}
            />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}