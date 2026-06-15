"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useHexDuel, type DuelPlayer } from "../../../lib/hexDuelEngine";
import { useSocket } from "../../../context/SocketProvider";
import { decideAIAction, type AIDifficulty, type AIAction, type AIStateSnapshot } from "../../../lib/hexDuelAI";
import { useHexAudio } from "../../../lib/hexAudio";
import { useChessClock } from "../../../lib/useChessClock";
import HexBoard from "../../../components/HexBoard";
import HexParticles from "../../../components/HexParticles";
import HexActionPanel, { type ActionType } from "../../../components/HexActionPanel";
import HexActionLog from "../../../components/HexActionLog";
import NavigationBar from "../../../components/navigation-bar";
import ReportModal from "../../../components/ReportModal";

const ATTACK_COST = 1;
const DISPLACE_COST = 1;
const MOVE_COST = 1; // backward compat

// ══════════════════════════════════════════════════════════════════════════
//  CSS Keyframes (injected once)
// ══════════════════════════════════════════════════════════════════════════

const GLOBAL_KEYFRAMES = `
@keyframes victoryFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes victoryPopIn { from { opacity: 0; transform: scale(0.8) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes victoryGlowPulse {
  0%, 100% { box-shadow: 0 0 20px var(--glow-color); }
  50%      { box-shadow: 0 0 60px var(--glow-color), 0 0 100px var(--glow-color); }
}
@keyframes victoryBorderSpin {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@keyframes headerGlow {
  0%, 100% { filter: drop-shadow(0 0 8px rgba(34,211,238,0.4)) drop-shadow(0 0 20px rgba(168,85,247,0.3)); }
  50%      { filter: drop-shadow(0 0 14px rgba(34,211,238,0.7)) drop-shadow(0 0 30px rgba(168,85,247,0.5)); }
}
@keyframes turnSlideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes statCounter {
  0%   { transform: scale(1); }
  50%  { transform: scale(1.12); color: var(--bump-color, #fff); }
  100% { transform: scale(1); }
}
@keyframes payoutReveal {
  from { opacity: 0; transform: scale(0.5) translateY(20px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes confettiDrop {
  0%   { transform: translateY(-100%) rotate(0deg); opacity: 1; }
  100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
}
@keyframes floatUp {
  0%   { opacity: 0; transform: translateY(8px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes hexCapture {
  0%   { opacity: 1; transform: scale(0.92); filter: brightness(1.4); }
  30%  { opacity: 1; transform: scale(1.08); filter: brightness(1.6); }
  100% { opacity: 0; transform: scale(1); filter: brightness(1); }
}
@keyframes hexPushArrive {
  0%   { transform: scale(0.5); opacity: 0.2; filter: brightness(2); }
  40%  { transform: scale(1.18); opacity: 1; filter: brightness(1.3); }
  70%  { transform: scale(0.95); }
  100% { transform: scale(1); opacity: 1; filter: brightness(1); }
}
@keyframes hexRipple {
  0%   { width: 4px; height: 4px; opacity: 0.9; }
  100% { width: 100px; height: 100px; opacity: 0; }
}
@keyframes hexAuraPulse {
  0%, 100% { opacity: 0.25; transform: scale(1); filter: brightness(1); }
  50%      { opacity: 0.55; transform: scale(1.12); filter: brightness(1.15); }
}
@keyframes powerNodePulse {
  0%, 100% { opacity: 0.3; transform: scale(1); filter: brightness(1); }
  33%      { opacity: 0.6; transform: scale(1.08); filter: brightness(1.2); }
  66%      { opacity: 0.4; transform: scale(0.96); filter: brightness(0.9); }
}
@keyframes validPulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50%      { opacity: 0.8; transform: scale(1.03); }
}
@keyframes pushPulse {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50%      { opacity: 0.7; transform: scale(1.04); }
}
@keyframes cornerPulse {
  0%, 100% { border-color: rgba(34,211,238,0.4); }
  50%      { border-color: rgba(34,211,238,0.8); }
}    @keyframes territoryFill {
  0%   { opacity: 0; transform: scale(0.85); }
  50%  { opacity: 0.3; transform: scale(1.05); }
  100% { opacity: 0; transform: scale(1); }
}

@keyframes troopBarGlow {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}

@keyframes connectionPulse {
  0%, 100% { opacity: 0.95; }
  50%      { opacity: 0.7; }
}

@keyframes waitingSpin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

@keyframes waitingPulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 0.8; }
}

@keyframes waitingFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
`;

// ══════════════════════════════════════════════════════════════════════════
//  AP Pip
// ══════════════════════════════════════════════════════════════════════════

