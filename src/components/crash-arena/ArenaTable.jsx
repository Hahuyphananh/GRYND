"use client";
import React, { useState, useCallback, useMemo } from "react";
import PlayerList from "./PlayerList";
import PotDisplay from "./PotDisplay";
import TableBalance from "./TableBalance";
import RoundTimer from "./RoundTimer";
import RoundStatus from "./RoundStatus";
import BuyInModal from "./BuyInModal";
import CashoutButton from "../games/crash-engine/CashoutButton";
import Link from "next/link";

/**
 * ArenaTable — full poker-style Crash Arena table room.
 *
 * Driven by roundState from useCrashArenaRound.
 *
 * Props:
 *   table             — base table info (name, wager, minBuyIn, maxBuyIn, maxPlayers)
 *   roundState        — { phase, pot, crashPoint, roundNumber, players, results }
 *   crashEngineRef    — ref to CrashEngine for cashout()
 *   onStartRound      — () => void
 *   onNextRound       — () => void
 *   onToggleSitOut    — (playerName) => void
 *   onJoin            — (buyInAmount) => void
 *   onLeave           — () => void
 *   onBuyChips        — (amount) => void
 *   playerName        — "You"
 *   busy              — whether an API call is in flight
 *   children          — CrashEngine
 */
export default function ArenaTable({
  table,
  roundState,
  crashEngineRef,
  onStartRound,
  onNextRound,
  onToggleSitOut,
  onJoin,
  onLeave,
  onBuyChips,
  playerName = "You",
  busy = false,
  children,
}) {
  const {
    name = "Crash Arena",
    wager,
    minBuyIn,
    maxBuyIn,
    maxPlayers = 6,
  } = table;

  const {
    phase = "waiting",
    pot = 0,
    roundNumber = 1,
    players = [],
    results = null,
    crashMultiplier = null,
    crashPoint = null,
  } = roundState;

  // Current player lookup
  const currentPlayer = players.find((p) => p.name === playerName && p.isYou) || null;
  const isSeated = !!currentPlayer;
  const isSittingOut = currentPlayer?.isSittingOut || false;
  const playerChips = currentPlayer?.balance || 0;
  const isFull = players.length >= maxPlayers;
  const youCashedOut = currentPlayer?.cashoutMultiplier != null;
  const youBusted = currentPlayer?.busted || false;

  const isRunning = phase === "running";
  const isCrashed = phase === "crashed" || phase === "settling";
  const isWaiting = phase === "waiting";

  const [showBuyInModal, setShowBuyInModal] = useState(false);

  // Map phase to RoundStatus display
  const displayStatus = isRunning ? "flying" : isCrashed ? "crashed" : "waiting";

  const handleTimerExpire = useCallback(() => {
    onStartRound?.();
  }, [onStartRound]);

  // ── Live cashout feed (during running) ───────────────────────────────

  const liveCashouts = useMemo(() => {
    if (!isRunning) return [];
    return players
      .filter((p) => p.isPlaying && !p.isSittingOut && (p.cashoutMultiplier != null || p.busted))
      .sort((a, b) => (b.cashoutMultiplier || 0) - (a.cashoutMultiplier || 0));
  }, [players, isRunning]);

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* ═══ Top bar: status + timer + pot ═══ */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/60 backdrop-blur-sm">
        <RoundStatus
          status={displayStatus}
          roundNumber={roundNumber}
          crashedAt={crashMultiplier}
        />
        {isWaiting && (
          <RoundTimer
            seconds={15}
            isRunning={true}
            onExpire={handleTimerExpire}
          />
        )}
        {isRunning && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#00e5ff]/10 border border-[#00e5ff]/20">
            <span className="text-xs text-[#9dd8ff]">Crash at</span>
            <span className="text-sm font-black text-[#00e5ff]">{crashPoint?.toFixed(2)}x</span>
          </div>
        )}
        <PotDisplay pot={pot} />
      </div>

      {/* ═══ Round results banner (settling phase) ═══ */}
      {phase === "settling" && results && (
        <div className="px-4 py-3 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/5 text-center animate-in fade-in">
          {results.winner ? (
            <>
              <span className="text-lg font-black text-[#FFD700]">
                🏆 {results.winner}
                {results.winner === playerName ? " (You!)" : ""} wins!
              </span>
              <span className="block text-sm text-[#d8fbff] mt-1">
                Cashed out at {results.winnerMultiplier?.toFixed(2)}x
              </span>
              <span className="block text-sm text-[#00ffa6] mt-1">
                +${results.payout?.toLocaleString()} • Fee: ${results.fee?.toLocaleString() || 0}
              </span>
            </>
          ) : (
            <>
              <span className="text-lg font-black text-red-400">
                💥 No winners! Pot carries over.
              </span>
              <span className="block text-sm text-[#9dd8ff] mt-1">
                ${pot.toLocaleString()} added to next round
              </span>
            </>
          )}
          {/* All cashouts */}
          {results.allCashouts?.length > 0 && (
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {results.allCashouts.map((c) => (
                <span key={c.name} className="text-xs px-2 py-0.5 rounded-full bg-[#00e5ff]/10 text-[#00e5ff] border border-[#00e5ff]/20">
                  {c.name}: {c.multiplier.toFixed(2)}x
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ Table info bar ═══ */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4">
        <div>
          <span className="text-xs text-[#9dd8ff]/60 uppercase tracking-wider">Table</span>
          <div className="text-lg font-black text-[#FFD700]">{name}</div>
          <div className="flex gap-4 mt-1">
            <span className="text-xs text-[#9dd8ff]/60">
              Wager: <span className="text-[#d8fbff] font-bold">${wager}</span>
            </span>
            <span className="text-xs text-[#9dd8ff]/60">
              Min buy-in: <span className="text-[#d8fbff] font-bold">${minBuyIn}</span>
            </span>
            {crashPoint && isCrashed && (
              <span className="text-xs text-[#9dd8ff]/60">
                Crashed at: <span className="text-red-400 font-bold">{crashMultiplier?.toFixed(2)}x</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isSeated && <TableBalance balance={playerChips} />}

          {/* Not seated */}
          {!isSeated && !isFull && (
            <button
              onClick={() => setShowBuyInModal(true)}
              className="px-4 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff] shadow-[0_0_14px_rgba(0,229,255,0.4)] hover:shadow-[0_0_24px_rgba(0,229,255,0.7)] hover:scale-105 transition-all duration-300"
            >
              Join Table
            </button>
          )}

          {/* Seated */}
          {isSeated && (
            <>
              {/* Buy chips (only in waiting) */}
              {isWaiting && (
                <button
                  onClick={() => setShowBuyInModal(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[#00ffa6]/30 bg-[#00ffa6]/10 text-[#00ffa6] hover:bg-[#00ffa6]/20 transition-all"
                >
                  + Buy Chips
                </button>
              )}

              {/* Sit out / Play next toggle */}
              {isWaiting && (
                isSittingOut ? (
                  <button
                    onClick={() => onToggleSitOut?.(playerName)}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[#00e5ff]/30 bg-[#00e5ff]/10 text-[#00e5ff] hover:bg-[#00e5ff]/20 transition-all"
                  >
                    Play Next
                  </button>
                ) : (
                  <button
                    onClick={() => onToggleSitOut?.(playerName)}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 transition-all"
                  >
                    Sit Out
                  </button>
                )
              )}

              {/* Start round button */}
              {isWaiting && (
                <button
                  onClick={onStartRound}
                  disabled={busy}
                  className="px-4 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-black border border-[#FFD700] shadow-[0_0_14px_rgba(255,215,0,0.4)] hover:shadow-[0_0_24px_rgba(255,215,0,0.7)] hover:scale-105 transition-all duration-300 disabled:opacity-50 disabled:hover:scale-100"
                >
                  {busy ? "Starting…" : "Start Round"}
                </button>
              )}

              {/* Cashout button during running */}
              {isRunning && !youCashedOut && !youBusted && isSeated && !isSittingOut && (
                <CashoutButton
                  onCashout={() => crashEngineRef?.current?.cashout()}
                />
              )}

              {/* Next round after settling */}
              {phase === "settling" && (
                <button
                  onClick={onNextRound}
                  className="px-4 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff] shadow-[0_0_14px_rgba(0,229,255,0.4)] hover:shadow-[0_0_24px_rgba(0,229,255,0.7)] hover:scale-105 transition-all duration-300"
                >
                  Next Round →
                </button>
              )}

              {/* Cashout status badges */}
              {youCashedOut && !isRunning && (
                <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#00ffa6]/15 text-[#00ffa6] border border-[#00ffa6]/30">
                  ✅ {currentPlayer.cashoutMultiplier?.toFixed(2)}x
                </span>
              )}
              {youBusted && (
                <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                  💥 Busted
                </span>
              )}

              {/* Leave */}
              {isWaiting && (
                <button
                  onClick={onLeave}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
                >
                  Leave
                </button>
              )}
            </>
          )}

          <Link
            href="/casino/crash-arena"
            className="px-3 py-1.5 rounded-lg text-xs font-bold border border-gray-500/30 text-gray-400 bg-gray-500/10 hover:bg-gray-500/20 transition-all"
          >
            ← Lobby
          </Link>
        </div>
      </div>

      {/* ═══ Game area ═══ */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Main game canvas — hosts CrashEngine */}
        <div className="relative flex-1 rounded-2xl border border-[#00e5ff]/30 bg-[#050d1f]/80 backdrop-blur-xl shadow-[0_0_25px_rgba(0,229,255,0.2)] overflow-hidden flex items-center justify-center"
          style={{ minHeight: 620 }}
        >
          {children || (
            <div className="text-center px-4">
              <p className="text-6xl mb-4">🚀</p>
              <p className="text-lg font-bold text-[#d8fbff]">
                {isRunning
                  ? "In flight!"
                  : isWaiting
                    ? "Ready for next round"
                    : "Round complete"}
              </p>
              {!isSeated && !isRunning && (
                <p className="text-sm text-[#9dd8ff] mt-2">Join the table to play</p>
              )}
            </div>
          )}

          {/* Live cashout overlay during running — shows on top of CrashEngine */}
          {isRunning && liveCashouts.length > 0 && (
            <div className="absolute top-3 left-3 z-20 flex flex-col gap-1 max-w-[180px]">
              {liveCashouts.map((p) => (
                <div
                  key={p.name}
                  className={`text-xs px-2 py-1 rounded-lg font-bold backdrop-blur-sm transition-all duration-300 ${
                    p.busted
                      ? "bg-red-500/20 text-red-400 border border-red-500/30"
                      : "bg-[#00ffa6]/20 text-[#00ffa6] border border-[#00ffa6]/30"
                  }`}
                >
                  {p.name}{p.isYou ? " (You)" : ""}: {p.busted ? "💥 Busted" : `${p.cashoutMultiplier?.toFixed(2)}x`}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sidebar: live standings during round */}
        {isRunning && (
          <div className="w-full lg:w-48 shrink-0 rounded-2xl border border-[#ff4fd8]/20 bg-[#040d24]/60 backdrop-blur-sm p-3 flex flex-col gap-2">
            <h3 className="text-xs uppercase tracking-wider text-[#ff4fd8]/70 text-center">
              Live Standings
            </h3>
            {players
              .filter((p) => p.isPlaying && !p.isSittingOut)
              .map((p) => (
                <div
                  key={p.name}
                  className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-xs transition-all duration-300 ${
                    p.busted
                      ? "bg-red-500/10 border border-red-500/20"
                      : p.cashoutMultiplier != null
                        ? "bg-[#00ffa6]/10 border border-[#00ffa6]/20"
                        : "bg-[#00e5ff]/5 border border-[#00e5ff]/10"
                  }`}
                >
                  <span className={`truncate font-semibold ${
                    p.busted ? "text-red-400" : p.cashoutMultiplier != null ? "text-[#00ffa6]" : "text-[#d8fbff]"
                  }`}>
                    {p.name}{p.isYou ? " (You)" : ""}
                  </span>
                  <span className={`font-bold tabular-nums shrink-0 ${
                    p.busted ? "text-red-400" : p.cashoutMultiplier != null ? "text-[#00ffa6]" : "text-[#9dd8ff]"
                  }`}>
                    {p.busted ? "💥" : p.cashoutMultiplier != null ? `${p.cashoutMultiplier.toFixed(2)}x` : "..."}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* ═══ Player list ═══ */}
      <div className="px-4 py-3 rounded-2xl border border-[#ff4fd8]/25 bg-[#040d24]/60 backdrop-blur-sm">
        <h3 className="text-xs uppercase tracking-wider text-[#ff4fd8]/70 mb-3 text-center">
          Players &bull; {players.length}/{maxPlayers}
        </h3>
        <PlayerList players={players} maxSeats={maxPlayers} phase={phase} />
      </div>

      {/* ═══ Buy-in modal ═══ */}
      {showBuyInModal && (
        <BuyInModal
          table={{ wager, minBuyIn, maxBuyIn }}
          onBuyIn={(amount) => {
            if (isSeated) {
              onBuyChips?.(amount);
            } else {
              onJoin?.(amount);
            }
            setShowBuyInModal(false);
          }}
          onClose={() => setShowBuyInModal(false)}
        />
      )}
    </div>
  );
}
