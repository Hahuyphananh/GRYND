"use client";
import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { IconBomb, IconCircleCheck, IconConfetti, IconTarget, IconTrophy } from "@tabler/icons-react";

/**
 * RoundResultModal — shown when a round ends. Displays the player's own
 * result (cashed-out multiplier or bust) plus who won the pot and by how
 * much, then advances to the next round (manual button or auto-dismiss).
 *
 * Rendered conditionally by ArenaTable:
 *   {phase === "settling" && results && <RoundResultModal ... />}
 *
 * Props:
 *   roundNumber — number of the round that just ended
 *   results     — roundState.results from settleRound
 *   you         — the current player object (from roundState.players) or null
 *   wager       — table wager (used to show net profit / loss)
 *   pot         — the round pot (used for the carry-over message)
 *   onNextRound — () => void — dismiss + advance to the next round
 */
export default function RoundResultModal({
  roundNumber = 1,
  results,
  you = null,
  wager = 0,
  pot = 0,
  onNextRound,
}) {
  // Auto-dismiss after 8 seconds so rounds keep flowing.
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
  const payout = results?.payout ?? 0;
  const fee = results?.fee ?? 0;
  const carryOver = results?.winner === null ? pot : 0;

  const youCashedOut = you?.cashoutMultiplier != null && !you?.busted;
  const youBusted = you?.busted;
  const youWon = winner !== null && you?.name === winner;
  const youCashout = you?.cashoutMultiplier ?? null;
  const net = payout - wager;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      role="dialog"
      aria-modal="true"
      aria-label="Round results"
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
          <IconTarget size={24} className="mb-1 mr-2 inline" /> Round {roundNumber} Results
        </h2>

        {/* ── Winner banner ─────────────────────────────────────────── */}
        {winner ? (
          <div className="mt-4 rounded-2xl border border-[#FFD700]/40 bg-[#FFD700]/10 p-4 text-center">
            <p className="inline-flex items-center gap-1.5 text-sm text-[#9dd8ff]">
              <IconTrophy size={16} className="text-[#FFD700]" />
              <span className="font-black text-[#FFD700]">{winner}{youWon ? " (You!)" : ""}</span>{" "}
              wins the pot
            </p>
            <p className="text-xs text-[#9dd8ff]/80 mt-1">
              Cashed out at{" "}
              <span className="font-bold text-[#00ffa6]">{winnerMultiplier?.toFixed(2)}x</span> • Pot $
              {(payout + fee).toLocaleString()}
            </p>
            <p className="mt-2 text-3xl font-black text-[#00ffa6] drop-shadow-[0_0_16px_rgba(0,255,166,0.6)]">
              +${payout.toLocaleString()}
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
              Everyone busted — ${carryOver.toLocaleString()} carries over to the next round.
            </p>
          </div>
        )}

        {/* ── Your result ───────────────────────────────────────────── */}
        {you && (
          <div className="mt-4 rounded-2xl border border-[#00e5ff]/25 bg-[#050d1f]/70 p-4">
            <p className="text-xs uppercase tracking-wider text-[#9dd8ff]/60 mb-2">Your Result</p>
            {youCashedOut ? (
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#d8fbff] font-bold">
                  <IconCircleCheck size={16} className="mr-1 inline text-[#00ffa6]" /> Cashed out at <span className="text-[#00ffa6]">{youCashout.toFixed(2)}x</span>
                </span>
                <span className={`text-lg font-black ${youWon ? "text-[#00ffa6]" : "text-red-400"}`}>
                  {youWon ? `+$${net.toLocaleString()} net` : `−$${wager.toLocaleString()}`}
                </span>
              </div>
            ) : youBusted ? (
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-sm text-[#d8fbff] font-bold">
                  <IconBomb size={15} className="text-red-400" /> You busted
                </span>
                <span className="text-lg font-black text-red-400">−${wager.toLocaleString()}</span>
              </div>
            ) : (
              <p className="text-sm text-[#9dd8ff]">You weren&apos;t in this round.</p>
            )}
            {youWon && (
              <p className="text-xs text-[#00ffa6]/80 mt-2">
                Pot ${(payout + fee).toLocaleString()} minus your ${wager.toLocaleString()} wager ={" "}
                <strong>+${net.toLocaleString()}</strong> profit <IconConfetti size={14} className="mb-0.5 ml-0.5 inline text-[#00ffa6]" />
              </p>
            )}
            {!youWon && youCashedOut && (
              <p className="text-xs text-[#9dd8ff]/60 mt-2">
                Survived, but only the highest cashout takes the pot.
              </p>
            )}
          </div>
        )}

        {/* ── All cashouts ──────────────────────────────────────────── */}
        {results?.allCashouts?.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 justify-center">
            {results.allCashouts.map((c) => (
              <span
                key={c.name}
                className="text-[10px] px-2 py-0.5 rounded-full bg-[#00e5ff]/10 text-[#00e5ff] border border-[#00e5ff]/20"
              >
                {c.name}: {c.multiplier.toFixed(2)}x
              </span>
            ))}
          </div>
        )}

        {/* ── Next round + auto-dismiss progress ────────────────────── */}
        <div className="mt-5">
          <button
            onClick={onNextRound}
            className="w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.4)] hover:shadow-[0_0_35px_rgba(0,229,255,0.7)] hover:scale-[1.02] transition-all duration-300"
          >
            Next Round → ({remaining}s)
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