function APPips({ current, max, color, bonusCount }: { current: number; max: number; color: string; bonusCount?: number }) {
  const baseMax = max - (bonusCount ?? 0);
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: max }, (_, i) => {
        const isBonus = i >= baseMax;
        const pipColor = isBonus ? "#a855f7" : color;
        const active = i < current;
        return (
          <span
            key={i}
            className="inline-block w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full transition-all duration-300"
            style={{
              backgroundColor: active ? pipColor : "transparent",
              border: `1.5px solid ${active ? pipColor : "#334155"}`,
              boxShadow: active ? `0 0 8px ${pipColor}66, 0 0 3px ${pipColor}44` : "none",
            }}
          />
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Wager Modal
// ══════════════════════════════════════════════════════════════════════════

import { CHIP_VALUES } from "../../../lib/rouletteConfig";

function WagerModal({
  balance, onStartFun, onStartReal, loading, error, isSignedIn, onCreateMultiplayer, onJoinMultiplayer,
  onQuickJoinMultiplayer, onRefreshGames, multiplayerGames, multiplayerLoading,
}: {
  balance: number; onStartFun: () => void; onStartReal: (w: number) => void;
  loading: boolean; error: string | null; isSignedIn: boolean;
  onCreateMultiplayer: (w: number) => void; onJoinMultiplayer: (gameId: number) => void;
  onQuickJoinMultiplayer: () => void; onRefreshGames: () => void;
  multiplayerGames: Array<{ id: number; wagerAmount: string | number; hostName?: string | null }>;
  multiplayerLoading: boolean;
}) {
  const [wager, setWager] = useState(50);
  const [playForFun, setPlayForFun] = useState(false);
  const [queueMode, setQueueMode] = useState<"ai" | "multiplayer">("ai");
  const canAfford = wager > 0 && wager <= balance;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Place Wager">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 p-4 sm:p-6
          bg-gradient-to-b from-[#071230] via-[#0a1a3f] to-[#050d24] overflow-y-auto max-h-[90vh]
          shadow-[0_0_60px_rgba(34,211,238,0.1)]"
        style={{ animation: "floatUp 0.35s ease-out" }}
      >
        <div className="flex items-center justify-between mb-1">
          <a
            href="/casino"
            className="text-[10px] text-slate-500 hover:text-slate-300 transition flex items-center gap-1"
          >
            <span className="text-xs">←</span> Back to Casino
          </a>
        </div>
        <h2 className="text-center text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-fuchsia-400 mb-1">
          HEX DUEL
        </h2>
        <p className="text-center text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-4">Place Your Wager</p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button onClick={() => setQueueMode("ai")} className={`rounded-lg py-2 text-[11px] font-semibold transition ${queueMode === "ai" ? "border border-white/20 bg-white/[0.1] text-white" : "border border-white/15 bg-white/[0.02] text-slate-200 hover:bg-white/[0.06]"}`}>Play vs AI</button>
          <button onClick={() => setQueueMode("multiplayer")} className={`rounded-lg py-2 text-[11px] font-semibold transition ${queueMode === "multiplayer" ? "border border-cyan-400/50 bg-cyan-500/20 text-cyan-100" : "border border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"}`}>Create Game</button>
        </div>

        <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Available Games</p>
            <div className="flex items-center gap-1.5">
              <button onClick={onRefreshGames} className="rounded border border-white/15 px-2 py-0.5 text-[10px] text-slate-300 hover:text-white">Refresh</button>
              <button onClick={onQuickJoinMultiplayer} className="rounded border border-cyan-400/30 px-2 py-0.5 text-[10px] text-cyan-300 hover:bg-cyan-500/20">Quick Join</button>
            </div>
          </div>
          <div className="max-h-36 space-y-2 overflow-y-auto pr-1">
            {multiplayerLoading ? (
              <p className="text-[11px] text-slate-400">Loading games…</p>
            ) : multiplayerGames.length === 0 ? (
              <p className="text-[11px] text-slate-500">No open games yet.</p>
            ) : multiplayerGames.map((game) => (
              <div key={game.id} className="flex items-center justify-between rounded-md border border-white/10 px-2 py-1.5">
                <span className="text-[11px] text-slate-300">#{game.id} · {game.hostName || "Player"} · {Number(game.wagerAmount).toFixed(2)} tokens</span>
                <button onClick={() => onJoinMultiplayer(game.id)} className="rounded border border-cyan-400/40 px-2 py-0.5 text-[10px] text-cyan-300 hover:bg-cyan-500/20">
                  Join
                </button>
              </div>
            ))}
          </div>
        </div>

        {isSignedIn ? (
          <div className="mb-5 text-center">
            <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Your Balance</p>
            <p className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500">
              {balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-slate-500">tokens</p>
          </div>
        ) : (
          <div className="mb-5 text-center p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <p className="text-xs text-amber-300 font-medium">Sign in to wager real tokens</p>
            <p className="text-[10px] text-slate-400 mt-1">You can still play for fun!</p>
          </div>
        )}

        {!playForFun && (
          <div className="mb-4">
            <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 block">Wager Amount</label>
            <input
              type="number" value={wager} min={1} max={balance}
              onChange={(e) => setWager(Number(e.target.value) || 0)}
              className="w-full rounded-lg bg-[#020617] border border-white/15 px-3 py-2 text-white text-sm
                focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none transition mb-3"
              placeholder="Enter wager..."
            />
            <div className="flex gap-1.5">
              {CHIP_VALUES.map((amount) => (
                <button
                  key={amount}
                  onClick={() => setWager(amount)}
                  className={`flex-1 rounded-md py-1.5 text-[10px] font-bold transition-all duration-150 border ${
                    wager === amount
                      ? "bg-cyan-500/20 text-cyan-300 border-cyan-400/50 shadow-[0_0_8px_rgba(34,211,238,0.2)]"
                      : "bg-white/[0.03] text-slate-400 border-white/10 hover:border-white/20 hover:text-white"
                  }`}
                >{amount}</button>
              ))}
            </div>
            {!canAfford && wager > 0 && (
              <p className="text-[10px] text-red-400 mt-2 font-medium">Insufficient balance — you need {wager} tokens</p>
            )}
          </div>
        )}

        <div className="mb-5 flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/10 p-3">
          <div>
            <p className="text-xs font-bold text-slate-300">Play for Fun</p>
            <p className="text-[10px] text-slate-500">No real tokens used</p>
          </div>
          <button
            onClick={() => setPlayForFun(!playForFun)}
            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${playForFun ? "bg-purple-500" : "bg-slate-700"}`}
            role="switch" aria-checked={playForFun}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${playForFun ? "translate-x-5" : "translate-x-0"}`} />
          </button>
        </div>

        {error && (
          <p className="mb-4 text-center text-[11px] text-red-400 font-medium bg-red-500/10 rounded-lg py-2 px-3">{error}</p>
        )}

        <button
          onClick={() => {
            if (queueMode === "multiplayer") return onCreateMultiplayer(playForFun ? 0 : wager);
            return playForFun ? onStartFun() : onStartReal(wager);
          }}
          disabled={loading || (!playForFun && !canAfford)}
          className="w-full rounded-xl py-3 text-sm font-bold uppercase tracking-[0.15em] transition-all duration-200
            bg-gradient-to-r from-cyan-500 to-blue-600 text-white
            shadow-[0_0_20px_rgba(34,211,238,0.3)]
            hover:shadow-[0_0_30px_rgba(34,211,238,0.5)] hover:scale-[1.02]
            active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="inline-block w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              Processing...
            </span>
          ) : queueMode === "multiplayer"
            ? (playForFun ? "🌐 Create Multiplayer (Fun)" : `🌐 Wager ${wager} Tokens (Multiplayer)`)
            : (playForFun ? "🎮 Play for Fun" : `💰 Wager ${wager} Tokens vs AI`)}
        </button>

        <p className="mt-3 text-center text-[9px] text-slate-600">
          Winner receives {playForFun ? "bragging rights" : "1.9× payout"}
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Resign Confirmation Modal
// ══════════════════════════════════════════════════════════════════════════

function ResignConfirmation({
  gameMode, onConfirm, onCancel,
}: {
  gameMode: GameMode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Confirm Resign">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" style={{ animation: "victoryFadeIn 0.3s ease-out" }} />
      <div
        className="relative z-10 w-full max-w-sm rounded-2xl p-6 text-center
          bg-gradient-to-b from-[#071230] via-[#0a1a3f] to-[#050d24]
          border border-red-500/30 shadow-[0_0_40px_rgba(239,68,68,0.15)]"
        style={{ animation: "victoryPopIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards" }}
      >
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
          <span className="text-3xl">⚠️</span>
        </div>
        <h2 className="mb-2 text-xl font-black text-red-400">Resign?</h2>
        <p className="mb-1 text-sm text-slate-400">
          {gameMode === "multiplayer"
            ? "Your opponent will win the match."
            : "You will forfeit this game."}
        </p>
        {gameMode === "real" && (
          <p className="mb-4 text-[11px] text-yellow-400/80">You will lose your wagered tokens.</p>
        )}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl py-2.5 text-sm font-bold uppercase tracking-[0.12em] border border-white/15 text-slate-300 hover:bg-white/5 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-xl py-2.5 text-sm font-bold uppercase tracking-[0.12em] bg-red-500/80 text-white hover:bg-red-500 transition-all shadow-[0_0_16px_rgba(239,68,68,0.4)]"
          >
            Resign
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Lose Modal
// ══════════════════════════════════════════════════════════════════════════

function LoseModal({
  winnerLabel, winnerColor, winnerMoves, winnerTerritory, payoutInfo, onRestart,
  isMultiplayer,
}: {
  winnerLabel: string; winnerColor: string;
  winnerMoves: number; winnerTerritory: number;
  payoutInfo: { wager: number; payout: number; multiplier: number } | null;
  onRestart: () => void;
  isMultiplayer?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Defeat">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" style={{ animation: "victoryFadeIn 0.4s ease-out" }} />

      <div
        className="relative z-10 w-full max-w-sm rounded-2xl p-8 text-center
          bg-gradient-to-b from-[#071230] via-[#0a1a3f] to-[#050d24]
          shadow-[0_0_80px_rgba(239,68,68,0.15),0_0_30px_rgba(239,68,68,0.08)]"
        style={{
          border: `2px solid ${winnerColor}`,
          animation: "victoryPopIn 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards",
        }}
      >
        {/* Defeat icon */}
        <div
          className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full"
          style={{
            background: `radial-gradient(circle at 40% 35%, ${winnerColor}44, ${winnerColor}11)`,
            boxShadow: `0 0 30px ${winnerColor}44`,
          }}
        >
          <span className="text-4xl" style={{ filter: `drop-shadow(0 0 8px ${winnerColor}66)` }}>💀</span>
        </div>

        <h2 className="mb-1 text-2xl font-black tracking-wider uppercase" style={{ color: winnerColor }}>
          Defeat!
        </h2>
        <p className="mb-4 text-sm text-slate-400">
          {isMultiplayer ? `${winnerLabel} conquered your capital!` : `${winnerLabel} conquered your capital!`}
        </p>

        {/* Stats grid */}
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg bg-white/[0.04] p-4">
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Their Moves</p>
            <p className="text-xl font-black text-white">{winnerMoves}</p>
          </div>
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Their Territory</p>
            <p className="text-xl font-black text-white">{winnerTerritory}</p>
          </div>
        </div>

        {/* Loss message */}
        {payoutInfo && payoutInfo.wager > 0 && (
          <div
            className="mb-5 rounded-lg bg-red-500/10 border border-red-500/30 p-3"
            style={{ animation: "payoutReveal 0.6s cubic-bezier(0.34,1.56,0.64,1) both" }}
          >
            <p className="text-[10px] text-red-400 uppercase tracking-widest mb-1">Lost</p>
            <p className="text-2xl font-black text-red-400">
              -{payoutInfo.wager.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-slate-400 mt-0.5">Better luck next time!</p>
          </div>
        )}

        <button
          onClick={onRestart}
          className="w-full rounded-xl px-6 py-3 text-sm font-bold uppercase tracking-[0.15em]
            transition-all duration-200 hover:scale-105 active:scale-95 border border-white/20 text-slate-300
            hover:bg-white/5"
        >
          Return to Lobby
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Victory Modal (Enhanced with particles, confetti, animated crown)
// ══════════════════════════════════════════════════════════════════════════

function ConfettiPiece({ color, delay, x }: { color: string; delay: number; x: number }) {
  return (
    <div
      className="absolute top-0 pointer-events-none w-2 h-2 rounded-sm"
      style={{
        left: `${x}%`,
        backgroundColor: color,
        animation: `confettiDrop ${1.5 + Math.random() * 1}s ease-in ${delay}s forwards`,
        opacity: 0,
      }}
    />
  );
}

function VictoryModal({
  winner, winnerLabel, winnerColor, winnerMoves, winnerTerritory, payoutInfo, onRestart,
}: {
  winner: DuelPlayer; winnerLabel: string; winnerColor: string;
  winnerMoves: number; winnerTerritory: number;
  payoutInfo: { wager: number; payout: number; multiplier: number } | null;
  onRestart: () => void;
}) {
  const confettiColors = ["#22d3ee", "#a855f7", "#facc15", "#f472b6", "#34d399", "#818cf8"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Victory">
      {/* Animated backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" style={{ animation: "victoryFadeIn 0.4s ease-out" }} />

      {/* Background particles in victory mode */}
      <div className="absolute inset-0 pointer-events-none">
        <HexParticles victory accentColor={winnerColor} />
      </div>

      {/* Confetti */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: 40 }, (_, i) => (
          <ConfettiPiece
            key={i}
            color={confettiColors[i % confettiColors.length]}
            delay={Math.random() * 0.8}
            x={Math.random() * 100}
          />
        ))}
      </div>

      {/* Modal card */}
      <div
        className="relative z-10 w-full max-w-sm rounded-2xl p-8 text-center
          bg-gradient-to-b from-[#071230] via-[#0a1a3f] to-[#050d24]
          shadow-[0_0_80px_rgba(250,204,21,0.2),0_0_30px_rgba(250,204,21,0.1)]"
        style={{
          border: `2px solid ${winnerColor}`,
          animation: "victoryPopIn 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards",
        }}
      >
        {/* Pulsing crown */}
        <div
          className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full transition-all duration-500"
          style={{
            background: `radial-gradient(circle at 40% 35%, ${winnerColor}66, ${winnerColor}22)`,
            boxShadow: `0 0 30px ${winnerColor}66`,
            animation: "victoryGlowPulse 2s ease-in-out infinite",
            ["--glow-color" as any]: `${winnerColor}44`,
          }}
        >
          <span className="text-4xl" style={{ filter: `drop-shadow(0 0 8px ${winnerColor}88)` }}>👑</span>
        </div>

        <h2 className="mb-1 text-2xl font-black tracking-wider uppercase" style={{ color: winnerColor }}>
          {winnerLabel} Wins!
        </h2>
        <p className="mb-4 text-sm text-slate-400">Enemy capital conquered! 🎯</p>

        {/* Stats grid */}
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg bg-white/[0.04] p-4">
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Moves</p>
            <p className="text-xl font-black text-white">{winnerMoves}</p>
          </div>
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Territory</p>
            <p className="text-xl font-black text-white">{winnerTerritory}</p>
          </div>
        </div>

        {/* Payout info — animated reveal */}
        {payoutInfo && (
          <div
            className="mb-5 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3"
            style={{ animation: "payoutReveal 0.6s cubic-bezier(0.34,1.56,0.64,1) both" }}
          >
            <p className="text-[10px] text-yellow-400 uppercase tracking-widest mb-1">Payout</p>
            <p className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500">
              +{payoutInfo.payout.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-slate-400 mt-0.5">{payoutInfo.multiplier}× on {payoutInfo.wager} wagered</p>
          </div>
        )}

        <button
          onClick={onRestart} autoFocus
          className="w-full rounded-xl px-6 py-3 text-sm font-bold uppercase tracking-[0.15em]
            transition-all duration-200 hover:scale-105 active:scale-95 focus:outline-none focus:ring-2 focus:ring-white/50"
          style={{ backgroundColor: winnerColor, color: "#020617", boxShadow: `0 0 20px ${winnerColor}66` }}
        >
          Play Again
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Troop Bar — visual indicator showing total troops with a filled bar
// ══════════════════════════════════════════════════════════════════════════

function TroopBar({ troops, maxTroops, color }: { troops: number; maxTroops: number; color: string }) {
  const fillFraction = maxTroops > 0 ? Math.min(troops / maxTroops, 1) : 0;
  // Cap display at a reasonable max for visual purposes
  const displayMax = Math.max(maxTroops, 1);
  const displayFill = Math.min(troops / displayMax, 1);

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-slate-400 uppercase tracking-widest shrink-0">Troops</span>
      <div className="relative flex-1 h-2.5 overflow-hidden rounded-full bg-slate-800/60">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${Math.max(2, displayFill * 100)}%`,
            background: `linear-gradient(90deg, ${color}88, ${color})`,
            boxShadow: `0 0 8px ${color}44`,
          }}
        />
        {/* Animated shimmer overlay */}
        <div
          className="absolute inset-0 rounded-full opacity-30"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${color}22 50%, transparent 100%)`,
            backgroundSize: "200% 100%",
            animation: "troopBarGlow 2.5s ease-in-out infinite",
          }}
        />
      </div>
      <span className="text-xs font-bold tabular-nums text-white/80 min-w-[2ch] text-right">{troops}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Player Card (Enhanced with glass morphism + turn slide animation)
// ══════════════════════════════════════════════════════════════════════════

function PlayerCard({
  player, label, isActive, isSelected, color, moves, territory, currentAP, maxAP, isWinner, isAI,
  turnJustChanged, totalTroops, maxTroops, clockTime, isLocal,
}: {
  player: DuelPlayer; label: string;
  isActive: boolean; isSelected: boolean; color: string;
  moves: number; territory: number; currentAP: number; maxAP: number;
  isWinner: boolean; isAI?: boolean;
  turnJustChanged: boolean;
  totalTroops: number;
  maxTroops: number;
  clockTime: number;
  isLocal?: boolean;
}) {
  // Use color to determine blue/red styling — local player always blue, opponent always red
  const isBlue = color === "#22d3ee";
  const borderColor = isBlue ? "border-cyan-400" : "border-red-500";
  const glowColor = isBlue
    ? "shadow-[0_0_18px_rgba(34,211,238,0.5)]"
    : "shadow-[0_0_18px_rgba(239,68,68,0.5)]";
  const bgColor = isBlue
    ? "from-cyan-500/20 to-blue-600/10"
    : "from-red-500/20 to-rose-600/10";
  const isClockUrgent = clockTime < 60000;
  const isClockCritical = clockTime < 10000;

  // Format mm:ss
  const totalSec = Math.ceil(clockTime / 1000);
  const clockMin = Math.floor(totalSec / 60);
  const clockSec = totalSec % 60;
  const clockDisplay = `${clockMin}:${clockSec.toString().padStart(2, "0")}`;

  return (
    <div
      className={`
        rounded-xl border-2 p-4 transition-all duration-500
        bg-gradient-to-b ${bgColor} backdrop-blur-sm
        ${isActive ? `${borderColor} ${glowColor}` : "border-white/10 opacity-60"}
        ${isWinner ? "ring-2 ring-yellow-400 scale-[1.02]" : ""}
        ${turnJustChanged ? "animate-[turnSlideIn_0.4s_ease-out]" : ""}
      `}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color }}>{label}</span>
        <div className="flex items-center gap-2">
          {/* Chess clock display */}
          <span
            className={`text-[11px] font-bold tabular-nums ${
              isClockCritical ? "text-red-400 animate-pulse" : isClockUrgent ? "text-yellow-300" : "text-slate-400"
            }`}
          >
            ⏱ {clockDisplay}
          </span>
          {isWinner && (
            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-yellow-400/30 text-yellow-200 border border-yellow-400/60 animate-pulse">
              🏆 WINNER
            </span>
          )}
          {!isWinner && isActive && (
            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-yellow-400/20 text-yellow-300 border border-yellow-400/40 animate-pulse"
              style={{ animation: "turnSlideIn 0.3s ease-out" }}>
              {isAI ? "AI THINKING" : isLocal ? "YOUR TURN" : "PLAYING"}
            </span>
          )}
        </div>
      </div>

      {isAI && (
        <div className="mb-3 -mt-1">
          <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40">
            🤖 AI
          </span>
        </div>
      )}

      {isActive && (
        <div className="mt-3 pt-3 border-t border-white/10">
          <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1.5">Action Points</p>
          <div className="flex items-center gap-2">
            <APPips current={currentAP} max={maxAP} color={color} />
            <span className="text-xs font-bold text-white/80">{currentAP}/{maxAP}</span>
          </div>
        </div>
      )}

      <div className={`${isActive ? "pt-2" : "pt-3"} mt-3 pt-3 border-t border-white/10`}>
        {/* Troop bar — always visible */}
        <div className="mb-3">
          <TroopBar troops={totalTroops} maxTroops={maxTroops} color={color} />
        </div>
        <div className="flex gap-4">
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Moves</p>
            <p className="text-lg font-black text-white">{moves}</p>
          </div>
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Territory</p>
            <p className="text-lg font-black text-white">{territory}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Connection Banner — pulsing red indicator for disconnect/connection loss
// ══════════════════════════════════════════════════════════════════════════

type ConnectionStatus = "connected" | "opponent_disconnected" | "connection_lost";

function ConnectionBanner({ status, onReconnect }: { status: ConnectionStatus; onReconnect?: () => void }) {
  if (status === "connected") return null;

  const isOpponent = status === "opponent_disconnected";
  const isConnectionLost = status === "connection_lost";

  return (
    <div
      className={`
        fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 px-4 py-3
        text-sm font-bold uppercase tracking-[0.12em] shadow-[0_4px_30px_rgba(239,68,68,0.5)]
        ${isOpponent ? "bg-red-600/90 text-white" : "bg-orange-600/90 text-white"}
      `}
      style={{
        animation: "connectionPulse 1.5s ease-in-out infinite",
      }}
    >
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-white animate-ping" />
      {isOpponent ? (
        <>⚠️ Opponent disconnected — you win!</>
      ) : (
        <>
          ⚠️ Connection lost
          {onReconnect && (
            <button
              onClick={onReconnect}
              className="ml-3 px-4 py-1.5 rounded-lg bg-white/20 text-[11px] font-bold hover:bg-white/30 transition"
            >
              Reconnect
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Status Bar (Enhanced with turn transition animations)
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  Turn Timer Bar
// ══════════════════════════════════════════════════════════════════════════

function TimerBar({ fraction, isUrgent, isCritical, isActive }: {
  fraction: number;
  isUrgent: boolean;
  isCritical: boolean;
  isActive: boolean;
}) {
  if (!isActive) return null;

  const barColor = isCritical
    ? "#ef4444"
    : isUrgent
    ? "#facc15"
    : "#22d3ee";

  const glowColor = isCritical
    ? "rgba(239,68,68,0.5)"
    : isUrgent
    ? "rgba(250,204,21,0.4)"
    : "rgba(34,211,238,0.3)";

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-32 overflow-hidden rounded-full bg-slate-800/60">
        <div
          className={`h-full rounded-full transition-all duration-200 ${isCritical ? "animate-pulse" : ""}`}
          style={{
            width: `${Math.max(0, fraction * 100)}%`,
            backgroundColor: barColor,
            boxShadow: `0 0 8px ${glowColor}`,
          }}
        />
      </div>
      <span
        className={`text-xs font-bold tabular-nums ${
          isCritical ? "text-red-400" : isUrgent ? "text-yellow-300" : "text-slate-300"
        }`}
      >
        0:{Math.ceil(fraction * 120).toString().padStart(2, "0")}
      </span>
    </div>
  );
}

function StatusBar({
  currentTurn, currentAP, maxAP, onEndTurn, isGameOver, aiThinking, aiEnabled,
  showEndTurn = true, isLocalTurn,
}: {
  currentTurn: DuelPlayer; currentAP: number; maxAP: number;
  onEndTurn: () => void;
  isGameOver: boolean; aiThinking: boolean; aiEnabled: boolean;
  showEndTurn?: boolean;
  isLocalTurn?: boolean;
}) {
  // Determine turn color from perspective — local player's color when it's their turn
  const turnColor = isLocalTurn ? "#22d3ee" : "#ef4444";
  const turnLabel = isGameOver ? "" : isLocalTurn ? "YOUR TURN" : "OPPONENT'S TURN";
  const isAITurn = aiEnabled && currentTurn === "player2";

  let message: string;
  let subMessage: string | null = null;

  if (isGameOver) {
    message = "Game Over";
    subMessage = "Enemy capital conquered!";
  } else if (aiThinking) {
    message = "AI is thinking...";
    subMessage = "Choosing the best strategy";
  } else if (isAITurn) {
    message = "AI's turn — auto-playing";
    subMessage = "Attack (1 AP) or displace troops (1 AP)";
  } else if (currentAP < ATTACK_COST) {
    message = "No AP remaining";
    subMessage = "End your turn to gain +1 AP";
  } else {
    message = "Choose an action";
    subMessage = "Attack enemy tiles (1 AP) or Displace troops (1 AP)";
  }

  return (
    <div className="text-center space-y-2">
      {!isGameOver && (
        <div className="flex items-center justify-center gap-2" style={{ animation: "turnSlideIn 0.35s ease-out" }}>
          <span
            className={`inline-block w-3 h-3 rounded-full transition-all duration-500 ${aiThinking ? "animate-spin" : "animate-pulse"}`}
            style={{ backgroundColor: turnColor, boxShadow: `0 0 14px ${turnColor}` }}
          />
          <span className="text-sm font-bold uppercase tracking-[0.25em] text-slate-300">
            {turnLabel}
          </span>
        </div>
      )}

      {isGameOver && (
        <div className="flex items-center justify-center gap-2">
          <span className="text-sm font-bold uppercase tracking-[0.25em] text-yellow-400 animate-pulse">
            🏆 GAME OVER 🏆
          </span>
        </div>
      )}

      <div className="flex items-center justify-center gap-2">
        <span className="text-[10px] text-slate-500 uppercase tracking-widest">AP</span>
        <APPips current={currentAP} max={maxAP} color={isGameOver ? "#facc15" : turnColor} />
        <span className="text-[10px] text-slate-500 uppercase tracking-widest ml-1">{currentAP}/{maxAP}</span>
      </div>

      <p className="text-xs text-slate-400" style={{ animation: "floatUp 0.3s ease-out" }}>{message}</p>
      {subMessage && (
        <p className={`text-[10px] ${isGameOver ? "text-yellow-400/90 font-bold" : currentAP < ATTACK_COST ? "text-yellow-400/90 font-bold" : "text-yellow-400/70"}`}>
          {subMessage}
        </p>
      )}

      {!isGameOver && !isAITurn && showEndTurn && (
        <button
          onClick={onEndTurn}
          className={`mt-2 px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-[0.15em] transition-all duration-200 ${
            currentAP < ATTACK_COST
              ? "bg-yellow-400 text-black shadow-[0_0_14px_rgba(250,204,21,0.5)] hover:bg-yellow-300 hover:scale-105 hover:shadow-[0_0_20px_rgba(250,204,21,0.7)] animate-pulse"
              : "border border-white/15 text-slate-400 hover:text-white hover:border-white/30 hover:bg-white/5"
          }`}
        >
          {currentAP < ATTACK_COST ? "⚡ End Turn" : "End Turn"}
        </button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Page
// ══════════════════════════════════════════════════════════════════════════

type GameMode = "idle" | "for-fun" | "real" | "multiplayer";

/** Multiplayer action sent/received via socket */
interface MultiplayerAction {
  type: 'attack' | 'displace' | 'endTurn' | 'skipRound';
  sourceKey?: string;
  targetKey?: string;
  troopCount?: number;
}

export default function HexDuelPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { socket } = useSocket();
  const posthog = usePostHog();

  const {
    grid, currentTurn, currentAP, maxAP,
    capturedTiles, capitals, tileTroops,
    p1MoveCount, p2MoveCount, p1Territory, p2Territory,
    recentlyCaptured, selectedTile, winner,
    actionLog,
    attackableTargets, getAttackSources,
    displaceCandidates, getDisplaceSources,
    handleAttack, handleDisplace, applyRemoteAction,
    endTurn, skipRound, resetGame,
    buildSyncSnapshot, applySyncSnapshot,
  } = useHexDuel();

  // ── Remaining from old type (stubs kept as empty) ──
  const selectedUnit = null as DuelPlayer | null;
  const validMoves: { x: number; y: number }[] = [];
  const pushTargets: never[] = [];
  const territorySpread: string[] = [];
  const pushedHere: string[] = [];
  const powerNodes: Set<string> = new Set();
  const p1PowerNodes = 0;
  const p2PowerNodes = 0;
  const reinforceTargets: never[] = [];
  const player1Pos = { x: 0, y: 0 };
  const player2Pos = { x: 0, y: 0 };

  // ── Audio ──────────────────────────────────────────────────────────
  const audio = useHexAudio();

  // ── AI state ───────────────────────────────────────────────────────
  const [aiEnabled, setAIEnabled] = useState(false);
  const [aiDifficulty, setAIDifficulty] = useState<AIDifficulty>("medium");
  const [aiThinking, setAIThinking] = useState(false);
  const [aiAction, setAIAction] = useState<AIAction | null>(null);

  // ── Wager state ────────────────────────────────────────────────────
  const [gameMode, setGameMode] = useState<GameMode>("idle");
  const [balance, setBalance] = useState(0);
  const [wager, setWager] = useState(0);
  const [wagerLoading, setWagerLoading] = useState(false);
  const [wagerError, setWagerError] = useState<string | null>(null);
  const [multiplayerLoading, setMultiplayerLoading] = useState(false);
  const [multiplayerGames, setMultiplayerGames] = useState<Array<{ id: number; wagerAmount: string | number; hostName?: string | null }>>([]);
  const [payoutResult, setPayoutResult] = useState<{ wager: number; payout: number; multiplier: number } | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(false);
  const payoutProcessedRef = useRef(false);
  const startedAtRef = useRef<string | null>(null);

  // ── Attack / Displace flow state ────────────────────────────────
  const [selectedAction, setSelectedAction] = useState<ActionType>(null);
  const [pendingActionPhase, setPendingActionPhase] = useState<
    "selectTarget" | "selectSource" | "inputTroops" | null
  >(null);
  const [pendingTarget, setPendingTarget] = useState<{ x: number; y: number } | null>(null);
  const [pendingSource, setPendingSource] = useState<{ x: number; y: number } | null>(null);
  const [pendingTroopCount, setPendingTroopCount] = useState(1);

  // ── Multiplayer state ────────────────────────────────────────────
  const [multiplayerGameId, setMultiplayerGameId] = useState<number | null>(null);
  const [isPlayer1, setIsPlayer1] = useState<boolean>(true);
  const [opponentReady, setOpponentReady] = useState(false);
  const opponentReadyRef = useRef(false);
  const multiplayerJoinedRef = useRef(false);
  const [opponentName, setOpponentName] = useState<string | null>(null);
  const [opponentClerkId, setOpponentClerkId] = useState<string | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
  const [player1Name, setPlayer1Name] = useState<string | null>(null);

  // ── Connection status ───────────────────────────────────────────
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connected");
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Resign confirmation popup ──────────────────────────────────
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  // ── Winner override (for chess clock expiry) ──────────────────────
  const [winnerOverride, setWinnerOverride] = useState<DuelPlayer | null>(null);
  const effectiveWinner = winnerOverride ?? winner;
  const isGameOverEffective = effectiveWinner !== null;
  const isGameOver = isGameOverEffective;
  const showGame = gameMode !== "idle";

  // Whether the local player is allowed to act (their turn + not waiting for opponent)
  const isLocalTurn = gameMode === "multiplayer"
    ? (isPlayer1 && currentTurn === "player1") || (!isPlayer1 && currentTurn === "player2")
    : true;

  // ── Turn transition tracking ───────────────────────────────────────
  const prevTurnRef = useRef(currentTurn);
  const [turnJustChanged, setTurnJustChanged] = useState(false);

  useEffect(() => {
    if (prevTurnRef.current !== currentTurn) {
      setTurnJustChanged(true);
      const t = setTimeout(() => setTurnJustChanged(false), 500);
      prevTurnRef.current = currentTurn;
      return () => clearTimeout(t);
    }
  }, [currentTurn]);

  // ── Sound effects ──────────────────────────────────────────────────

  // Turn switch sound
  const prevTurnForAudio = useRef(currentTurn);
  useEffect(() => {
    if (prevTurnForAudio.current !== currentTurn) {
      audio.playTurnSwitch(currentTurn);
      prevTurnForAudio.current = currentTurn;
    }
  }, [currentTurn, audio]);

  // Capture sound
  const prevCaptureLen = useRef(recentlyCaptured.length);
  useEffect(() => {
    if (recentlyCaptured.length > prevCaptureLen.current && recentlyCaptured.length > 0) {
      audio.playCapture();
    }
    prevCaptureLen.current = recentlyCaptured.length;
  }, [recentlyCaptured, audio]);

  // Push sound (replaced by attack sound via capture detection)
  const prevCombatFlashLen = useRef(0);
  useEffect(() => {
    if (recentlyCaptured.length > prevCombatFlashLen.current && recentlyCaptured.length > 0) {
      audio.playCapture();
    }
    prevCombatFlashLen.current = recentlyCaptured.length;
  }, [recentlyCaptured, audio]);

  // Victory / defeat sounds
  const victoryPlayed = useRef(false);
  useEffect(() => {
    if (effectiveWinner && !victoryPlayed.current) {
      victoryPlayed.current = true;
      if (effectiveWinner === localDuelPlayer) {
        setTimeout(() => audio.playVictory(), 300);
      } else {
        setTimeout(() => audio.playDefeat(), 300);
      }
    }
    if (!effectiveWinner) victoryPlayed.current = false;
  }, [effectiveWinner, audio]);

  // ── Balance ────────────────────────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    if (!isSignedIn || !user) return;
    try {
      const res = await fetch("/api/get-user-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" });
      const data = await res.json();
      if (data.success) setBalance(Number(data.data.balance || 0));
    } catch {}
  }, [isSignedIn, user]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  const fetchMultiplayerGames = useCallback(async () => {
    setMultiplayerLoading(true);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/available", { credentials: "include" });
      const data = await res.json();
      if (data?.success) setMultiplayerGames(data.games ?? []);
    } catch {
      setMultiplayerGames([]);
    } finally {
      setMultiplayerLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gameMode !== "idle") return;
    fetchMultiplayerGames();
  }, [gameMode, fetchMultiplayerGames]);

  // ── Auto-join multiplayer game from URL params (lobby redirect) ──
  const multiplayerJoinedFromUrl = useRef(false);
  useEffect(() => {
    if (multiplayerJoinedFromUrl.current) return;
    const gameIdParam = searchParams.get("gameId");
    const hostParam = searchParams.get("host");
    const spectatorParam = searchParams.get("spectator");
    if (!gameIdParam) return;
    const gameId = Number(gameIdParam);
    if (!Number.isFinite(gameId) || gameId <= 0) return;
    multiplayerJoinedFromUrl.current = true;
    setMultiplayerGameId(gameId);

    if (spectatorParam === "1") {
      setIsSpectator(true);
      setIsPlayer1(true);
      setGameMode("multiplayer");
      setOpponentReady(true);
      opponentReadyRef.current = true;
      multiplayerJoinedRef.current = true;
    } else {
      setIsPlayer1(hostParam === "1");
      setGameMode("multiplayer");
      setOpponentReady(false);
      multiplayerJoinedRef.current = false;
    }
  }, [searchParams]);

  // ── Wager handlers ─────────────────────────────────────────────────
  const handleStartFun = useCallback(() => { setAIEnabled(true); setGameMode("for-fun"); setWager(0); setWagerError(null); startedAtRef.current = new Date().toISOString(); posthog?.capture("hex_duel_game_started", { mode: "fun", difficulty: aiDifficulty }); }, []);
  const handleStartReal = useCallback(async (amount: number) => {
    setWagerLoading(true); setWagerError(null);
    try {
      const res = await fetch("/api/hex-duel/start-game", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ wager: amount }) });
      const data = await res.json();
      if (!res.ok || !data.success) { setWagerError(data.error || "Failed to start game"); return; }
      setBalance(Number(data.data.newBalance));
      setWager(amount);
      setAIEnabled(true); // Auto-enable AI for vs-AI real games
      setGameMode("real");
      startedAtRef.current = new Date().toISOString();
      posthog?.capture("hex_duel_game_started", { mode: "real", bet_amount: amount, difficulty: aiDifficulty });
    } catch { setWagerError("Network error — please try again"); }
    finally { setWagerLoading(false); }
  }, []);

  const handleCreateMultiplayer = useCallback(async (amount: number) => {
    setWagerError(null);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wager: amount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setWagerError(data.error || "Failed to create game");
        return;
      }
      if (data?.newBalance !== undefined) setBalance(Number(data.newBalance));
      if (data?.gameId) {
        setMultiplayerGameId(Number(data.gameId));
        setIsPlayer1(true);
        setGameMode("multiplayer");
        setOpponentReady(false);
        multiplayerJoinedRef.current = false;
      }
      fetchMultiplayerGames();
    } catch {
      setWagerError("Network error — please try again");
    }
  }, [fetchMultiplayerGames]);

  const handleJoinMultiplayer = useCallback(async (gameId: number, quickJoin = false) => {
    setWagerError(null);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(quickJoin ? { quickJoin: true } : { gameId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setWagerError(data.error || "Unable to join game");
        await fetchMultiplayerGames();
        return;
      }
      if (data?.newBalance !== undefined) setBalance(Number(data.newBalance));
      if (data?.gameId) {
        setMultiplayerGameId(Number(data.gameId));
        setIsPlayer1(false);
        setGameMode("multiplayer");
        setOpponentReady(false);
        multiplayerJoinedRef.current = false;
      }
    } catch {
      setWagerError("Network error — please try again");
    }
  }, [fetchMultiplayerGames]);

  // ── Socket connection for multiplayer ──────────────────────────

  // ── Socket: join game room when game starts, leave only on unmount/game reset ──
  useEffect(() => {
    if (!socket || !multiplayerGameId || isSpectator) return;
    const roomId = String(multiplayerGameId);
    socket.emit("hexDuel:join", { gameId: multiplayerGameId });

    // Self-healing polling: re-emit join until opponent is detected
    const readyPoll = setInterval(() => {
      if (!opponentReadyRef.current && socket.connected) {
        socket.emit("hexDuel:join", { gameId: multiplayerGameId });
      }
    }, 5000);

    return () => {
      clearInterval(readyPoll);
      socket.emit("leave_game", { gameId: multiplayerGameId });
    };
  }, [socket, multiplayerGameId, isSpectator]);

  // ── Socket: listen for opponent events ──────────────────────────
  useEffect(() => {
    if (!socket || !multiplayerGameId || isSpectator) return;

    // Listen for opponent actions
    const handleOpponentAction = (data: { action: MultiplayerAction }) => {
      if (data.action) {
        // Track content signature for dedup so the polling fallback
        // doesn't re-apply actions already received via socket.
        const sig = `${data.action.type}:${data.action.sourceKey ?? ""}:${data.action.targetKey ?? ""}:${data.action.troopCount ?? ""}`;
        processedSocketActionsRef.current.add(sig);
        applyRemoteActionRef.current(data.action);
      }
    };

    // Listen for opponent ready
    const handleOpponentReady = () => {
      setOpponentReady(true);
      opponentReadyRef.current = true;
    };

    // Listen for opponent resignation
    const handleOpponentResigned = () => {
      if (!isGameOverRef.current) {
        const winnerP = isPlayer1 ? "player2" : "player1";
        setWinnerOverride(winnerP);
      }
    };

    // Listen for opponent disconnect → show red banner + auto-win
    const handleOpponentDisconnected = () => {
      if (!isGameOverRef.current) {
        setConnectionStatus("opponent_disconnected");
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        connectionTimerRef.current = setTimeout(() => {
          setConnectionStatus("connected");
        }, 5000);

        if (!opponentReadyRef.current) {
          setTimeout(() => {
            if (!isGameOverRef.current) handleRestart();
          }, 2000);
        } else {
          const winnerP = isPlayer1 ? "player2" : "player1";
          setWinnerOverride(winnerP);
        }
      }
    };

    // Listen for opponent clock expiry → auto-win for local player
    const handleOpponentTimeout = () => {
      if (!isGameOverRef.current) {
        const winnerP = isPlayer1 ? "player2" : "player1";
        setWinnerOverride(winnerP);
      }
    };

    // Listen for own socket disconnect (connection lost)
    const handleSocketDisconnect = () => {
      setConnectionStatus("connection_lost");
    };

    // Listen for socket reconnect
    const handleSocketConnect = () => {
      setConnectionStatus("connected");
      socket.emit("hexDuel:join", { gameId: multiplayerGameId });
    };

    // Listen for state sync requests (from opponent whose socket dropped)
    const handleRequestSync = () => {
      if (socket && multiplayerGameId) {
        const snap = buildSyncSnapshotRef.current();
        socket.emit("hexDuel:syncState", { gameId: multiplayerGameId, snapshot: snap });
      }
    };

    // Listen for state sync responses (to recover from desync)
    const handleSyncState = (data: { snapshot: any }) => {
      if (data?.snapshot && !isGameOverRef.current) {
        applySyncSnapshot(data.snapshot);
      }
    };

    socket.on("hexDuel:action", handleOpponentAction);
    socket.on("hexDuel:opponent:ready", handleOpponentReady);
    socket.on("hexDuel:opponent:resigned", handleOpponentResigned);
    socket.on("hexDuel:opponent:disconnected", handleOpponentDisconnected);
    socket.on("hexDuel:opponent:timeout", handleOpponentTimeout);
    socket.on("hexDuel:requestSync", handleRequestSync);
    socket.on("hexDuel:syncState", handleSyncState);
    socket.on("disconnect", handleSocketDisconnect);
    socket.on("connect", handleSocketConnect);

    return () => {
      socket.off("hexDuel:action", handleOpponentAction);
      socket.off("hexDuel:opponent:ready", handleOpponentReady);
      socket.off("hexDuel:opponent:resigned", handleOpponentResigned);
      socket.off("hexDuel:opponent:disconnected", handleOpponentDisconnected);
      socket.off("hexDuel:opponent:timeout", handleOpponentTimeout);
      socket.off("hexDuel:requestSync", handleRequestSync);
      socket.off("hexDuel:syncState", handleSyncState);
      socket.off("disconnect", handleSocketDisconnect);
      socket.off("connect", handleSocketConnect);
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    };
  }, [socket, multiplayerGameId, isSpectator]);

  // ── Polling fallback: detect both players joined even if socket event is missed ──
  // Uses opponentReadyRef to avoid unnecessary effect re-runs
  useEffect(() => {
    if (gameMode !== "multiplayer" || !multiplayerGameId || opponentReadyRef.current) return;

    let cancelled = false;

    const pollStatus = async () => {
      try {
        const res = await fetch(
          `/api/hex-duel/multiplayer/status?gameId=${multiplayerGameId}`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (cancelled) return;
        if (data?.success && data.game?.isReady) {
          setOpponentReady(true);
          opponentReadyRef.current = true;
        }
      } catch {
        // Ignore poll errors — socket will also try to connect
      }
    };

    // Poll immediately, then every 3 seconds
    pollStatus();
    const interval = setInterval(pollStatus, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gameMode, multiplayerGameId]);

  // Send clock expiry to opponent in multiplayer mode
  const sendClockExpiryRef = useRef<() => void>(() => {});
  sendClockExpiryRef.current = () => {
    if (gameMode === "multiplayer" && socket && multiplayerGameId) {
      socket.emit("hexDuel:clockExpired", { gameId: multiplayerGameId });
    }
  };

  // Auto-start game once both players are ready
  useEffect(() => {
    if (gameMode === "multiplayer" && multiplayerGameId && opponentReady && multiplayerJoinedRef.current) {
      // Both players connected — start the game
      // The engine starts with currentTurn="player1" and player1 goes first
    }
  }, [gameMode, multiplayerGameId, opponentReady]);

  // Mark local player as ready after joining — emit immediately to avoid
  // unnecessary delay. The socket may not be connected yet on first render,
  // but the main socket effect (above) also emits hexDuel:join when it runs,
  // so the join will still succeed once the socket connects.
  useEffect(() => {
    if (gameMode === "multiplayer" && multiplayerGameId && !multiplayerJoinedRef.current) {
      multiplayerJoinedRef.current = true;
      if (socket) {
        socket.emit("hexDuel:join", { gameId: multiplayerGameId });
      }
    }
  }, [gameMode, multiplayerGameId, socket]);

  // ── Send action via socket in multiplayer mode ──────────────────
  const actionSeqRef = useRef(0);
  const sendMultiplayerAction = useCallback((action: MultiplayerAction) => {
    if (socket && multiplayerGameId) {
      actionSeqRef.current += 1;
      socket.emit("hexDuel:action", { gameId: multiplayerGameId, action: { ...action, __seq: actionSeqRef.current } });
    }
  }, [socket, multiplayerGameId]);

  // ── Record action to server for action-based sync (like dice duel diceTurns) ──
  const multiplayerGameIdRef = useRef(multiplayerGameId);
  multiplayerGameIdRef.current = multiplayerGameId;
  const gameModeRef = useRef(gameMode);
  gameModeRef.current = gameMode;

  const recordMultiplayerAction = useCallback((action: MultiplayerAction) => {
    if (gameModeRef.current !== "multiplayer" || !multiplayerGameIdRef.current || isSpectator) return;
    fetch("/api/hex-duel/multiplayer/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        gameId: multiplayerGameIdRef.current,
        actionType: action.type,
        sourceKey: action.sourceKey,
        targetKey: action.targetKey,
        troopCount: action.troopCount,
      }),
    }).catch(() => {});
  }, []);

  // Ref for applyRemoteAction to avoid stale closure issues
  const applyRemoteActionRef = useRef<(a: MultiplayerAction) => void>(() => {});

  // ── End-game payout ────────────────────────────────────────────────
  useEffect(() => {
    if (!effectiveWinner || gameMode === "idle" || payoutProcessedRef.current || isSpectator) return;
    payoutProcessedRef.current = true;
    setPayoutLoading(true);

    const durationSeconds = startedAtRef.current
      ? Math.round((Date.now() - new Date(startedAtRef.current).getTime()) / 1000)
      : 0;

    const endPoint = gameMode === "multiplayer"
      ? "/api/hex-duel/multiplayer/end"
      : "/api/hex-duel/end-game";

    const won =
      (gameMode === "multiplayer" && effectiveWinner === (isPlayer1 ? "player2" : "player1")) ||
      (gameMode !== "multiplayer" && effectiveWinner === "player2");
    posthog?.capture("hex_duel_game_ended", {
      result: won ? "win" : "loss",
      mode: gameMode === "for-fun" ? "fun" : gameMode === "multiplayer" ? "pvp" : "real",
      bet_amount: gameMode === "for-fun" ? 0 : wager,
      difficulty: aiEnabled ? aiDifficulty : undefined,
      player1_moves: p1MoveCount,
      player2_moves: p2MoveCount,
      duration_seconds: durationSeconds,
    });

    fetch(endPoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        wager: gameMode === "for-fun" ? 0 : wager,
        winner: effectiveWinner,
        isFunMode: gameMode === "for-fun",
        isAiGame: aiEnabled,
        aiDifficulty: aiEnabled ? aiDifficulty : null,
        player1Moves: p1MoveCount,
        player2Moves: p2MoveCount,
        player1Territory: p1Territory,
        player2Territory: p2Territory,
        durationSeconds,
        startedAt: startedAtRef.current,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data.won) {
          setPayoutResult({ wager: d.data.wager, payout: d.data.payout, multiplier: d.data.multiplier });
          if (d.data.newBalance !== undefined) setBalance(Number(d.data.newBalance));
        } else if (d.success && (gameMode === "real" || gameMode === "multiplayer")) {
          const lostWager = d.data?.wager ?? wager;
          setPayoutResult({ wager: lostWager, payout: 0, multiplier: 0 });
          if (d.data.newBalance !== undefined) setBalance(Number(d.data.newBalance));
        } else if (gameMode === "for-fun") {
          setPayoutResult(null);
        }
      })
      .catch(() => {})
      .finally(() => setPayoutLoading(false));
  }, [effectiveWinner, winnerOverride, gameMode, wager, aiEnabled, aiDifficulty, p1MoveCount, p2MoveCount, p1Territory, p2Territory, multiplayerGameId]);

  // ── Chess clock ──────────────────────────────────────────────────
  const chessExpireRef = useRef({ currentTurn: currentTurn as DuelPlayer | null, gameOver: false });
  chessExpireRef.current = { currentTurn, gameOver: isGameOverEffective };

  const onClockExpire = useCallback((expiredPlayer: DuelPlayer) => {
    if (chessExpireRef.current.gameOver) return;
    setClockLoser(expiredPlayer);
    // Notify opponent in multiplayer mode
    if (gameMode === "multiplayer") {
      sendClockExpiryRef.current();
    }
  }, [gameMode]);

  const [clockLoser, setClockLoser] = useState<DuelPlayer | null>(null);

  // When clock expires for a player, the other player wins
  useEffect(() => {
    if (clockLoser && !winner && !winnerOverride) {
      const winnerPlayer = clockLoser === "player1" ? "player2" : "player1";
      setWinnerOverride(winnerPlayer);
      setClockLoser(null);
    }
  }, [clockLoser, winner, winnerOverride]);

  // Chess clock hook — isActive pauses during AI thinking and after game over
  const clock = useChessClock({
    isActive: showGame && !isGameOverEffective && !aiThinking,
    onPlayer1Expire: () => onClockExpire("player1"),
    onPlayer2Expire: () => onClockExpire("player2"),
    resetKey: gameMode + (effectiveWinner ? "-over" : ""),
  });

  // Toggle active clock when currentTurn changes
  const prevTurnForClock = useRef(currentTurn);
  useEffect(() => {
    if (prevTurnForClock.current !== currentTurn && !isGameOverEffective && !aiThinking) {
      clock.setActivePlayer(currentTurn);
      prevTurnForClock.current = currentTurn;
    }
  }, [currentTurn, isGameOverEffective, aiThinking, clock]);

  // Start clock on first turn & resume after AI finishes thinking.
  // Uses prevTurnForClock guard to avoid re-triggering on clock updates.
  useEffect(() => {
    if (showGame && !isGameOverEffective && !aiThinking && prevTurnForClock.current !== currentTurn) {
      clock.setActivePlayer(currentTurn);
      prevTurnForClock.current = currentTurn;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps — setActivePlayer is stable
  }, [aiThinking, showGame, isGameOverEffective, currentTurn]);

  // Format milliseconds to mm:ss
  const formatClock = (ms: number) => {
    const totalSec = Math.ceil(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
  };

  // ── Refs for values used by AI (avoids stale closures) ────────────
  const handleAttackRef = useRef(handleAttack);
  handleAttackRef.current = handleAttack;
  const handleDisplaceRef = useRef(handleDisplace);
  handleDisplaceRef.current = handleDisplace;
  const endTurnRef = useRef(endTurn);
  endTurnRef.current = endTurn;
  const skipRoundRef = useRef(skipRound);
  skipRoundRef.current = skipRound;
  const isGameOverRef = useRef(false);
  isGameOverRef.current = isGameOverEffective;
  const currentTurnRef = useRef(currentTurn);
  currentTurnRef.current = currentTurn;
  const lastHeartbeatRef = useRef<number>(0);

  // Set up applyRemoteActionRef
  const localApplyRemote = useCallback((action: MultiplayerAction) => {
    if (isGameOverRef.current) return;
    applyRemoteAction(action);
  }, [applyRemoteAction]);

  applyRemoteActionRef.current = localApplyRemote;

  // Ref for buildSyncSnapshot to avoid stale closures in socket handler
  const buildSyncSnapshotRef = useRef(buildSyncSnapshot);
  buildSyncSnapshotRef.current = buildSyncSnapshot;

  // Track the latest action ID we've seen from the opponent (for efficient polling)
  const lastKnownActionIdRef = useRef(0);
  // Deduplication: track action content signatures already received via socket
  // so the polling fallback doesn't re-apply them, preventing double-processing.
  const processedSocketActionsRef = useRef<Set<string>>(new Set());
  // Periodically expire old dedup entries to prevent unbounded growth
  useEffect(() => {
    const interval = setInterval(() => {
      if (processedSocketActionsRef.current.size > 40) {
        processedSocketActionsRef.current = new Set();
      }
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // ── Computed highlight keys for HexBoard ───────────────────────────
  const attackHighlightKeys = useMemo(
    () => (selectedAction === "attack" ? attackableTargets.map((t) => `${t.x},${t.y}`) : []),
    [selectedAction, attackableTargets]
  );

  // Compute source highlight keys based on the current phase
  const sourceHighlightKeys = useMemo(() => {
    if (selectedAction === "attack" && pendingTarget && pendingActionPhase === "selectSource") {
      const targetKey = `${pendingTarget.x},${pendingTarget.y}`;
      return getAttackSources(targetKey).map((s) => `${s.x},${s.y}`);
    }
    if (selectedAction === "displace" && pendingTarget && pendingActionPhase === "selectSource") {
      const targetKey = `${pendingTarget.x},${pendingTarget.y}`;
      return getDisplaceSources(targetKey).map((s) => `${s.x},${s.y}`);
    }
    return [];
  }, [selectedAction, pendingTarget, pendingActionPhase, getAttackSources, getDisplaceSources]);

  // Displace candidate highlights (shown at start of displace action)
  const displaceHighlightKeys = useMemo(
    () => (selectedAction === "displace" ? displaceCandidates.map((t) => `${t.x},${t.y}`) : []),
    [selectedAction, displaceCandidates]
  );

  // (pushTargetKeys, powerNodeKeys, reinforceTargetKeys removed — replaced by attack/displace system)

  // ── Troop totals ───────────────────────────────────────────────────
  const p1TotalTroops = useMemo(() => {
    let total = 0;
    for (const [key, owner] of Object.entries(capturedTiles)) {
      if (owner === "player1") {
        total += tileTroops[key] ?? 1;
      }
    }
    return total;
  }, [capturedTiles, tileTroops]);

  const p2TotalTroops = useMemo(() => {
    let total = 0;
    for (const [key, owner] of Object.entries(capturedTiles)) {
      if (owner === "player2") {
        total += tileTroops[key] ?? 1;
      }
    }
    return total;
  }, [capturedTiles, tileTroops]);

  // Maximum troops across both players (for the bar scale)
  const maxTroops = useMemo(
    () => Math.max(p1TotalTroops, p2TotalTroops, 5),
    [p1TotalTroops, p2TotalTroops]
  );

  // ── AI Turn Execution (event-driven: ONE move per invocation) ──
  // Uses refs to avoid stale closure issues. The aiMoveTick counter
  // triggers the useEffect after each move to cascade subsequent moves.
  const [aiMoveTick, setAiMoveTick] = useState(0);
  const aiCancelledRef = useRef(false);
  const aiEnabledRef = useRef(aiEnabled);
  aiEnabledRef.current = aiEnabled;
  const aiDifficultyRef = useRef(aiDifficulty);
  aiDifficultyRef.current = aiDifficulty;

  // Ref-based snapshot builder — always returns latest values
  const aiSnapshotRef = useRef<AIStateSnapshot>({ myPlayer: "player2", enemyPlayer: "player1", capturedTiles, capitals, tileTroops, currentAP });
  aiSnapshotRef.current = { myPlayer: "player2", enemyPlayer: "player1", capturedTiles, capitals, tileTroops, currentAP };

  // Make ONE AI decision and execute it. Returns when the move is queued.
  // setAiMoveTick triggers a cascade via the useEffect dep.
  const makeAIMove = useCallback(async () => {
    if (!aiEnabledRef.current || isGameOverRef.current || gameMode === "idle") return;

    const snap = aiSnapshotRef.current;

    // No AP → end turn
    if (snap.currentAP < ATTACK_COST) {
      endTurnRef.current();
      setAIAction({ type: "endTurn" });
      setAIThinking(false);
      return;
    }

    // Get AI decision
    let action: AIAction;
    try {
      const res = await fetch("/api/hex-duel/ai-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty: aiDifficultyRef.current, snapshot: snap }),
      });
      const data = await res.json();
      action = data?.success ? (data.action as AIAction) : decideAIAction(snap, aiDifficultyRef.current);
    } catch {
      action = decideAIAction(snap, aiDifficultyRef.current);
    }

    setAIAction(action);

    if (action.type === "endTurn") {
      endTurnRef.current();
      setAIThinking(false);
      return;
    }

    if (action.type === "attack") {
      // Execute AI attack
      handleAttackRef.current(action.sourceKey, action.targetKey, action.troopCount);
      await new Promise((r) => setTimeout(r, 150));
      if (aiCancelledRef.current) return;
      // Cascade: may have remaining AP for further actions
      setAiMoveTick((t) => t + 1);
    } else if (action.type === "displace") {
      // Execute AI displace
      handleDisplaceRef.current(action.sourceKey, action.targetKey, action.troopCount);
      await new Promise((r) => setTimeout(r, 150));
      if (aiCancelledRef.current) return;
      // Cascade: may have remaining AP for further actions
      setAiMoveTick((t) => t + 1);
    }
  }, [gameMode]);  // stable deps — everything else via refs

  // ── AI Turn Orchestrator ─────────────────────────────────────
  // Fires when currentTurn or aiMoveTick changes. Each tick triggers
  // one AI move. The loop continues until AP depletes or game ends.
  useEffect(() => {
    if (!aiEnabled || currentTurn !== "player2" || isGameOverRef.current || gameMode === "idle") {
      setAIThinking(false);
      aiCancelledRef.current = true;
      return;
    }

    aiCancelledRef.current = false;    const run = async () => {
  try {
    setAIThinking(true);

    // Check game-over at start — prevents AI from running after clock expiry
    if (isGameOverRef.current) {
      aiCancelledRef.current = true;
      setAIThinking(false);
      return;
    }

    await new Promise((r) => setTimeout(r, 200));

    if (aiCancelledRef.current) {
      setAIThinking(false);
      return;
    }

    await makeAIMove();
  } finally {
    setAIThinking(false);
  }
};

    run();

    return () => { aiCancelledRef.current = true; };
  }, [currentTurn, aiMoveTick, aiEnabled, gameMode, makeAIMove]);

  // ── Chess clock derived values for StatusBar ──────────────────────
  const activeClockPlayer = !aiThinking ? currentTurn : null;
  const activeClockTime = activeClockPlayer === "player1" ? clock.p1TimeLeft : activeClockPlayer === "player2" ? clock.p2TimeLeft : 600000;
  const timerFraction = activeClockPlayer ? Math.max(0, activeClockTime / 600000) : 1;
  const timerUrgent = activeClockPlayer !== null && activeClockTime < 60000;
  const timerCritical = activeClockPlayer !== null && activeClockTime < 10000;
  const timerActive = activeClockPlayer !== null;

  // ── Handlers ───────────────────────────────────────────────────────
  const handleToggleAI = useCallback(() => setAIEnabled((p) => { const n = !p; if (!n) { setAIThinking(false); setAIAction(null); } return n; }), []);
  const handleDifficultyChange = useCallback((diff: AIDifficulty) => setAIDifficulty(diff), []);

  // Wrap endTurn to also send via socket in multiplayer AND update server turn state AND record action
  const handleEndTurn = useCallback(() => {
    const prevTurn = currentTurn;
    endTurn();
    if (gameMode === "multiplayer") {
      const action: MultiplayerAction = { type: "endTurn" };
      sendMultiplayerAction(action);
      recordMultiplayerAction(action);
      // Update server turn state for polling fallback
      const nextTurn = prevTurn === "player1" ? "player2" : "player1";
      fetch(`/api/hex-duel/multiplayer/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId: multiplayerGameId, turn: nextTurn }),
      }).catch(() => {});
    }
  }, [endTurn, gameMode, sendMultiplayerAction, recordMultiplayerAction, multiplayerGameId, currentTurn]);

  // ── Action-based sync: poll server for opponent actions we might have missed ──
  // Equivalent to dice duel polling /api/dice-duel/get-match every 1.5s
  useEffect(() => {
    if (gameMode !== "multiplayer" || !multiplayerGameId || !opponentReadyRef.current || isGameOverRef.current) return;

    let cancelled = false;

    const pollActions = async () => {
      try {
        const res = await fetch(
          `/api/hex-duel/multiplayer/actions?gameId=${multiplayerGameId}&afterId=${lastKnownActionIdRef.current}`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (cancelled || !data?.success) return;

        const actions = data.actions || [];
        if (actions.length > 0) {
          // Apply any missed opponent actions to catch up.
          // Process sequentially with await to avoid stale closures
          // overwriting each other's state updates.
          for (const a of actions) {
            if (cancelled || isGameOverRef.current) break;
            // Skip actions already received via socket (dedup by content signature)
            const sig = `${a.actionType}:${a.sourceKey ?? ""}:${a.targetKey ?? ""}:${a.troopCount ?? ""}`;
            if (processedSocketActionsRef.current.has(sig)) continue;
            await new Promise((r) => setTimeout(r, 0)); // yield to flush React state
            applyRemoteActionRef.current({
              type: a.actionType,
              sourceKey: a.sourceKey,
              targetKey: a.targetKey,
              troopCount: a.troopCount,
            });
          }
          // Update the last known action ID so we don't re-process
          lastKnownActionIdRef.current = data.latestActionId || 0;
        }
      } catch {
        // Ignore poll errors — socket handles real-time sync
      }
    };

    // Poll every 1.5 seconds (faster catch-up for missed socket events)
    pollActions();
    const interval = setInterval(pollActions, 1500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gameMode, multiplayerGameId, opponentReady, effectiveWinner]);

  // ── Turn-status polling: last-resort sync for when socket events are missed ──
  // Periodically checks the server-stored currentTurn and applies a missed
  // opponent endTurn if the server says it's our turn but locally it isn't.
  const localTurnRef = useRef(currentTurn);
  localTurnRef.current = currentTurn;
  const isPlayer1Ref = useRef(isPlayer1);
  isPlayer1Ref.current = isPlayer1;
  useEffect(() => {
    if (gameMode !== "multiplayer" || !multiplayerGameId || !opponentReadyRef.current || isGameOverRef.current) return;

    let cancelled = false;

    const pollTurn = async () => {
      try {
        const res = await fetch(
          `/api/hex-duel/multiplayer/status?gameId=${multiplayerGameId}`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (cancelled || !data?.success || !data.game?.currentTurn) return;

        const serverTurn = data.game.currentTurn as DuelPlayer;
        const myTurn: DuelPlayer = isPlayer1Ref.current ? "player1" : "player2";

        // Only apply the missed endTurn when the server says it's our turn
        // but locally we think it's still the opponent's (we missed their endTurn).
        if (
          serverTurn === myTurn &&
          localTurnRef.current !== myTurn &&
          !isGameOverRef.current
        ) {
          applyRemoteActionRef.current({ type: "endTurn" });
        }
      } catch {
        // Ignore poll errors
      }
    };

    pollTurn();
    const interval = setInterval(pollTurn, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gameMode, multiplayerGameId, opponentReady, effectiveWinner]);

  // ── Spectator polling: poll /spectate to get full state and actions ──
  useEffect(() => {
    if (!isSpectator || !multiplayerGameId || isGameOverRef.current) return;

    let cancelled = false;

    const pollSpectate = async () => {
      try {
        const res = await fetch(
          `/api/hex-duel/multiplayer/spectate?gameId=${multiplayerGameId}&afterId=${lastKnownActionIdRef.current}`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (cancelled || !data?.success) return;

        // ── Spectator heartbeat to keep lobby spectator counts live ──
        const now = Date.now();
        if (data.game?.player1Id && (!lastHeartbeatRef.current || now - lastHeartbeatRef.current > 5000)) {
          lastHeartbeatRef.current = now;
          fetch("/api/spectators/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              gameKey: "hex-duel",
              gameId: multiplayerGameId,
              targetClerkId: data.game.player1Id,
            }),
          }).catch(() => {});
        }

        if (data.game) {
          if (data.game.player1Name) setPlayer1Name(data.game.player1Name);
          if (data.game.player2Name) setOpponentName(data.game.player2Name);
        }

        const actions = data.actions || [];
        if (actions.length > 0) {
          for (const a of actions) {
            if (cancelled || isGameOverRef.current) break;
            // Skip actions already received via socket (dedup by content signature)
            const sig = `${a.actionType}:${a.sourceKey ?? ""}:${a.targetKey ?? ""}:${a.troopCount ?? ""}`;
            if (processedSocketActionsRef.current.has(sig)) continue;
            await new Promise((r) => setTimeout(r, 0)); // yield to flush React state
            applyRemoteActionRef.current({
              type: a.actionType,
              sourceKey: a.sourceKey,
              targetKey: a.targetKey,
              troopCount: a.troopCount,
            });
          }
          lastKnownActionIdRef.current = data.latestActionId || 0;
        }
      } catch {
        // Ignore poll errors
      }
    };

    pollSpectate();
    const interval = setInterval(pollSpectate, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isSpectator, multiplayerGameId, effectiveWinner]);

  // Update initial turn state on server when game starts
  useEffect(() => {
    if (gameMode === "multiplayer" && multiplayerGameId && opponentReady && isPlayer1) {
      // Host initializes the turn state on the server
      fetch(`/api/hex-duel/multiplayer/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId: multiplayerGameId }),
      }).catch(() => {});
    }
  }, [gameMode, multiplayerGameId, opponentReady, isPlayer1]);

  const handleSkipRound = useCallback(() => {
    skipRound();
    if (gameMode === "multiplayer") {
      const action: MultiplayerAction = { type: "skipRound" };
      sendMultiplayerAction(action);
      recordMultiplayerAction(action);
    }
  }, [skipRound, gameMode, sendMultiplayerAction, recordMultiplayerAction]);

  const handleRestart = useCallback(() => {
    resetGame(); setGameMode("idle"); setWager(0); setWagerError(null);
    setPayoutResult(null); payoutProcessedRef.current = false; startedAtRef.current = null; fetchBalance();
    setMultiplayerGameId(null); setOpponentReady(false); opponentReadyRef.current = false; multiplayerJoinedRef.current = false;
    lastKnownActionIdRef.current = 0;
    setIsSpectator(false);
    window.history.replaceState({}, '', window.location.pathname);
  }, [resetGame, fetchBalance]);

  // ── Action system: wrapped click, confirm, clear ──────────────────

  const handleTileClickWithActions = useCallback((x: number, y: number) => {
    const key = `${x},${y}`;

    // No action selected → nothing to do (engine has no old immediate actions)
    if (!selectedAction) return;

    // ── Attack action mode ────────────────────────────────────────────
    if (selectedAction === "attack") {
      if (pendingActionPhase === null || pendingActionPhase === "selectTarget") {
        // Click on an attackable tile (enemy or neutral)
        if (attackableTargets.some((t) => t.x === x && t.y === y)) {
          setPendingTarget({ x, y });
          setPendingActionPhase("selectSource");
          setPendingTroopCount(1);
        }
      } else if (pendingActionPhase === "selectSource") {
        // Check if clicking a different attackable target -> switch target
        if (attackableTargets.some((t) => t.x === x && t.y === y)) {
          const isNewTarget = !pendingTarget || pendingTarget.x !== x || pendingTarget.y !== y;
          if (isNewTarget) {
            // Switch to attacking this new target instead
            setPendingTarget({ x, y });
            setPendingTroopCount(1);
          } else {
            // Clicking the same target again -> deselect, go back to selectTarget
            setPendingTarget(null);
            setPendingActionPhase("selectTarget");
            setPendingTroopCount(1);
          }
        } else {
          // Click on a friendly source adjacent to the target
          const sources = getAttackSources(`${pendingTarget!.x},${pendingTarget!.y}`);
          if (sources.some((s) => s.x === x && s.y === y)) {
            setPendingSource({ x, y });
            setPendingActionPhase("inputTroops");
            // Calculate max troops
            const sourceTroops = tileTroops[key] ?? 1;
            setPendingTroopCount(Math.min(sourceTroops - 1, 1));
          }
        }
      }
      return;
    }

    // ── Displace action mode ───────────────────────────────────────────
    if (selectedAction === "displace") {
      if (pendingActionPhase === null || pendingActionPhase === "selectTarget") {
        // Click on a friendly tile (displace candidate)
        if (capturedTiles[key] === currentTurn) {
          setPendingTarget({ x, y });
          setPendingActionPhase("selectSource");
          setPendingTroopCount(1);
        }
      } else if (pendingActionPhase === "selectSource") {
        // Click on a source friendly tile adjacent to the target with extra troops
        const sources = getDisplaceSources(`${pendingTarget!.x},${pendingTarget!.y}`);
        if (sources.some((s) => s.x === x && s.y === y)) {
          setPendingSource({ x, y });
          setPendingActionPhase("inputTroops");
          // Pre-fill with max available
          const sourceTroops = tileTroops[key] ?? 1;
          setPendingTroopCount(Math.min(sourceTroops - 1, 1));
        }
      }
      return;
    }
  }, [selectedAction, pendingActionPhase, pendingTarget, attackableTargets, getAttackSources, getDisplaceSources, capturedTiles, currentTurn, tileTroops]);



  const handleConfirmAction = useCallback(() => {
    if (selectedAction === "attack" && pendingSource && pendingTarget && pendingActionPhase === "inputTroops") {
      const sourceKey = `${pendingSource.x},${pendingSource.y}`;
      const targetKey = `${pendingTarget.x},${pendingTarget.y}`;
      handleAttack(sourceKey, targetKey, pendingTroopCount);
      // Send action to opponent in multiplayer AND record to server.
      // Note: do NOT send a separate endTurn here — handleAttack auto-switches
      // the turn when AP depletes, and the receiver's applyRemoteAction will
      // also auto-switch. Sending an extra endTurn causes a double-switch bug.
      if (gameMode === "multiplayer") {
        const action: MultiplayerAction = { type: "attack", sourceKey, targetKey, troopCount: pendingTroopCount };
        sendMultiplayerAction(action);
        recordMultiplayerAction(action);
      }
      // Reset flow
      setPendingActionPhase(null);
      setPendingTarget(null);
      setPendingSource(null);
      setSelectedAction(null);
      setPendingTroopCount(1);
    } else if (selectedAction === "displace" && pendingSource && pendingTarget && pendingActionPhase === "inputTroops") {
      const sourceKey = `${pendingSource.x},${pendingSource.y}`;
      const targetKey = `${pendingTarget.x},${pendingTarget.y}`;
      handleDisplace(sourceKey, targetKey, pendingTroopCount);
      // Send action to opponent in multiplayer AND record to server.
      // Note: do NOT send a separate endTurn here — handleDisplace auto-switches
      // the turn when AP depletes, and the receiver's applyRemoteAction will
      // also auto-switch. Sending an extra endTurn causes a double-switch bug.
      if (gameMode === "multiplayer") {
        const action: MultiplayerAction = { type: "displace", sourceKey, targetKey, troopCount: pendingTroopCount };
        sendMultiplayerAction(action);
        recordMultiplayerAction(action);
      }
      // Reset flow
      setPendingActionPhase(null);
      setPendingTarget(null);
      setPendingSource(null);
      setSelectedAction(null);
      setPendingTroopCount(1);
    }
  }, [selectedAction, pendingSource, pendingTarget, pendingActionPhase, pendingTroopCount, handleAttack, handleDisplace, gameMode, sendMultiplayerAction, recordMultiplayerAction]);

  const handleSelectUnit = useCallback(() => {
    // No-op in new system
  }, []);

  const handleClearAction = useCallback(() => {
    setPendingActionPhase(null);
    setPendingTarget(null);
    setPendingSource(null);
    setSelectedAction(null);
    setPendingTroopCount(1);
  }, []);

  // Clear action state on turn change
  useEffect(() => {
    setSelectedAction(null);
    setPendingActionPhase(null);
    setPendingTarget(null);
    setPendingSource(null);
    setPendingTroopCount(1);
  }, [currentTurn]);

  // ── Derived pending state ──────────────────────────────────────────
  const pendingDescription = useMemo<string | null>(() => {
    if (selectedAction === "attack") {
      if (pendingActionPhase === "selectTarget") {
        return "Click an enemy tile to attack";
      }
      if (pendingActionPhase === "selectSource") {
        return `Attack (${pendingTarget!.x},${pendingTarget!.y}) — click source tile`;
      }
      if (pendingActionPhase === "inputTroops" && pendingSource && pendingTarget) {
        const sourceKey = `${pendingSource.x},${pendingSource.y}`;
        const maxSend = (tileTroops[sourceKey] ?? 1) - 1;
        return `Attack from (${pendingSource.x},${pendingSource.y}) → (${pendingTarget.x},${pendingTarget.y}) — send ${pendingTroopCount} of ${maxSend} troops`;
      }
    }
    if (selectedAction === "displace") {
      if (pendingActionPhase === "selectTarget") {
        return "Click a friendly tile to reinforce";
      }
      if (pendingActionPhase === "selectSource") {
        return `Reinforce (${pendingTarget!.x},${pendingTarget!.y}) — click source with spare troops`;
      }
      if (pendingActionPhase === "inputTroops" && pendingSource && pendingTarget) {
        const sourceKey = `${pendingSource.x},${pendingSource.y}`;
        const maxSend = (tileTroops[sourceKey] ?? 1) - 1;
        return `Move ${pendingTroopCount} troops from (${pendingSource.x},${pendingSource.y}) → (${pendingTarget.x},${pendingTarget.y})`;
      }
    }
    return null;
  }, [selectedAction, pendingActionPhase, pendingTarget, pendingSource, pendingTroopCount, tileTroops]);

  const hasPending = useMemo(
    () => pendingActionPhase === "inputTroops",
    [pendingActionPhase]
  );

  // Max troops available to send from the selected source
  const maxSendTroops = useMemo(() => {
    if (!pendingSource) return 0;
    const key = `${pendingSource.x},${pendingSource.y}`;
    return (tileTroops[key] ?? 1) - 1; // must leave at least 1
  }, [pendingSource, tileTroops]);

  // ── Perspective-aware mapping: local player always blue, opponent always red ──
  // Computed here after all dependencies (troop totals, clock) are declared
  const localPlayerIsP1 = gameMode !== "multiplayer" || isPlayer1;
  const localDuelPlayer: DuelPlayer = localPlayerIsP1 ? "player1" : "player2";
  const opponentDuelPlayer: DuelPlayer = localPlayerIsP1 ? "player2" : "player1";
  const localColor = "#22d3ee";
  const opponentColor = "#ef4444";

  // Stats for local player
  const localMoves = localPlayerIsP1 ? p1MoveCount : p2MoveCount;
  const localTerritory = localPlayerIsP1 ? p1Territory : p2Territory;
  const localTotalTroops = localPlayerIsP1 ? p1TotalTroops : p2TotalTroops;
  const localClockTime = localPlayerIsP1 ? clock.p1TimeLeft : clock.p2TimeLeft;
  const localIsWinner = effectiveWinner === localDuelPlayer;
  const localIsActive = currentTurn === localDuelPlayer;

  // Stats for opponent
  const opponentMoves = localPlayerIsP1 ? p2MoveCount : p1MoveCount;
  const opponentTerritory = localPlayerIsP1 ? p2Territory : p1Territory;
  const opponentTotalTroops = localPlayerIsP1 ? p2TotalTroops : p1TotalTroops;
  const opponentClockTime = localPlayerIsP1 ? clock.p2TimeLeft : clock.p1TimeLeft;
  const opponentIsWinner = effectiveWinner === opponentDuelPlayer;
  const opponentIsActive = currentTurn === opponentDuelPlayer;

  // Labels
  const localLabel = isSpectator ? (player1Name || "Player 1") : (user?.firstName || user?.username || "You");
  const opponentLabel = aiEnabled ? "AI" : gameMode === "multiplayer" ? (opponentName || "Opponent") : "Player 2";

  // Fetch opponent name via status API when multiplayer game becomes ready
  useEffect(() => {
    if (gameMode !== "multiplayer" || !multiplayerGameId || !opponentReady) return;
    fetch(`/api/hex-duel/multiplayer/status?gameId=${multiplayerGameId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        if (d?.success && d.game) {
          const oppName = isPlayer1 ? d.game.player2Name : d.game.player1Name;
          if (oppName) setOpponentName(oppName);
          const oppId = isPlayer1 ? d.game.player2Id : d.game.player1Id;
          if (oppId) setOpponentClerkId(oppId);
        }
      })
      .catch(() => {});
  }, [gameMode, multiplayerGameId, opponentReady, isPlayer1]);

  // ── Waiting for opponent UI ───────────────────────────────────────
  if (gameMode === "multiplayer" && multiplayerGameId && !opponentReady) {
    return (
      <>
        <style>{GLOBAL_KEYFRAMES}</style>
        <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-4 pt-20 text-white">
          <NavigationBar currentPath="/casino" />

          {/* Connection banner on waiting screen too */}
          <ConnectionBanner
            status={connectionStatus}
            onReconnect={() => {
              if (socket && connectionStatus === "connection_lost") {
                socket.connect();
                if (multiplayerGameId) {
                  socket.emit("hexDuel:join", { gameId: multiplayerGameId });
                }
              }
            }}
          />

          <div className="mx-auto w-full max-w-7xl px-2 sm:px-4 lg:px-6">
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center">
              {connectionStatus === "opponent_disconnected" ? (
                <>
                  <div className="mb-6">
                    <span className="inline-block w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
                      <span className="text-3xl">😞</span>
                    </span>
                  </div>
                  <h2 className="text-xl font-black text-red-400 mb-2">
                    Opponent Disconnected
                  </h2>
                  <p className="text-sm text-slate-300 mb-4">
                    The other player left before the game started.
                  </p>
                  <p className="text-xs text-slate-500 animate-pulse">
                    Returning to lobby...
                  </p>
                </>
              ) : (
                <>
                  <div className="mb-6">
                    <span className="inline-block w-16 h-16 rounded-full border-4 border-cyan-400/30 border-t-cyan-400 animate-spin" />
                  </div>
                  <h2 className="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-blue-400 mb-2">
                    Waiting for Opponent
                  </h2>
                  <p className="text-sm text-slate-400 mb-4">
                    Game #{multiplayerGameId} — {isPlayer1 ? "Player 1 (Host)" : "Player 2"}
                  </p>
                  <p className="text-xs text-slate-500">
                    Another player needs to join before the match starts...
                  </p>
                  <button
                    onClick={handleRestart}
                    className="mt-8 text-xs text-slate-500 hover:text-slate-300 transition underline underline-offset-4"
                  >
                    Cancel &amp; Return to Lobby
                  </button>
                </>
              )}
            </div>
          </div>
        </main>
      </>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <>
      {/* Global keyframes */}
      <style>{GLOBAL_KEYFRAMES}</style>

      <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-4 pt-20 text-white">
        <NavigationBar currentPath="/casino" />

        {/* Connection banner — pulsing red indicator for disconnects */}
        {gameMode === "multiplayer" && (
          <ConnectionBanner
            status={connectionStatus}
            onReconnect={() => {
              if (socket) {
                socket.connect();
                if (multiplayerGameId) {
                  socket.emit("hexDuel:join", { gameId: multiplayerGameId });
                }
              }
            }}
          />
        )}

        <div className="mx-auto w-full max-w-7xl px-2 sm:px-4 lg:px-6">
          {/* ── Premium Header ──────────────────────────────────────── */}
          <div className="mb-4 text-center">
            <h1
              className="text-3xl sm:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-fuchsia-400"
              style={{ animation: "headerGlow 3s ease-in-out infinite" }}
            >
              HEX DUEL
            </h1>
            <p className="mt-1 text-sm text-slate-400 uppercase tracking-[0.2em]">Tactical Hex Arena</p>

            {showGame && gameMode === "real" && (
              <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-white/[0.04] border border-white/10 px-4 py-1.5 backdrop-blur-sm">
                <span className="text-[10px] text-slate-500 uppercase tracking-widest">Balance</span>
                <span className="text-sm font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500">
                  {balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-[9px] text-slate-500">tokens</span>
              </div>
            )}
            {showGame && gameMode === "for-fun" && (
              <p className="mt-2 text-[10px] text-purple-400/70 font-medium">🎮 Play-for-Fun mode — no real tokens</p>
            )}

            {/* History link */}
            {isSignedIn && (
              <button
                onClick={() => router.push("/casino/hex-duel/history")}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[11px] font-medium border border-white/10 text-slate-400 hover:text-white hover:border-white/20 hover:bg-white/5 transition-all duration-200"
              >
                📋 Match History
              </button>
            )}
          </div>

          {/* ── AI Control Panel ────────────────────────────────────── */}
          {showGame && p1MoveCount === 0 && p2MoveCount === 0 && (
            <div className="mb-4 flex items-center justify-center gap-4 flex-wrap">
              <button
                onClick={() => {
  if (p1MoveCount === 0 && p2MoveCount === 0) {
    handleToggleAI();
  }
}}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-[0.12em] transition-all duration-200 border ${
                  aiEnabled
                    ? "bg-purple-500/30 text-purple-200 border-purple-400/60 shadow-[0_0_12px_rgba(168,85,247,0.3)]"
                    : "border-white/15 text-slate-400 hover:text-white hover:border-white/30 hover:bg-white/5"
                }`}
              >
                {aiEnabled ? "🤖 AI: ON" : "🤖 VS AI"}
              </button>

              {aiEnabled && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest">Difficulty:</span>
                  {(["easy", "medium"] as AIDifficulty[]).map((d) => (
                    <button
                      key={d}
                      onClick={() => handleDifficultyChange(d)}
                      className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-200 border capitalize ${
                        aiDifficulty === d
                          ? d === "easy" ? "bg-green-500/20 text-green-300 border-green-400/60" : "bg-yellow-500/20 text-yellow-300 border-yellow-400/60"
                          : "border-white/10 text-slate-400 hover:text-white hover:border-white/20"
                      }`}
                    >{d}</button>
                  ))}
                </div>
              )}

              {aiEnabled && aiAction && aiThinking && (
                <span className="text-[10px] text-purple-400/70 animate-pulse">🤖 AI analyzing...</span>
              )}

                      {/* Sound toggle */}
              <button
                onClick={() => audio.setEnabled(!audio.enabled)}
                className={`px-3 py-1.5 rounded-lg text-[10px] transition-all duration-200 border ${
                  audio.enabled ? "border-white/10 text-slate-400" : "border-red-400/40 text-red-400/60"
                }`}
                title={audio.enabled ? "Mute sounds" : "Unmute sounds"}
              >
                {audio.enabled ? "🔊" : "🔇"}
              </button>


            </div>
          )}

          {/* ── Status Bar ──────────────────────────────────────────── */}
          {showGame && (
            <div className="mb-6">
              <StatusBar
                currentTurn={currentTurn} currentAP={currentAP} maxAP={maxAP}
                onEndTurn={handleEndTurn}                isGameOver={isGameOver}
                aiThinking={aiThinking} aiEnabled={aiEnabled}
                showEndTurn={!isSpectator && (gameMode !== "multiplayer" || isLocalTurn)}
                isLocalTurn={isLocalTurn && !(aiEnabled && currentTurn === "player2")}
              />
            </div>
          )}

          {/* ── Main layout ─────────────────────────────────────────── */}
          {showGame && (
            <div
              className="
                grid
                gap-3 sm:gap-4 lg:gap-5
                items-start

                grid-cols-1
                lg:grid-cols-[220px_minmax(0,1fr)_220px]
                xl:grid-cols-[260px_minmax(0,1fr)_260px]
                2xl:grid-cols-[280px_minmax(0,1fr)_280px]
              "
            >
              <div className="order-2 lg:order-1 w-full max-w-xs mx-auto lg:mx-0 space-y-3">
                <PlayerCard
                  player={localDuelPlayer} label={localLabel}
                  isActive={localIsActive} isSelected={false}
                  color={localColor} moves={localMoves} territory={localTerritory}
                  currentAP={localIsActive ? currentAP : 0} maxAP={maxAP}
                  isWinner={localIsWinner} isLocal={true} turnJustChanged={turnJustChanged}
                  totalTroops={localTotalTroops} maxTroops={maxTroops}
                  clockTime={localClockTime}
                />
                {showGame && !isSpectator && (
                  <HexActionPanel
                    currentTurn={currentTurn}
                    currentAP={currentAP}
                    maxAP={maxAP}
                    selectedUnit={selectedUnit}
                    validMoves={validMoves}
                    selectedAction={selectedAction}
                    onSelectAction={setSelectedAction}
                    onSelectUnit={handleSelectUnit}
                    pendingDescription={pendingDescription}
                    hasPending={hasPending}
                    onConfirm={handleConfirmAction}
                    onClearAction={handleClearAction}
                    isGameOver={isGameOver}
                    playerLabel={localLabel}
                    playerColor={localColor}
                    isActive={isLocalTurn && localIsActive && !aiThinking}
                    isAITurn={false}
                    onEndTurn={handleEndTurn}
                    onSkipRound={handleSkipRound}
                  />
                )}
                {/* Troop count input when in inputTroops phase */}
                {pendingActionPhase === "inputTroops" && (
                  <div className="rounded-xl border border-white/10 bg-gradient-to-b from-[#071230]/80 to-[#0a1a3f]/60 p-3 backdrop-blur-sm">
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Troops to send</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={maxSendTroops}
                        value={pendingTroopCount}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setPendingTroopCount(Math.max(1, Math.min(val, maxSendTroops)));
                        }}
                        className="w-20 rounded-lg bg-[#020617] border border-white/15 px-3 py-2 text-white text-sm text-center
                          focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none transition"
                      />
                      <span className="text-[10px] text-slate-400">/ {maxSendTroops}</span>
                    </div>
                    <div className="flex gap-1.5 mt-2">
                      {[1, 3, 5, 10].filter((n) => n <= maxSendTroops).map((n) => (
                        <button
                          key={n}
                          onClick={() => setPendingTroopCount(n)}
                          className={`px-2 py-1 rounded text-[10px] font-bold transition-all border ${
                            pendingTroopCount === n
                              ? "bg-cyan-500/20 text-cyan-300 border-cyan-400/50"
                              : "bg-white/[0.03] text-slate-400 border-white/10 hover:border-white/20"
                          }`}
                        >{n}</button>
                      ))}
                      <button
                        onClick={() => setPendingTroopCount(maxSendTroops)}
                        className={`px-2 py-1 rounded text-[10px] font-bold transition-all border ${
                          pendingTroopCount === maxSendTroops
                            ? "bg-cyan-500/20 text-cyan-300 border-cyan-400/50"
                            : "bg-white/[0.03] text-slate-400 border-white/10 hover:border-white/20"
                        }`}
                      >MAX</button>
                    </div>
                  </div>
                )}
              </div>
              <div className="order-1 lg:order-2 flex flex-col items-center w-full">
                {/* Waiting overlay for opponent's turn in multiplayer */}
                {gameMode === "multiplayer" && !isLocalTurn && !isGameOver && opponentReady && (
                  <div
                    className="relative z-20 mb-3 w-full max-w-md mx-auto rounded-xl border border-red-500/20 bg-gradient-to-b from-[#071230]/90 to-[#0a1a3f]/80 backdrop-blur-md p-4 text-center"
                    style={{ animation: "waitingFadeIn 0.4s ease-out, waitingPulse 2s ease-in-out infinite" }}
                  >
                    <div className="flex items-center justify-center gap-3">
                      <span
                        className="inline-block w-5 h-5 rounded-full border-2 border-red-400/30 border-t-red-400"
                        style={{ animation: "waitingSpin 0.8s linear infinite" }}
                      />
                      <span className="text-xs font-bold uppercase tracking-[0.15em] text-red-300">
                        Waiting for opponent...
                      </span>
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-500">
                      {opponentLabel} is planning their next move
                    </p>
                  </div>
                )}
                <div className="flex justify-center overflow-x-auto overflow-y-hidden px-1 sm:px-2 -mx-1 sm:-mx-2" style={{ scrollbarWidth: "none" }}>
                <HexBoard
                  grid={grid}
                  selectedTile={selectedTile}
                  onTileClick={handleTileClickWithActions}
                  recentlyCaptured={recentlyCaptured}
                  disabled={
  isGameOver || isSpectator ||
  (aiThinking && currentTurn === "player2") 
}
                  attackHighlightKeys={
  isGameOver || (aiThinking && currentTurn === "player2")
    ? []
    : selectedAction === "attack"
    ? attackHighlightKeys
    : selectedAction === "displace"
    ? displaceHighlightKeys
    : []
}
                  sourceHighlightKeys={
  isGameOver || (aiThinking && currentTurn === "player2")
    ? []
    : sourceHighlightKeys
}
                />
              </div>
              </div>
              <div className="order-3 w-full max-w-xs mx-auto lg:mx-0 space-y-3">
                <PlayerCard
                  player={opponentDuelPlayer} label={opponentLabel}
                  isActive={opponentIsActive} isSelected={false}
                  color={opponentColor} moves={opponentMoves} territory={opponentTerritory}
                  currentAP={opponentIsActive ? currentAP : 0} maxAP={maxAP}
                  isWinner={opponentIsWinner} isAI={aiEnabled} isLocal={false} turnJustChanged={turnJustChanged}
                  totalTroops={opponentTotalTroops} maxTroops={maxTroops}
                  clockTime={opponentClockTime}
                />
                {/* Action history log — visible for all game modes */}
                {showGame && actionLog.length > 0 && (
                  <HexActionLog log={actionLog} compact={true} />
                )}
              </div>
            </div>
          )}

          {/* ── Forfeit button ──────────────────────────────────────── */}
          {showGame && !isGameOver && (
            <div className="mt-6 text-center">                <button onClick={() => { if (isSpectator) handleRestart(); else setShowResignConfirm(true); }} className="text-xs text-slate-500 hover:text-slate-300 transition underline underline-offset-4">
                {gameMode === "multiplayer" ? "Resign &amp; Return to Lobby" : "Forfeit &amp; Return to Lobby"}
              </button>
              {gameMode === "multiplayer" && !isSpectator && (
                <button
                  onClick={() => setShowReportModal(true)}
                  className="ml-4 text-xs text-slate-500 hover:text-red-400 transition underline underline-offset-4"
                >
                  🚩 Report Player
                </button>
              )}
            </div>
          )}

          {/* ── How to play ───────────────────────────────────────── */}
          <div className="mt-8 rounded-xl border border-white/[0.04] bg-[#050a18] p-4 text-center">
            <p className="text-[10px] text-slate-600 uppercase tracking-[0.25em] mb-2">▦ How to Play — Territory Conquest</p>
            <div className="flex flex-wrap items-center justify-center gap-3 text-[10px] text-slate-500">
              <span className="flex items-center gap-1"><span className="text-cyan-400">1.</span> Start with 5 troops on your ★ capital</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-yellow-400">2.</span> Select Attack (1 AP) to conquer adjacent enemy tiles</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-cyan-400">3.</span> Need 1 more troop than defender to conquer</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-green-400">4.</span> Use Displace (1 AP) to move troops between tiles</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-purple-400">5.</span> Each end-turn: +1 troop on all tiles, +1 AP (max 3)</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-red-400">6.</span> Conquer the enemy&apos;s ★ capital to win!</span>
            </div>
          </div>
        </div>

        {/* Wager modal */}
        {!showGame && (
          <WagerModal
            balance={balance} onStartFun={handleStartFun} onStartReal={handleStartReal}
            loading={wagerLoading} error={wagerError} isSignedIn={!!isSignedIn}
            onCreateMultiplayer={handleCreateMultiplayer}
            onJoinMultiplayer={(gameId) => handleJoinMultiplayer(gameId, false)}
            onQuickJoinMultiplayer={() => handleJoinMultiplayer(0, true)}
            onRefreshGames={fetchMultiplayerGames}
            multiplayerGames={multiplayerGames}
            multiplayerLoading={multiplayerLoading}
          />
        )}

        {/* Resign confirmation modal */}
        {showResignConfirm && (
          <ResignConfirmation
            gameMode={gameMode}
            onConfirm={async () => {
              setShowResignConfirm(false);

              // Emit resign event for multiplayer so opponent gets notified
              if (gameMode === "multiplayer" && socket && multiplayerGameId) {
                socket.emit("hexDuel:resign", { gameId: multiplayerGameId });
              }

              // Set winner override to trigger the losing popup and end-game settlement
              setWinnerOverride(opponentDuelPlayer);
            }}
            onCancel={() => setShowResignConfirm(false)}
          />
        )}

        {/* Victory / Lose modals */}
        {effectiveWinner && (() => {
          const localPlayerWon = gameMode === "multiplayer"
            ? (isPlayer1 && effectiveWinner === "player1") || (!isPlayer1 && effectiveWinner === "player2")
            : effectiveWinner === "player1";

          if (localPlayerWon) {
            const winnerLabel = effectiveWinner === "player1" ? "Player 1" : aiEnabled ? "AI" : gameMode === "multiplayer" ? "Player 2" : "Player 2";
            const winnerColor = effectiveWinner === "player1" ? "#22d3ee" : "#ef4444";
            return (
              <VictoryModal
                winner={effectiveWinner}
                winnerLabel={winnerLabel}
                winnerColor={winnerColor}
                winnerMoves={effectiveWinner === "player1" ? p1MoveCount : p2MoveCount}
                winnerTerritory={effectiveWinner === "player1" ? p1Territory : p2Territory}
                payoutInfo={payoutLoading ? null : (gameMode === "real" || gameMode === "multiplayer") ? payoutResult : null}
                onRestart={handleRestart}
              />
            );
          } else {
            const winnerLabel = effectiveWinner === "player1" ? "Player 1" : aiEnabled ? "AI" : gameMode === "multiplayer" ? "Opponent" : "Player 2";
            const winnerColor = effectiveWinner === "player1" ? "#22d3ee" : "#ef4444";
            return (
              <LoseModal
                winnerLabel={winnerLabel}
                winnerColor={winnerColor}
                winnerMoves={effectiveWinner === "player1" ? p1MoveCount : p2MoveCount}
                winnerTerritory={effectiveWinner === "player1" ? p1Territory : p2Territory}
                payoutInfo={payoutLoading ? null : (gameMode === "real" || gameMode === "multiplayer") ? payoutResult : null}
                onRestart={handleRestart}
                isMultiplayer={gameMode === "multiplayer"}
              />
            );
          }
        })()}

        {/* Report Modal */}
        <ReportModal
          isOpen={showReportModal}
          onClose={() => setShowReportModal(false)}
          onSubmit={async (reason, details) => {
            const opponentLabel = isPlayer1 ? "Player 2" : "Player 1";
            const res = await fetch("/api/reports/submit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                reportedClerkId: opponentClerkId || undefined,
                gameType: "hex-duel",
                gameId: multiplayerGameId ? String(multiplayerGameId) : undefined,
                reason,
                details: details || undefined,
              }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || "Failed to submit report");
          }}
          reportedPlayerName={isPlayer1 ? "Player 2" : "Player 1"}
          gameType="Hex Duel"
        />
      </main>
    </>
  );
}
