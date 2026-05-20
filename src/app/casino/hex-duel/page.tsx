"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useHexDuel, type DuelPlayer, type PushTarget } from "../../../lib/hexDuelEngine";
import { decideAIAction, type AIDifficulty, type AIAction } from "../../../lib/hexDuelAI";
import { useHexAudio } from "../../../lib/hexAudio";
import HexBoard from "../../../components/HexBoard";
import HexParticles from "../../../components/HexParticles";
import NavigationBar from "../../../components/navigation-bar";

const MOVE_COST = 1;

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
  0%   { opacity: 1; transform: scale(0.92); }
  30%  { opacity: 1; transform: scale(1.08); }
  100% { opacity: 0; transform: scale(1); }
}
@keyframes hexPushArrive {
  0%   { transform: scale(0.6); opacity: 0.3; }
  50%  { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes hexRipple {
  0%   { width: 4px; height: 4px; opacity: 0.8; }
  100% { width: 120px; height: 120px; opacity: 0; }
}
@keyframes hexAuraPulse {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50%      { opacity: 0.6; transform: scale(1.15); }
}
@keyframes cornerPulse {
  0%, 100% { border-color: rgba(34,211,238,0.4); }
  50%      { border-color: rgba(34,211,238,0.8); }
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

const QUICK_WAGERS = [10, 50, 100, 500];

function WagerModal({
  balance, onStartFun, onStartReal, loading, error, isSignedIn, onCreateMultiplayer, onViewMultiplayer,
}: {
  balance: number; onStartFun: () => void; onStartReal: (w: number) => void;
  loading: boolean; error: string | null; isSignedIn: boolean;
  onCreateMultiplayer: () => void; onViewMultiplayer: () => void;
}) {
  const [wager, setWager] = useState(50);
  const [playForFun, setPlayForFun] = useState(false);
  const canAfford = wager > 0 && wager <= balance;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Place Wager">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 p-6
          bg-gradient-to-b from-[#071230] via-[#0a1a3f] to-[#050d24]
          shadow-[0_0_60px_rgba(34,211,238,0.1)]"
        style={{ animation: "floatUp 0.35s ease-out" }}
      >
        <h2 className="text-center text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-fuchsia-400 mb-1">
          HEX DUEL
        </h2>
        <p className="text-center text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-4">Place Your Wager</p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button onClick={onStartFun} className="rounded-lg border border-white/15 bg-white/[0.02] py-2 text-[11px] font-semibold text-slate-200 hover:bg-white/[0.06]">Play vs AI</button>
          <button onClick={onCreateMultiplayer} className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 py-2 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20">Create Multiplayer</button>
        </div>
        <button onClick={onViewMultiplayer} className="mb-4 w-full rounded-lg border border-white/10 bg-white/[0.02] py-2 text-[10px] uppercase tracking-wider text-slate-400 hover:text-white">Available Games</button>

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
              {QUICK_WAGERS.map((amount) => (
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
          onClick={() => playForFun ? onStartFun() : onStartReal(wager)}
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
          ) : playForFun ? "🎮 Play for Fun" : `💰 Wager ${wager} Tokens`}
        </button>

        <p className="mt-3 text-center text-[9px] text-slate-600">
          Winner receives {playForFun ? "bragging rights" : "1.9× payout"}
        </p>
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
        <p className="mb-4 text-sm text-slate-400">Connected opposite sides of the arena</p>

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
//  Player Card (Enhanced with glass morphism + turn slide animation)
// ══════════════════════════════════════════════════════════════════════════

function PlayerCard({
  player, label, pos, isActive, isSelected, color, moves, territory, currentAP, maxAP, powerNodes, isWinner, isAI,
  turnJustChanged,
}: {
  player: DuelPlayer; label: string; pos: { x: number; y: number };
  isActive: boolean; isSelected: boolean; color: string;
  moves: number; territory: number; currentAP: number; maxAP: number;
  powerNodes: number; isWinner: boolean; isAI?: boolean;
  turnJustChanged: boolean;
}) {
  const borderColor = player === "player1" ? "border-cyan-400" : "border-red-500";
  const glowColor = player === "player1"
    ? "shadow-[0_0_18px_rgba(34,211,238,0.5)]"
    : "shadow-[0_0_18px_rgba(239,68,68,0.5)]";
  const bgColor = player === "player1"
    ? "from-cyan-500/20 to-blue-600/10"
    : "from-red-500/20 to-rose-600/10";
  const bonusCount = maxAP - 3;

  return (
    <div
      className={`
        rounded-xl border-2 p-4 transition-all duration-500
        bg-gradient-to-b ${bgColor} backdrop-blur-sm
        ${isActive ? `${borderColor} ${glowColor}` : "border-white/10 opacity-60"}
        ${isSelected ? "ring-2 ring-yellow-400 scale-[1.02]" : ""}
        ${isWinner ? "ring-2 ring-yellow-400 scale-[1.02]" : ""}
        ${turnJustChanged ? "animate-[turnSlideIn_0.4s_ease-out]" : ""}
      `}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color }}>{label}</span>
        {isWinner && (
          <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-yellow-400/30 text-yellow-200 border border-yellow-400/60 animate-pulse">
            🏆 WINNER
          </span>
        )}
        {!isWinner && isActive && (
          <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-yellow-400/20 text-yellow-300 border border-yellow-400/40 animate-pulse"
            style={{ animation: "turnSlideIn 0.3s ease-out" }}>
            {isAI ? "AI THINKING" : "YOUR TURN"}
          </span>
        )}
      </div>

      {isAI && (
        <div className="mb-3 -mt-1">
          <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40">
            🤖 AI
          </span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="relative w-10 h-10 sm:w-12 sm:h-12 rounded-full flex items-center justify-center shrink-0"
          style={{
            background: `radial-gradient(circle at 40% 35%, ${color}88, ${color})`,
            boxShadow: `0 0 16px ${color}66`,
          }}>
          <div className="w-3 h-3 sm:w-4 sm:h-4 rounded-full bg-white/80 shadow-[0_0_6px_white]" />
        </div>
        <div>
          <p className="text-lg sm:text-xl font-black text-white leading-none">({pos.x}, {pos.y})</p>
          <p className="text-[10px] text-slate-400 uppercase tracking-wider">hex position</p>
        </div>
      </div>

      {isActive && (
        <div className="mt-3 pt-3 border-t border-white/10">
          <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1.5">Action Points</p>
          <div className="flex items-center gap-2">
            <APPips current={currentAP} max={maxAP} color={color} bonusCount={bonusCount} />
            <span className="text-xs font-bold text-white/80">{currentAP}/{maxAP}</span>
          </div>
          {bonusCount > 0 && (
            <p className="text-[10px] text-purple-400 mt-1 font-medium animate-pulse">
              ⚡ +{bonusCount} from power nodes
            </p>
          )}
        </div>
      )}

      <div className={`${isActive ? "pt-2" : "pt-3"} mt-3 pt-3 border-t border-white/10`}>
        <div className="flex gap-4">
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Moves</p>
            <p className="text-lg font-black text-white">{moves}</p>
          </div>
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Territory</p>
            <p className="text-lg font-black text-white">{territory}</p>
          </div>
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Nodes</p>
            <p className="text-lg font-black text-purple-400">{powerNodes}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Status Bar (Enhanced with turn transition animations)
// ══════════════════════════════════════════════════════════════════════════

function StatusBar({
  currentTurn, currentAP, maxAP, selectedUnit, validMoves, pushTargets, onEndTurn, isGameOver, aiThinking, aiEnabled,
}: {
  currentTurn: DuelPlayer; currentAP: number; maxAP: number;
  selectedUnit: DuelPlayer | null; validMoves: { x: number; y: number }[];
  pushTargets: PushTarget[]; onEndTurn: () => void;
  isGameOver: boolean; aiThinking: boolean; aiEnabled: boolean;
}) {
  const turnColor = currentTurn === "player1" ? "#22d3ee" : "#ef4444";
  const turnLabel = currentTurn === "player1" ? "BLUE" : "RED";
  const bonusCount = maxAP - 3;
  const isAITurn = aiEnabled && currentTurn === "player2";

  let message: string;
  let subMessage: string | null = null;

  if (isGameOver) {
    message = "Game Over";
    subMessage = "A player has connected their sides!";
  } else if (aiThinking) {
    message = "AI is thinking...";
    subMessage = "Choosing the best move";
  } else if (isAITurn) {
    message = "AI's turn — auto-playing";
    subMessage = "Move (1 AP) or push adjacent enemy (2 AP)";
  } else if (selectedUnit && pushTargets.length > 0) {
    message = "Unit selected — move or push!";
    subMessage = `${validMoves.length} moves (1 AP) + 1 push (2 AP) available`;
  } else if (selectedUnit) {
    message = "Unit selected — choose an adjacent hex";
    subMessage = `${validMoves.length} valid move${validMoves.length !== 1 ? "s" : ""} highlighted (1 AP each)`;
  } else if (currentAP < MOVE_COST) {
    message = "No AP remaining";
    subMessage = "End your turn";
  } else {
    message = "Click your unit to select it";
    subMessage = "Move (1 AP) or push adjacent enemy (2 AP)";
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
            {turnLabel}&apos;S TURN
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
        <APPips current={currentAP} max={maxAP} color={isGameOver ? "#facc15" : turnColor} bonusCount={bonusCount} />
        <span className="text-[10px] text-slate-500 uppercase tracking-widest ml-1">{currentAP}/{maxAP}</span>
      </div>

      {!isGameOver && bonusCount > 0 && (
        <p className="text-[10px] text-purple-400 font-medium animate-pulse">
          ⚡ +{bonusCount} bonus AP from power nodes
        </p>
      )}

      <p className="text-xs text-slate-400" style={{ animation: "floatUp 0.3s ease-out" }}>{message}</p>
      {subMessage && (
        <p className={`text-[10px] ${isGameOver ? "text-yellow-400/90 font-bold" : currentAP < MOVE_COST ? "text-yellow-400/90 font-bold" : "text-yellow-400/70"}`}>
          {subMessage}
        </p>
      )}

      {!isGameOver && !isAITurn && (
        <button
          onClick={onEndTurn}
          className={`mt-2 px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-[0.15em] transition-all duration-200 ${
            currentAP < MOVE_COST
              ? "bg-yellow-400 text-black shadow-[0_0_14px_rgba(250,204,21,0.5)] hover:bg-yellow-300 hover:scale-105 hover:shadow-[0_0_20px_rgba(250,204,21,0.7)] animate-pulse"
              : "border border-white/15 text-slate-400 hover:text-white hover:border-white/30 hover:bg-white/5"
          }`}
        >
          {currentAP < MOVE_COST ? "⚡ End Turn" : "End Turn"}
        </button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Page
// ══════════════════════════════════════════════════════════════════════════

type GameMode = "idle" | "for-fun" | "real";

export default function HexDuelPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();

  const {
    grid, player1Pos, player2Pos, currentTurn, selectedUnit, validMoves, pushTargets,
    p1MoveCount, p2MoveCount, p1Territory, p2Territory, currentAP, maxAP,
    capturedTiles, selectedTile, recentlyCaptured, pushedHere,
    powerNodes, p1PowerNodes, p2PowerNodes, winner,
    handleTileClick, endTurn, resetGame,
  } = useHexDuel();

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
  const [payoutResult, setPayoutResult] = useState<{ wager: number; payout: number; multiplier: number } | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(false);
  const payoutProcessedRef = useRef(false);
  const startedAtRef = useRef<string | null>(null);

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

  const isGameOver = winner !== null;

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

  // Push sound
  const prevPushedLen = useRef(pushedHere.length);
  useEffect(() => {
    if (pushedHere.length > prevPushedLen.current && pushedHere.length > 0) {
      audio.playPush();
    }
    prevPushedLen.current = pushedHere.length;
  }, [pushedHere, audio]);

  // Move sound (when moveCount changes and it's not a capture/push)
  const prevMoveCount = useRef(0);
  useEffect(() => {
    const totalMoves = p1MoveCount + p2MoveCount;
    if (totalMoves > prevMoveCount.current && recentlyCaptured.length === 0 && pushedHere.length === 0) {
      audio.playMove();
    }
    prevMoveCount.current = totalMoves;
  }, [p1MoveCount, p2MoveCount, recentlyCaptured, pushedHere, audio]);

  // Select sound
  useEffect(() => {
    if (selectedUnit) audio.playSelect();
  }, [selectedUnit, audio]);

  // Power node capture sound
  const prevP1Nodes = useRef(p1PowerNodes);
  const prevP2Nodes = useRef(p2PowerNodes);
  useEffect(() => {
    if (p1PowerNodes > prevP1Nodes.current || p2PowerNodes > prevP2Nodes.current) {
      audio.playPowerNode();
    }
    prevP1Nodes.current = p1PowerNodes;
    prevP2Nodes.current = p2PowerNodes;
  }, [p1PowerNodes, p2PowerNodes, audio]);

  // Victory / defeat sounds
  const victoryPlayed = useRef(false);
  useEffect(() => {
    if (winner && !victoryPlayed.current) {
      victoryPlayed.current = true;
      if (winner === "player1") {
        setTimeout(() => audio.playVictory(), 300);
      } else {
        setTimeout(() => audio.playDefeat(), 300);
      }
    }
    if (!winner) victoryPlayed.current = false;
  }, [winner, audio]);

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

  // ── Wager handlers ─────────────────────────────────────────────────
  const handleStartFun = useCallback(() => { setAIEnabled(true); setGameMode("for-fun"); setWager(0); setWagerError(null); startedAtRef.current = new Date().toISOString(); }, []);
  const handleStartReal = useCallback(async (amount: number) => {
    setWagerLoading(true); setWagerError(null);
    try {
      const res = await fetch("/api/hex-duel/start-game", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ wager: amount }) });
      const data = await res.json();
      if (!res.ok || !data.success) { setWagerError(data.error || "Failed to start game"); return; }
      setBalance(Number(data.data.newBalance));
      setWager(amount);
      setGameMode("real");
      startedAtRef.current = new Date().toISOString();
    } catch { setWagerError("Network error — please try again"); }
    finally { setWagerLoading(false); }
  }, []);

  // ── End-game payout ────────────────────────────────────────────────
  useEffect(() => {
    if (!winner || gameMode === "idle" || payoutProcessedRef.current) return;
    payoutProcessedRef.current = true;
    setPayoutLoading(true);

    const durationSeconds = startedAtRef.current
      ? Math.round((Date.now() - new Date(startedAtRef.current).getTime()) / 1000)
      : 0;

    fetch("/api/hex-duel/end-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        wager: gameMode === "for-fun" ? 0 : wager,
        winner,
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
        } else if (d.success && gameMode === "real") {
          setPayoutResult({ wager: wager, payout: 0, multiplier: 0 });
          if (d.data.newBalance !== undefined) setBalance(Number(d.data.newBalance));
        } else if (gameMode === "for-fun") {
          setPayoutResult(null);
        }
      })
      .catch(() => {})
      .finally(() => setPayoutLoading(false));
  }, [winner, gameMode, wager, aiEnabled, aiDifficulty, p1MoveCount, p2MoveCount, p1Territory, p2Territory]);

  // ── AI helpers ─────────────────────────────────────────────────────
  const handleTileClickRef = useRef(handleTileClick);
  handleTileClickRef.current = handleTileClick;
  const endTurnRef = useRef(endTurn);
  endTurnRef.current = endTurn;

  const unitPositions = useMemo(() => [
    { x: player1Pos.x, y: player1Pos.y, owner: "player1" as const },
    { x: player2Pos.x, y: player2Pos.y, owner: "player2" as const },
  ], [player1Pos, player2Pos]);

  const pushTargetKeys = useMemo(() => pushTargets.map((p) => `${p.x},${p.y}`), [pushTargets]);
  const powerNodeKeys = useMemo(() => Array.from(powerNodes), [powerNodes]);

  // ── AI Turn Execution ──────────────────────────────────────────────
  useEffect(() => {
    if (!aiEnabled || currentTurn !== "player2" || winner || selectedUnit || gameMode === "idle") return;
    if (currentAP < MOVE_COST) {
      setAIThinking(true);
      const t = setTimeout(() => { endTurnRef.current(); setAIThinking(false); setAIAction({ type: "endTurn" }); }, 300);
      return () => clearTimeout(t);
    }
    setAIThinking(true); setAIAction(null);
    const t = setTimeout(() => { handleTileClickRef.current(player2Pos.x, player2Pos.y); }, 500);
    return () => clearTimeout(t);
  }, [aiEnabled, currentTurn, winner, selectedUnit, player2Pos, currentAP, gameMode]);

  useEffect(() => {
    if (!aiEnabled || currentTurn !== "player2" || winner || selectedUnit !== "player2" || gameMode === "idle") return;
    const t = setTimeout(() => { (async () => {
      const res = await fetch("/api/hex-duel/ai-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ difficulty: aiDifficulty, snapshot: {
        myPos: player2Pos, enemyPos: player1Pos,
        myPlayer: "player2", enemyPlayer: "player1",
        capturedTiles: { ...capturedTiles }, powerNodes: Array.from(powerNodes), currentAP,
      } }) });
      const data = await res.json();
      const action = data?.success ? data.action as AIAction : decideAIAction({
        myPos: player2Pos, enemyPos: player1Pos,
        myPlayer: "player2", enemyPlayer: "player1",
        capturedTiles: { ...capturedTiles }, powerNodes, currentAP,
      }, aiDifficulty);
      setAIAction(action);
      if (action.type === "endTurn") { endTurnRef.current(); setAIThinking(false); }
      else if (action.type === "move" || action.type === "push") { handleTileClickRef.current(action.x, action.y); }
    })().catch(() => setAIThinking(false)); }, 400);
    return () => clearTimeout(t);
  }, [aiEnabled, currentTurn, winner, selectedUnit, player2Pos, player1Pos, capturedTiles, currentAP, powerNodes, aiDifficulty, gameMode]);

  useEffect(() => {
    if (currentTurn === "player1" && aiThinking) { setAIThinking(false); setAIAction(null); }
  }, [currentTurn, aiThinking]);

  // ── Handlers ───────────────────────────────────────────────────────
  const handleToggleAI = useCallback(() => setAIEnabled((p) => { const n = !p; if (!n) { setAIThinking(false); setAIAction(null); } return n; }), []);
  const handleDifficultyChange = useCallback((diff: AIDifficulty) => setAIDifficulty(diff), []);
  const handleRestart = useCallback(() => {
    resetGame(); setGameMode("idle"); setWager(0); setWagerError(null);
    setPayoutResult(null); payoutProcessedRef.current = false; startedAtRef.current = null; fetchBalance();
  }, [resetGame, fetchBalance]);

  // ── Render ─────────────────────────────────────────────────────────
  const showGame = gameMode !== "idle";

  return (
    <>
      {/* Global keyframes */}
      <style>{GLOBAL_KEYFRAMES}</style>

      <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-4 pt-20 text-white">
        <NavigationBar currentPath="/casino" />

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
          {showGame && (
            <div className="mb-4 flex items-center justify-center gap-4 flex-wrap">
              <button
                onClick={handleToggleAI}
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
                selectedUnit={selectedUnit} validMoves={validMoves} pushTargets={pushTargets}
                onEndTurn={endTurn} isGameOver={isGameOver}
                aiThinking={aiThinking} aiEnabled={aiEnabled}
              />
            </div>
          )}

          {/* ── Main layout ─────────────────────────────────────────── */}
          {showGame && (
            <div
  className="
    grid
    gap-4 sm:gap-5 lg:gap-6
    items-start

    grid-cols-1
    lg:grid-cols-[220px_minmax(0,1fr)_220px]
  "
>   <div className="order-2 lg:order-1">
              <PlayerCard
                player="player1" label="Player 1" pos={player1Pos}
                isActive={currentTurn === "player1"} isSelected={selectedUnit === "player1"}
                color="#22d3ee" moves={p1MoveCount} territory={p1Territory}
                currentAP={currentAP} maxAP={maxAP} powerNodes={p1PowerNodes}
                isWinner={winner === "player1"} turnJustChanged={turnJustChanged}
              />
</div>
              <div className="order-1 lg:order-2 flex justify-center overflow-x-auto px-2 sm:px-4">
                <HexBoard
                  grid={grid}
                  selectedTile={isGameOver || aiThinking ? null : selectedTile}
                  onTileClick={handleTileClick}
                  unitPositions={unitPositions}
                  validMoves={isGameOver ? [] : validMoves}
                  recentlyCaptured={recentlyCaptured}
                  pushTargetKeys={isGameOver || aiThinking ? [] : pushTargetKeys}
                  pushedHere={pushedHere}
                  powerNodeKeys={powerNodeKeys}
                  disabled={isGameOver || aiThinking}
                />
              </div>
<div className="order-3">
              <PlayerCard
                player="player2" label={aiEnabled ? "AI" : "Player 2"} pos={player2Pos}
                isActive={currentTurn === "player2"} isSelected={selectedUnit === "player2"}
                color="#ef4444" moves={p2MoveCount} territory={p2Territory}
                currentAP={currentAP} maxAP={maxAP} powerNodes={p2PowerNodes}
                isWinner={winner === "player2"} isAI={aiEnabled} turnJustChanged={turnJustChanged}
              />
              </div>
            </div>
          )}

          {/* ── Forfeit button ──────────────────────────────────────── */}
          {showGame && !isGameOver && (
            <div className="mt-6 text-center">
              <button onClick={handleRestart} className="text-xs text-slate-500 hover:text-slate-300 transition underline underline-offset-4">
                Forfeit &amp; Return to Lobby
              </button>
            </div>
          )}

          {/* ── How to play ─────────────────────────────────────────── */}
          <div className="mt-8 rounded-xl border border-white/5 bg-white/[0.02] p-4 text-center backdrop-blur-sm">
            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-2">How to Play</p>
            <div className="flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-400">
              <span>1. Click your unit to select it</span>
              <span className="text-slate-600">→</span>
              <span>2. Valid hexes glow yellow</span>
              <span className="text-slate-600">→</span>
              <span>3. Click a hex to move (1 AP)</span>
              <span className="text-slate-600">→</span>
              <span>4. Click adjacent enemy to push (2 AP)</span>
              <span className="text-slate-600">→</span>
              <span>5. Control ⚡ nodes for +1 AP each turn</span>
              <span className="text-slate-600">→</span>
              <span>6. Connect opposite sides to win!</span>
            </div>
          </div>
        </div>

        {/* Wager modal */}
        {!showGame && (
          <WagerModal
            balance={balance} onStartFun={handleStartFun} onStartReal={handleStartReal}
            loading={wagerLoading} error={wagerError} isSignedIn={!!isSignedIn}
            onCreateMultiplayer={() => router.push("/casino/hex-duel/multiplayer")}
            onViewMultiplayer={() => router.push("/casino/hex-duel/multiplayer")}
          />
        )}

        {/* Victory modal */}
        {winner && (
          <VictoryModal
            winner={winner}
            winnerLabel={winner === "player1" ? "Player 1" : aiEnabled ? "AI" : "Player 2"}
            winnerColor={winner === "player1" ? "#22d3ee" : "#ef4444"}
            winnerMoves={winner === "player1" ? p1MoveCount : p2MoveCount}
            winnerTerritory={winner === "player1" ? p1Territory : p2Territory}
            payoutInfo={payoutLoading ? null : winner === "player1" && gameMode === "real" ? payoutResult : null}
            onRestart={handleRestart}
          />
        )}
      </main>
    </>
  );
}
