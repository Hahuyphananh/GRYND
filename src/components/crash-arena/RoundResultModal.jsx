"use client";
import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { IconBomb, IconConfetti, IconFlag, IconTarget, IconTrophy } from "@tabler/icons-react";

/**
 * RoundResultModal — shown when a Crash Poker hand ends. Displays the
 * player's own result (folded / busted / won the pot) plus who won and by
 * how much, then advances to the next hand (manual button or auto-dismiss).
 *
 * Winner semantics (fold-order / pot rules):
 *   • fold-out — exactly one player was still active when everyone else
 *     folded; they win the whole pot ("last player standing").
 *   • crash with 2+ active — the latest successful fold before the crash
 *     wins the whole pot; everyone still active busted.
 *   • nobody folded and 2+ active at the crash — no winner; the pot
 *     carries over to the next hand.
 *
 * Rendered conditionally by ArenaTable:
 *   {phase === "settling" && results && <RoundResultModal ... />}
 *
 * Props:
 *   roundNumber — number of the hand that just ended
 *   results     — roundState.results from settleRound
 *   you         — the current player object (from roundState.players) or null
 *   wager       — table wager / big blind (used to show net profit / loss)
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
  const payout = results?.payout ?? 0;
  const fee = results?.fee ?? 0;
  const payoutGross = results?.payoutGross ?? payout + fee;
  const carryOver = results?.winner === null ? (results?.carryOver ?? pot) : 0;
  // The crash caught 2+ active players (true) vs a fold-out (false) — used
  // to word the winner banner correctly.
  const crashedWithActive = Array.isArray(results?.activeAtCrash)
    ? results.activeAtCrash.length > 0
    : false;
  // Fold-order win: the winner folded before the crash and outlasted every
  // other folder (server marks winnerMultiplier = their fold checkpoint).
  const wonByFold = Boolean(results?.wonByFold);

  const youWon = winner !== null && you?.name === winner;
  const youFolded = you?.folded && !youWon;
  const youBusted = you?.busted && !youWon;
  const youCommitted = you?.contributed ?? (you ? wager : 0);
  const net = payout - youCommitted;
  const foldedPlayers = Array.isArray(results?.foldedPlayers) ? results.foldedPlayers : [];
  const bustedPlayers = Array.isArray(results?.bustedPlayers) ? results.bustedPlayers : [];

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
              {wonByFold ? "wins the pot — the last fold before the crash" : "wins the pot — everyone else folded"}
            </p>
            <p className="text-xs text-[#9dd8ff]/80 mt-1">
              {wonByFold ? (
                <>
                  Folded at <span className="font-bold text-[#00ffa6]">{winnerMultiplier?.toFixed(2)}x</span>
                  {" · "}Pot ${payoutGross.toLocaleString()}
                </>
              ) : (
                <>
                  Last player standing at{" "}
                  <span className="font-bold text-[#00ffa6]">{winnerMultiplier?.toFixed(2)}x</span>
                  {" · "}Pot ${payoutGross.toLocaleString()}
                </>
              )}
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
              Everyone stayed in and busted at the crash. ${carryOver.toLocaleString()} carries over to the next hand.
            </p>
          </div>
        )}

        {/* ── Your result ───────────────────────────────────────────── */}
        {you && (
          <div className="mt-4 rounded-2xl border border-[#00e5ff]/25 bg-[#050d1f]/70 p-4">
            <p className="text-xs uppercase tracking-wider text-[#9dd8ff]/60 mb-2">Your Result</p>
            {youWon ? (
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#d8fbff] font-bold">
                  <IconTrophy size={16} className="mr-1 inline text-[#FFD700]" /> You won the pot
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
            {youWon && (
              <p className="text-xs text-[#00ffa6]/80 mt-2">
                Pot ${payoutGross.toLocaleString()} minus your ${youCommitted.toLocaleString()} committed ={" "}
                <strong>+${net.toLocaleString()}</strong> profit <IconConfetti size={14} className="mb-0.5 ml-0.5 inline text-[#00ffa6]" />
              </p>
            )}
            {!youWon && (youFolded || youBusted) && (
              <p className="text-xs text-[#9dd8ff]/60 mt-2">
                Folders and busted players keep only what they already put in the pot.
              </p>
            )}
          </div>
        )}

        {/* ── Everyone else (with their fold checkpoints) ───────────── */}
        {(foldedPlayers.length > 0 || bustedPlayers.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-1.5 justify-center">
            {foldedPlayers.map((fp) => (
              <span
                key={`f-${fp?.name ?? fp}`}
                className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
              >
                {fp?.name ?? fp}
                {fp?.at != null && `: folded @${Number(fp.at).toFixed(2)}x`}
              </span>
            ))}
            {bustedPlayers.map((name) => (
              <span
                key={`b-${name}`}
                className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20"
              >
                {name}: busted
              </span>
            ))}
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
