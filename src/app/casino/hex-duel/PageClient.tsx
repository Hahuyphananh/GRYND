"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDefaultWager } from "../../../hooks/useDefaultWager";
import { useUser } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useHexDuel, otherPlayer, type DuelPlayer } from "../../../lib/hexDuelEngine";
import { useSocket } from "../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../components/game/EmotePicker";
import useGameEmotes from "../../../hooks/useGameEmotes";
import { decideAIAction, type AIDifficulty, type AIAction, type AIStateSnapshot } from "../../../lib/hexDuelAI";
import { useHexAudio } from "../../../lib/hexAudio";
import { useChessClock } from "../../../lib/useChessClock";
import HexBoard from "../../../components/HexBoard";
import HexTroopCount from "../../../components/HexTroopCount";
import HexActionPanel, { type ActionType } from "../../../components/HexActionPanel";
import HexActionLog from "../../../components/HexActionLog";
import HexTroopPopup from "../../../components/HexTroopPopup";
import { clampSendCount, sendableTroops } from "../../../lib/hexTroopCount";
import NavigationBar from "../../../components/navigation-bar";
import { useRecordPlayedGame } from "../../../hooks/useRecordPlayedGame";
import useActiveGamePresence from "../../../hooks/useActiveGamePresence";

import MatchWaiting from "../../../components/lobby/MatchWaiting";
import ReportModal from "../../../components/ReportModal";
import PvpResultScreen from "../../../components/result/PvpResultScreen";
import FrameAvatar from "../../../components/FrameAvatar";
import { RulesModal, useFirstVisitRules } from "../../../components/lobby/PvpLobby";
import {
  IconDeviceGamepad2,
  IconGlobe,
  IconCoins,
  IconAlertTriangle,
  IconTrophy,
  IconRobot,
  IconBolt,
  IconMoodSad,
  IconNotebook,
  IconBook,
  IconVolume,
  IconVolumeOff,
  IconFlag,
  IconClock,
  IconHourglass,
  IconStar,
} from "@tabler/icons-react";

const ATTACK_COST = 1;
const DISPLACE_COST = 1;
const MOVE_COST = 1; // backward compat

// ══════════════════════════════════════════════════════════════════════════
//  CSS Keyframes (injected once)
// ══════════════════════════════════════════════════════════════════════════

const GLOBAL_KEYFRAMES = `
@keyframes victoryFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes victoryPopIn { from { opacity: 0; transform: scale(0.8) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
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
  const [wager, setWager] = useDefaultWager("hex-duel", 50);
  const [playForFun, setPlayForFun] = useState(false);
  const [queueMode, setQueueMode] = useState<"ai" | "multiplayer">("ai");
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("hex-duel");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);
  const canAfford = wager > 0 && wager <= balance;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Set Stake">
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
            <span className="text-xs">←</span> Back to Games
          </a>
        </div>
        <h2 className="text-center text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-fuchsia-400 mb-1">
          HEX DUEL
        </h2>
        <p className="text-center text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-3">Set Your Stake</p>

        {/* How to Play — rules modal at the top of the lobby */}
        <div className="mb-4 text-center">
          <button
            onClick={() => setShowRules(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
          >
            <IconBook size={15} /> How to Play
          </button>
        </div>
        {showRules && (
          <RulesModal
            title="How to Play: Territory Conquest"
            sections={[
              {
                heading: "Set up",
                body: <>Start with 5 troops on your <span className="text-yellow-300">★ capital</span>.</>,
              },
              {
                heading: "Attack",
                body: (
                  <>
                    Select Attack (1 AP) to conquer adjacent enemy tiles.
                    you need <b>1 more troop</b> than the defender to
                    conquer.
                  </>
                ),
              },
              {
                heading: "Displace",
                body: <>Use Displace (1 AP) to move troops between your tiles.</>,
              },
              {
                heading: "End turn",
                body: <>Each end-turn: +1 troop on all tiles and +1 AP (max 3).</>,
              },
              {
                heading: "Win condition",
                body: <>Conquer the enemy&apos;s <span className="text-yellow-300">★ capital</span> to win!</>,
              },
            ]}
            onClose={() => setShowRules(false)}
          />
        )}

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
            <p className="text-xs text-amber-300 font-medium">Sign in to stake tokens</p>
            <p className="text-[10px] text-slate-400 mt-1">You can still play for fun!</p>
          </div>
        )}        {!playForFun && (queueMode === "ai" ? (
          <div className="mb-4 rounded-lg border border-cyan-400/40 bg-cyan-500/15 p-3 text-center">
            <p className="mb-1 flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-cyan-300"><IconDeviceGamepad2 size={13} /> Free Play</p>
            <p className="text-[10px] text-cyan-100/70">No tokens are staked. Playing vs AI is free.</p>
          </div>
        ) : (
          <div className="mb-4">
            <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1.5 block">Stake Amount</label>
            <input
              type="number" value={wager} min={1} max={balance}
              aria-label="Stake amount"
              onChange={(e) => setWager(Number(e.target.value) || 0)}
              className="w-full rounded-lg bg-[#020617] border border-white/15 px-3 py-2 text-white text-sm
                focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none transition mb-3"
              placeholder="Enter stake..."
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
                  }`}>{amount}</button>
              ))}
            </div>
            {!canAfford && wager > 0 && (
              <p className="text-[10px] text-red-400 mt-2 font-medium">Insufficient balance. You need {wager} tokens</p>
            )}
          </div>
        ))}

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
          ) : (
            <span className="inline-flex items-center gap-2">
              {queueMode === "multiplayer"
                ? <><IconGlobe size={16} /> {playForFun ? "Create Multiplayer (Fun)" : `Stake ${wager} Tokens (Multiplayer)`}</>
                : queueMode === "ai"
                  ? <><IconDeviceGamepad2 size={16} /> Free Play vs AI</>
                  : <>{playForFun ? <><IconDeviceGamepad2 size={16} /> Play for Fun</> : <><IconCoins size={16} /> Stake {wager} Tokens vs AI</>}</>}
            </span>
          )}
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
  gameMode, noRealTokensWagered, onConfirm, onCancel,
}: {
  gameMode: GameMode;
  noRealTokensWagered?: boolean;
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
          <IconAlertTriangle size={28} className="text-red-400" />
        </div>
        <h2 className="mb-2 text-xl font-black text-red-400">Resign?</h2>
        <p className="mb-1 text-sm text-slate-400">
          {gameMode === "multiplayer"
            ? "Your opponent will win the match."
            : "You will forfeit this game."}
        </p>
        {gameMode === "real" && !noRealTokensWagered && (
          <p className="mb-4 text-[11px] text-yellow-400/80">You will lose your staked tokens.</p>
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
      {/* The same roll the board tiles use, so a player's total moves the
          same way the tiles feeding it do. */}
      <HexTroopCount
        value={troops}
        color={color}
        className="text-xs font-bold text-white/80 min-w-[2ch] text-right"
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Player Card (Enhanced with glass morphism + turn slide animation)
// ══════════════════════════════════════════════════════════════════════════

function PlayerCard({
  player, label, isActive, isSelected, color, moves, territory, currentAP, maxAP, isWinner, isAI,
  turnJustChanged, totalTroops, maxTroops, clockTime, isLocal,
  emoteBubble, emoteSide, iconKey, nameColor, profileFrame,
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
  emoteBubble?: { value: string; kind?: string } | null;
  emoteSide?: "mine" | "incoming";
  iconKey?: string | null;
  nameColor?: string | null;
  profileFrame?: unknown;
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
        {/* Player name chip — initial avatar + username, with the emote
            bubble anchored to the name so emotes "pop" on the sender's
            name (same treatment as mines / memory-grid / keno). */}
        <span className="relative flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-[0.2em]" style={{ color }}>
          {/* Official Grynd icon — falls back to a letter circle when
              the key is missing/invalid. */}
          <FrameAvatar frame={profileFrame} iconKey={iconKey} name={label} size="h-6 w-6" />
          <span className="truncate" style={nameColor ? { color: nameColor } : undefined}>
            {label}
          </span>
          <EmoteBubble emote={emoteBubble} side={emoteSide ?? "incoming"} />
        </span>
        <div className="flex items-center gap-2">
          {/* Chess clock display */}
          <span
            className={`text-[11px] font-bold tabular-nums ${
              isClockCritical ? "text-red-400 animate-pulse" : isClockUrgent ? "text-yellow-300" : "text-slate-400"
            }`}
          >
            <IconClock size={13} className="inline" /> {clockDisplay}
          </span>
          {isWinner && (
            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-yellow-400/30 text-yellow-200 border border-yellow-400/60 animate-pulse">
              <span className="inline-flex items-center gap-1"><IconTrophy size={12} /> WINNER</span>
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
            <span className="inline-flex items-center gap-1"><IconRobot size={12} /> AI</span>
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

type ConnectionStatus =
  | "connected"
  | "opponent_disconnected"
  | "opponent_reconnecting"
  | "connection_lost";

function ConnectionBanner({ status, onReconnect }: { status: ConnectionStatus; onReconnect?: () => void }) {
  if (status === "connected") return null;

  const isOpponent = status === "opponent_disconnected";
  const isConnectionLost = status === "connection_lost";
  const isOpponentReconnecting = status === "opponent_reconnecting";

  const bannerStyle = isOpponent
    ? "bg-red-600/90 text-white shadow-[0_4px_30px_rgba(239,68,68,0.5)]"
    : isOpponentReconnecting
      ? "bg-amber-500/95 text-slate-950 shadow-[0_4px_30px_rgba(245,158,11,0.5)]"
      : "bg-orange-600/90 text-white shadow-[0_4px_30px_rgba(239,68,68,0.5)]";

  return (
    <div
      className={`
        fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 px-4 py-3
        text-sm font-bold uppercase tracking-[0.12em]
        ${bannerStyle}
      `}
      style={{
        animation: "connectionPulse 1.5s ease-in-out infinite",
      }}
    >
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-white animate-ping" />
      {isOpponent ? (
        <><IconAlertTriangle size={16} /> Opponent disconnected. You win!</>
      ) : isOpponentReconnecting ? (
        <><IconHourglass size={16} /> Opponent disconnected. Holding the match, waiting to reconnect…</>
      ) : (
        <>
          <IconAlertTriangle size={16} /> Connection lost
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
  // Determine turn color from the ACTIVE player's slot, not from the
  // local perspective. Previously this was `isLocalTurn ? cyan : red`,
  // which incorrectly painted a player2 (red) local user's "YOUR TURN"
  // badge with cyan — the glow / AP pips / status dot all wore the
  // opponent's color. Using `currentTurn` here keeps the active
  // player's accent consistent regardless of who's local.
  const turnColor = currentTurn === "player1" ? "#22d3ee" : "#ef4444";
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
    message = "AI's turn. Auto-playing";
    subMessage = "Attack (1 AP) or displace troops (1 AP)";
  } else if (currentAP < ATTACK_COST) {
    message = "No AP remaining";
    subMessage = "End your turn to gain +1 AP";
  } else {
    message = "Choose an action";
    subMessage = "Attack enemy tiles (1 AP) or Displace troops (1 AP)";
  }

  return (
    <div data-hex-status="" className="text-center space-y-2">
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
            <span className="inline-flex items-center gap-2"><IconTrophy size={16} /> GAME OVER <IconTrophy size={16} /></span>
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

      {/* The End Turn button stays MOUNTED for the whole game and is only made
          invisible when the move isn't the local player's (the AI's turn, the
          opponent's turn, or a spectator). Unmounting it collapsed this row —
          and with it the whole board, which sits directly below the status
          bar — on every turn end, which is exactly the jump this removes.
          `invisible` (visibility: hidden) keeps the identical box, and also
          takes the button out of the tab order and the accessibility tree, so
          the reserved space can never be focused or announced as an action
          that isn't available. A fixed height keeps the two colour variants
          (the bordered one and the pulsing yellow one) the same size too. */}
      {!isGameOver && (
        <button
          onClick={onEndTurn}
          disabled={isAITurn || !showEndTurn}
          tabIndex={isAITurn || !showEndTurn ? -1 : undefined}
          /* NOTE: not `transition-all` — that would transition `visibility`
             too, which flips at 50% of the duration, leaving the button
             enabled-but-invisible for ~100ms when the turn comes back. The
             colour/shadow/scale properties are listed explicitly instead. */
          className={`mt-2 h-[34px] px-5 rounded-lg text-xs font-bold uppercase tracking-[0.15em] duration-200 transition-[color,background-color,border-color,box-shadow,transform,filter] ${
            isAITurn || !showEndTurn
              ? "invisible"
              : currentAP < ATTACK_COST
              ? "bg-yellow-400 text-black shadow-[0_0_14px_rgba(250,204,21,0.5)] hover:bg-yellow-300 hover:scale-105 hover:shadow-[0_0_20px_rgba(250,204,21,0.7)] animate-pulse"
              : "border border-white/15 text-slate-400 hover:text-white hover:border-white/30 hover:bg-white/5"
          }`}
        >
          {currentAP < ATTACK_COST ? <span className="inline-flex items-center gap-1"><IconBolt size={14} /> End Turn</span> : "End Turn"}
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
  /**
   * The player whose turn the action originated from. The wire includes
   * this so the receiver can converge to the sender's intent even if the
   * mirrors have drifted (synthetic / poll-driven catch-ups). When
   * omitted, the receiver falls back to its own `state.currentTurn`,
   * which is what mirror-state actions (real-time socket relay) assume.
   */
  player?: DuelPlayer;
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
  // Single-use proof that the user actually started an AI match on the
  // server. end-game verifies this against Redis before honoring `isAiGame`.
  const aiSessionIdRef = useRef<string | null>(null);
  // Frozen aiDifficulty captured at start-game. The page state
  // `aiDifficulty` is mutable (driven by the slider) — if the user
  // changes it mid-game, end-game would no longer match the value
  // start-game cached. Bind the difficulty we forwarded at start.
  const aiDifficultyAtStartRef = useRef<AIDifficulty | null>(null);

  // localStorage is shared across same-browser users; namespace the AI
  // session key by Clerk userId so a sign-out / sign-in as a different
  // user doesn't leak an in-progress token between sessions. User id
  // comes from `useUser()` (`user.id`) which matches what the server
  // routes receive from `auth()`.
  const aiSessionStorageKey = user?.id
    ? `hexDuelAiSessionId:${user.id}`
    : null;
  // True only while the active game is an AI/free-play match (no real
  // tokens are wagered by the user even though the wager UI may show
  // a value). Lifted from WagerModal so ResignConfirmation (rendered
  // by HexDuelPage, not WagerModal) can suppress the "you will lose
  // your wagered tokens" warning during AI resigns. Reset by
  // handleRestart() and on entering a real PvP / multiplayer match.
  const [isAiGame, setIsAiGame] = useState(false);

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
  // Emotes — dedicated per-match room (mirrors the other PvP games).
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: multiplayerGameId ? `hex:emote:${multiplayerGameId}` : null,
    eventName: "hex:emote",
    selfId: user?.id,
  });
  const [opponentClerkId, setOpponentClerkId] = useState<string | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
  const [player1Name, setPlayer1Name] = useState<string | null>(null);
  // Seat identity — real username + official Grynd icon + equipped name
  // color, resolved server-side (getSeatIdentity in the status API).
  const [player1IconKey, setPlayer1IconKey] = useState<string | null>(null);
  const [player1NameColor, setPlayer1NameColor] = useState<string | null>(null);
  const [opponentIconKey, setOpponentIconKey] = useState<string | null>(null);
  const [opponentNameColor, setOpponentNameColor] = useState<string | null>(null);
  const [player1ProfileFrame, setPlayer1ProfileFrame] = useState<unknown>(null);
  const [opponentProfileFrame, setOpponentProfileFrame] = useState<unknown>(null);

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
  // The AI controls (and the "AI analyzing..." read-out beside them) can only
  // act before the match's first move. They stay MOUNTED — invisible — after
  // that instead of unmounting: their widths are what keep the control row
  // above the board on a single line, so the board's position can't shift when
  // the first move of the match lands.
  const aiControlsLocked = p1MoveCount > 0 || p2MoveCount > 0;
  const aiAnalyzing = aiEnabled && aiAction && aiThinking;
  // Record the session into "Recently played" (and the lobby's "Most
  // Played" counter) when the real match starts.
  useRecordPlayedGame("hex-duel", showGame);
  // Active-player presence (lobby "N playing"): the same "a real board is on
  // screen" edge, minus the idle lobby and minus spectators (?spectator=1) —
  // watching a shared game is not playing one. Beats stop at game over and
  // resume on a rematch.
  useActiveGamePresence("hex-duel", showGame && !isSpectator, {
    terminal: isGameOverEffective,
  });

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

  // ── Restore AI session token from localStorage on mount ──────
  // Without this, if the user refreshes the page between start-game
  // and end-game, `aiSessionIdRef.current` would be null and the
  // end-game call would silently fall into the PvP path, deducting
  // tokens from a session that actually started in AI mode.
  // The entry is namespaced by Clerk userId so a different user
  // signing in on the same browser can't inherit a stale token.
  useEffect(() => {
    if (typeof window === "undefined" || !aiSessionStorageKey) return;
    try {
      const persisted = window.localStorage.getItem(aiSessionStorageKey);
      if (!persisted) return;
      const parsed = JSON.parse(persisted) as { sessionId?: string; difficulty?: AIDifficulty };
      if (parsed?.sessionId && aiSessionIdRef.current === null) {
        aiSessionIdRef.current = parsed.sessionId;
      }
      if (parsed?.difficulty && aiDifficultyAtStartRef.current === null) {
        aiDifficultyAtStartRef.current = parsed.difficulty;
      }
    } catch {
      // ignore — localStorage unavailable or stale/corrupt value
    }
    // Re-run on user change so a sign-out → sign-in as a different
    // user on the same browser doesn't inherit the previous user's
    // token (or, if it's the same user, picks up a token written by a
    // newer AI match).
  }, [aiSessionStorageKey]);

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
  const handleStartFun = useCallback(() => { setAIEnabled(true); setIsAiGame(true); setGameMode("for-fun"); setWager(0); setWagerError(null); startedAtRef.current = new Date().toISOString(); posthog?.capture("hex_duel_game_started", { mode: "fun", difficulty: aiDifficulty }); }, []);
  const handleStartReal = useCallback(async (amount: number) => {
    setWagerLoading(true); setWagerError(null);
    try {
      const res = await fetch("/api/hex-duel/start-game", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ wager: amount, isAiGame: true, aiDifficulty }) });
      const data = await res.json();
      if (!res.ok || !data.success) { setWagerError(data.error || "Failed to start game"); return; }
      setBalance(Number(data.data.newBalance));
      setWager(amount);
      setAIEnabled(true); // Auto-enable AI for vs-AI real games
      setIsAiGame(true); // Mark this game as AI (no real wager moved despite gameMode="real")
      setGameMode("real");
      // Capture the server-issued AI session token so the equivalent
      // end-game call can verify the `isAiGame:true` claim.
      const sid =
        typeof data?.data?.aiSessionId === "string"
          ? data.data.aiSessionId
          : null;
      // Freeze the difficulty used at start-time. The `aiDifficulty`
      // page state is mutable (driven by the difficulty slider) and a
      // mid-game change would otherwise break the matcher in
      // /end-game (which compares against the value start-game
      // cached).
      aiDifficultyAtStartRef.current = aiDifficulty;
      aiSessionIdRef.current = sid;
      // Mirror into localStorage so a page reload mid-game still has
      // the token (and matching difficulty) to forward on end-game.
      // Without this, a route refresh would silently degrade the user
      // into the PvP path and deduct tokens the user never wagered.
      // The key is namespaced by Clerk userId so a sign-in as a
      // different user on the same browser can't inherit a stale
      // token.
      if (typeof window !== "undefined" && aiSessionStorageKey && sid) {
        try {
          window.localStorage.setItem(
            aiSessionStorageKey,
            JSON.stringify({ sessionId: sid, difficulty: aiDifficulty }),
          );
        } catch {
          // localStorage may be unavailable (private mode, sandbox
          // iframe, quota). The in-session ref still works.
        }
      }
      startedAtRef.current = new Date().toISOString();
      posthog?.capture("hex_duel_game_started", { mode: "real", bet_amount: amount, difficulty: aiDifficulty });
    } catch { setWagerError("Network error. Please try again"); }
    finally { setWagerLoading(false); }
  }, [aiDifficulty]);

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
      setWagerError("Network error. Please try again");
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
      setWagerError("Network error. Please try again");
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
    //
    // Audit H1 + C2 fix: route through the shared enqueueRemoteAction
    // helper so socket and polling paths produce identical, identity-
    // based dedup signatures and run through the same serialized queue.
    const handleOpponentAction = (data: { action: MultiplayerAction }) => {
      if (typeof window !== "undefined" && (window as unknown as { __hexDuelDebug?: boolean }).__hexDuelDebug) {
        // eslint-disable-next-line no-console
        console.log(
          "[hex-duel] recv action:",
          data?.action?.type,
          "player:",
          data?.action?.player,
        );
      }
      if (data.action) {
        enqueueRemoteAction(data.action);
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

    // Listen for opponent disconnect grace-window start → amber banner.
    // The server only auto-wins AFTER the grace timer expires (and emits
    // hexDuel:opponent:disconnected below); while waiting we show a
    // non-terminal "reconnecting" banner instead of declaring a win.
    const handleOpponentReconnecting = () => {
      if (!isGameOverRef.current) {
        setConnectionStatus("opponent_reconnecting");
      }
    };

    // Listen for opponent rejoin (server cancelled its grace timer) →
    // dismiss the reconnecting banner and resume the match.
    const handleOpponentReconnected = () => {
      setConnectionStatus("connected");
    };

    // Listen for opponent disconnect (grace window EXPIRED) → show red banner + auto-win
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

    // Listen for socket reconnect — also request a full state sync so we
    // don't have to wait for the slow action-by-action polling walk.
    // The server relays this to the opponent, who responds with a
    // hexDuel:syncState snapshot we apply in handleSyncState.
    // Audit M2 fix.
    let lastReconnectSyncAt = 0;
    const handleSocketConnect = () => {
      setConnectionStatus("connected");
      socket.emit("hexDuel:join", { gameId: multiplayerGameId });
      // Throttle: at most once per 2s, only while a game is active.
      const now = Date.now();
      if (now - lastReconnectSyncAt > 2000 && !isGameOverRef.current) {
        lastReconnectSyncAt = now;
        socket.emit("hexDuel:requestSync", { gameId: multiplayerGameId });
      }
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
    socket.on("hexDuel:opponent:reconnecting", handleOpponentReconnecting);
    socket.on("hexDuel:opponent:reconnected", handleOpponentReconnected);
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
      socket.off("hexDuel:opponent:reconnecting", handleOpponentReconnecting);
      socket.off("hexDuel:opponent:reconnected", handleOpponentReconnected);
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
    if (socket && socket.connected && gameModeRef.current === "multiplayer" && multiplayerGameId) {
      actionSeqRef.current += 1;
      socket.emit("hexDuel:action", { gameId: multiplayerGameId, action: { ...action, __seq: actionSeqRef.current } });
    } else if (typeof window !== "undefined" && (window as unknown as { __hexDuelDebug?: boolean }).__hexDuelDebug) {
      // eslint-disable-next-line no-console
      console.warn(
        "[hex-duel] sendMultiplayerAction no-op (socket not ready):",
        action.type,
        "connected=",
        socket?.connected,
        "gameMode=",
        gameModeRef.current,
        "multiplayerGameId=",
        multiplayerGameId,
      );
    }
  }, [socket, multiplayerGameId]);

  // ── Record action to server for action-based sync (authoritative turn log) ──
  const multiplayerGameIdRef = useRef(multiplayerGameId);
  multiplayerGameIdRef.current = multiplayerGameId;
  const gameModeRef = useRef(gameMode);
  gameModeRef.current = gameMode;

  const recordMultiplayerAction = useCallback((action: MultiplayerAction) => {
    if (gameModeRef.current !== "multiplayer" || !multiplayerGameIdRef.current || isSpectator) return;
    if (typeof window !== "undefined" && (window as unknown as { __hexDuelDebug?: boolean }).__hexDuelDebug) {
      // eslint-disable-next-line no-console
      console.log("[hex-duel] POST record:", action.type, action.player);
    }
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
    }).catch((err) => {
      if (typeof window !== "undefined" && (window as unknown as { __hexDuelDebug?: boolean }).__hexDuelDebug) {
        // eslint-disable-next-line no-console
        console.warn("[hex-duel] POST record FAILED:", action.type, err);
      }
    });
  }, []);

  // Ref for applyRemoteAction to avoid stale closure issues (kept above as
  // part of the queue plumbing; the queue calls the latest ref value).

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
        // Use the difficulty captured at start-game time so end-game's
        // matcher sees the exact value start-game cached. If the user
        // moved the difficulty slider mid-game this protects us from
        // breaking the strict-match check.
        aiDifficulty: aiEnabled ? (aiDifficultyAtStartRef.current ?? aiDifficulty) : null,
        player1Moves: p1MoveCount,
        player2Moves: p2MoveCount,
        player1Territory: p1Territory,
        player2Territory: p2Territory,
        durationSeconds,
        startedAt: startedAtRef.current,
        // Single-use proof that the user actually started this AI match.
        // end-game verifies this against Redis before honoring `isAiGame`.
        aiSessionId: aiSessionIdRef.current,
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
        // Consume the AI session token client-side once end-game has
        // succeeded. The server already burned it, so a re-fire of this
        // effect (e.g., a second winnerOverride set) would otherwise
        // re-submit the same token and silently degrade into the PvP
        // path because /end-game would no longer find the entry in
        // Redis. Skip clearing on error so a retry path can still try
        // to reuse the still-valid token (if the server hasn't
        // processed the consume yet, e.g., a transient 5xx).
        if (d?.success && aiSessionIdRef.current) {
          aiSessionIdRef.current = null;
          aiDifficultyAtStartRef.current = null;
          if (typeof window !== "undefined" && aiSessionStorageKey) {
            try { window.localStorage.removeItem(aiSessionStorageKey); } catch {}
          }
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

  // Chess clock hook — isActive pauses during AI thinking and after game over.
  // Disabled entirely in vs-AI games (for-fun / real-vs-AI): the human's clock
  // never expires, so there is no loss-by-timeout against the bot.
  const clock = useChessClock({
    isActive: showGame && !isGameOverEffective && !aiThinking && !aiEnabled,
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
  //
  // Kept as a ref so the action queue's processQueue always invokes the
  // latest `applyRemoteAction` from the engine, regardless of when it ran.
  const applyRemoteActionRef = useRef<(a: MultiplayerAction) => void>(() => {});
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
  // Deduplication: track processed actions by signature so socket + polling
  // can't double-apply the same action. Audit H1 + C2 fix.
  const processedSocketActionsRef = useRef<Set<string>>(new Set());
  // Monotonic counter for actions missing a wire id — disambiguates
  // locally-synthesized fallbacks so signature collisions never happen.
  const processedSeqRef = useRef(0);

  // ── Sequenced action queue (Audit C2 + legacy races) ──
  //
  // Multiple socket/polling dispatches arriving in the same tick are
  // serialized through this queue. The engine reducer now operates on
  // each one in order against fresh state, so application correctness
  // is fine, but this layer enforces a single in-order applier and a
  // single dedup set that's updated consistently across delivery paths.
  const actionQueueRef = useRef<Array<MultiplayerAction & { __seq?: number; id?: number }>>([]);
  const processingRef = useRef(false);
  const processQueue = useCallback(() => {
    if (processingRef.current) return;
    if (isGameOverRef.current) {
      actionQueueRef.current = [];
      return;
    }
    const next = actionQueueRef.current.shift();
    if (!next) {
      processingRef.current = false;
      return;
    }
    processingRef.current = true;
    try {
      applyRemoteActionRef.current(next);
    } finally {
      // Yield then continue draining. setTimeout(0) lets React flush any
      // setState from the dispatch before the next action's reducer call.
      setTimeout(() => {
        processingRef.current = false;
        processQueue();
      }, 0);
    }
  }, []);

  const enqueueRemoteAction = useCallback(
    (action: MultiplayerAction & { __seq?: number; id?: number }) => {
      // Compute signature FIRST and only enqueue if it's new. Identity-
      // based dedup: the signature includes a wire-unique id (`__seq` or
      // `id` from the DB) so two legitimately distinct actions with the
      // same content get distinct signatures.
      processedSeqRef.current += 1;
      const wireId = action.__seq ?? action.id ?? `local-${processedSeqRef.current}`;
      const sig = `${action.type}:${action.sourceKey ?? ""}:${action.targetKey ?? ""}:${action.troopCount ?? ""}:${wireId}`;
      if (processedSocketActionsRef.current.has(sig)) {
        // Diagnostic: surface dropped-via-dedup so silent desync bugs
        // become visible in the browser console. (If you see this fire
        // repeatedly for the same action, your __seq wireId source is
        // producing duplicates that the dedup mistreats as the same
        // action; the engine's idempotency guard would then BISTABLY
        // bounce endTurn flips.)
        if (typeof window !== "undefined" && (window as unknown as { __hexDuelDebug?: boolean }).__hexDuelDebug) {
          // eslint-disable-next-line no-console
          console.warn("[hex-duel] enqueue dedup-drop:", sig);
        }
        return;
      }
      processedSocketActionsRef.current.add(sig);
      actionQueueRef.current.push(action);
      processQueue();
    },
    [processQueue],
  );

  // ── Computed highlight keys for HexBoard ───────────────────────────
  const attackHighlightKeys = useMemo(
    () => (selectedAction === "attack" ? attackableTargets.map((t) => `${t.x},${t.y}`) : []),
    [selectedAction, attackableTargets]
  );

  // Compute source highlight keys based on the current phase. The sources stay
  // highlighted through `inputTroops` too: while the troop popup is open,
  // tapping one of these green tiles moves the source there instead (see
  // `handleTileClickWithActions`).
  const sourceHighlightKeys = useMemo(() => {
    const pickingSource =
      pendingActionPhase === "selectSource" || pendingActionPhase === "inputTroops";
    if (!pendingTarget || !pickingSource) return [];
    const targetKey = `${pendingTarget.x},${pendingTarget.y}`;
    if (selectedAction === "attack") {
      return getAttackSources(targetKey).map((s) => `${s.x},${s.y}`);
    }
    if (selectedAction === "displace") {
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
    // Defensive guard — in multiplayer, only the active local player can
    // call endTurn. If `isLocalTurn` is false (e.g. the engine just
    // desynced and currentTurn != localDuelPlayer), ignore the click so
    // we don't broadcast an out-of-turn endTurn that would flip the
    // opponent's display into the wrong state.
    if (gameMode === "multiplayer" && !isLocalTurn) return;
    const prevTurn = currentTurn;
    endTurn();
    if (gameMode === "multiplayer") {
      // The `player` field tells the receiver unambiguously whose turn
      // ended. Without it the receiver relies on mirror-state which can
      // drift under load. The server-status POST is no longer needed
      // here — the dedicated turn-change useEffect below handles ALL
      // local-initiated turn transitions (explicit End Turn, Skip Round,
      // AND the engine's AP=0 attack/displace auto-flip), eliminating a
      // class of bounces where the sender's polling would otherwise
      // re-fire a synthetic endTurn from a stale local state.
      const action: MultiplayerAction = { type: "endTurn", player: prevTurn };
      sendMultiplayerAction(action);
      recordMultiplayerAction(action);
    }
  }, [endTurn, gameMode, sendMultiplayerAction, recordMultiplayerAction, multiplayerGameId, currentTurn, isLocalTurn]);

  // ── Action-based sync: poll server for opponent actions we might have missed ──
  // Polls the server every 1.5s for missed remote actions.
  // Audit C2 fix: use the shared `enqueueRemoteAction` helper so polling
  // goes through the same dedup queue as the socket handler, preventing
  // double-apply when both delivery paths arrive for the same action.
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
        for (const a of actions) {
          if (cancelled || isGameOverRef.current) break;
          enqueueRemoteAction({
            type: a.actionType,
            sourceKey: a.sourceKey ?? undefined,
            targetKey: a.targetKey ?? undefined,
            troopCount: a.troopCount ?? undefined,
            id: a.id,
          });
        }
        if (actions.length > 0) {
          lastKnownActionIdRef.current = data.latestActionId || 0;
        }
      } catch {
        // Ignore poll errors — socket handles real-time sync
      }
    };

    // Poll every 5 seconds as a catch-up safety net for missed socket
    // events (the hexDuel:action socket mirror is the live path). The
    // tradeoff is slightly slower catch-up after a dropped socket event,
    // which the forced-sync request on turn start already covers.
    pollActions();
    const interval = setInterval(pollActions, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gameMode, multiplayerGameId, opponentReady, effectiveWinner, enqueueRemoteAction]);

  // ── SAFETY NET: request forced sync when our turn just began ──────────
  // The user has reported a persistent bug where P2's screen would
  // never update after P1 ended their turn, even though P1's own screen
  // advanced correctly. Investigation traced this to races in the
  // realtime-server participant-check + enqueue-dedup + the receiver's
  // own applyRemoteAction short-circuiting on stale state. As a
  // belt-and-suspenders defense, whenever our local turn just began
  // (currentTurn flipped to localDuelPlayer), we proactively request a
  // full state snapshot from the opponent. applySyncSnapshot
  // overwrites the local engine from scratch — including state.winner,
  // tileTroops, capturedTiles — closing any divergence the action-mirror
  // queue might have left open. Throttled to 1.5s so we don't spam.
  const lastSyncRequestAtRef = useRef(0);
  const lastSyncedTurnRef = useRef<DuelPlayer | null>(null);
  useEffect(() => {
    if (gameMode !== "multiplayer" || !socket || !multiplayerGameId) return;
    // We are locally active when currentTurn matches our slot
    // (isPlayer1 ? "player1" : "player2"). Inline the check to avoid a
    // forward reference to localDuelPlayer which is declared later in
    // the render scope.
    const mySlot: DuelPlayer = isPlayer1 ? "player1" : "player2";
    if (currentTurn !== mySlot) return;
    if (isGameOver) return;
    // Only request sync when this specific currentTurn value is NEWLY
    // ours (not on every render where it happens to match). Prevents
    // spam when currentTurn == mySlot on initial mount.
    if (lastSyncedTurnRef.current === currentTurn) return;
    const now = Date.now();
    if (now - lastSyncRequestAtRef.current < 1500) return;
    // Mark synced ONLY after we know we'll actually emit. (Doing this
    // earlier would let a throttled fire leave the ref poisoned for the
    // rest of the turn with no successful emit captured.)
    lastSyncedTurnRef.current = currentTurn;
    lastSyncRequestAtRef.current = now;
    if (typeof window !== "undefined" && (window as unknown as { __hexDuelDebug?: boolean }).__hexDuelDebug) {
      // eslint-disable-next-line no-console
      console.log("[hex-duel] sync-request (turn-start safety net):", currentTurn);
    }
    socket.emit("hexDuel:requestSync", { gameId: multiplayerGameId });
  }, [gameMode, socket, multiplayerGameId, currentTurn, isPlayer1, isGameOver]);

  // ── Status POST on local turn-change (prevents polling bounce) ───────
  // Every dispatch that flips currentTurn on this client (explicit
  // handleEndTurn, handleSkipRound, OR engine's AP=0 attack/displace
  // auto-flip) needs to immediately POST the new currentTurn to the
  // server so the polling fallback on both clients doesn't see a
  // local-ahead/server-stale mismatch. Without this, the client's own
  // polling cycle would fire a synthetic endTurn that re-flip the
  // just-ended turn back to the player (the bounce bug). The existing
  // useEffect already updates a turn-transition tracker (`prevTurnRef`)
  // — we use a separate ref so this POST is independent of the
  // turnJustChanged animation timer.
  const lastPostedTurnRef = useRef<DuelPlayer | null>(null);
  useEffect(() => {
    if (gameMode !== "multiplayer" || !multiplayerGameId || isGameOver) return;
    // First-mount safety: if the ref was never seeded (hot reload, late
    // mount, deep-link into an in-progress game), initialize it from the
    // current state so subsequent transitions are detected correctly.
    if (lastPostedTurnRef.current === null) {
      lastPostedTurnRef.current = currentTurn;
      return;
    }
    const localClientSlot: DuelPlayer = isPlayer1 ? "player1" : "player2";
    const prev = lastPostedTurnRef.current;
    // Only POST when this client was the one that just ended their turn
    // (i.e. we moved OUT of our slot). A purely mirror-state change
    // (e.g. socket arrived, applying a remote endTurn) doesn't need a
    // re-POST — the originating client already posted it.
    if (prev === localClientSlot && prev !== currentTurn) {
      fetch(`/api/hex-duel/multiplayer/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId: multiplayerGameId, turn: currentTurn }),
      }).catch(() => {});
    }
    lastPostedTurnRef.current = currentTurn;
  }, [gameMode, multiplayerGameId, currentTurn, isGameOver, isPlayer1]);

  // ── Turn-status polling: last-resort sync for when socket events are missed ──
  // Periodically checks the server-stored currentTurn and applies a missed
  // opponent endTurn if the server says it's our turn but locally it isn't.
  //
  // Audit H2 fix: gate the synthetic endTurn on the action queue being
  // drained — otherwise we may flip the turn BEFORE slower action catches
  // up via polling, then apply a missed attack that itself auto-switches
  // the turn again, causing a 2x flip desync. We do this by requiring an
  // empty queue AND a stable local turn over consecutive polls.
  const localTurnRef = useRef(currentTurn);
  localTurnRef.current = currentTurn;
  const isPlayer1Ref = useRef(isPlayer1);
  isPlayer1Ref.current = isPlayer1;
  const pendingTurnFlipRef = useRef(false);
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

        if (serverTurn !== myTurn) {
          pendingTurnFlipRef.current = false;
          return;
        }

        // Bail if local is AHEAD of server — local engine already
        // pre-emptively flipped (e.g. local handleEndTurn or AP=0
        // attack/displace auto-flip) and the POST to /status is
        // in-flight. Server will reconcile shortly. Firing a synthetic
        // endTurn here is what was BOUNCING the player's UI back to
        // their own turn immediately after they ended it.
        // (`otherPlayer` is a private helper in hexDuelEngine, inline
        // here to avoid a round-trip import.)
        if (localTurnRef.current === otherPlayer(serverTurn)) {
          pendingTurnFlipRef.current = false;
          return;
        }

        // Wait for the action queue to drain — otherwise an in-flight
        // attack could flip the turn back after we do.
        if (actionQueueRef.current.length > 0 || processingRef.current) {
          pendingTurnFlipRef.current = true;
          return;
        }

        // Require a stable local-turn observation across two poll cycles
        // to avoid reacting to transient render-time mismatches.
        if (
          pendingTurnFlipRef.current &&
          localTurnRef.current !== myTurn &&
          !isGameOverRef.current
        ) {
          // CRITICAL: include `player: localTurnRef.current` so the
          // receiver's applyRemoteAction idempotency guard works.
          // Without it, fromPlayer falls back to state.currentTurn and
          // if even ONE endTurn has already been mirrored, the reducer
          // would re-flip back.
          enqueueRemoteAction({
            type: "endTurn",
            player: localTurnRef.current,
            __seq: -Date.now(),
          });
        }
        pendingTurnFlipRef.current = true;
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
  }, [gameMode, multiplayerGameId, opponentReady, effectiveWinner, enqueueRemoteAction]);

  // ── Spectator polling: poll /spectate to get full state and actions ──
  // Audit C2 fix: spectator path uses the same enqueueRemoteAction queue
  // as the player paths so dedup is identity-based, not content-based.
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
        // Heartbeat only needs to land inside the 20s spectator-count
        // window — a 15s throttle guarantees that with margin at 3x fewer
        // UPSERTs + cleanup DELETEs than the old 5s beat.
        if (data.game?.player1Id && (!lastHeartbeatRef.current || now - lastHeartbeatRef.current > 15000)) {
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
          if (data.game.player1IconKey) setPlayer1IconKey(data.game.player1IconKey);
          if (data.game.player1NameColor) setPlayer1NameColor(data.game.player1NameColor);
          if (data.game.player1ProfileFrame) setPlayer1ProfileFrame(data.game.player1ProfileFrame);
          if (data.game.player2ProfileFrame)
            setOpponentProfileFrame(
              isPlayer1 ? data.game.player2ProfileFrame : data.game.player1ProfileFrame,
            );
          if (data.game.player2IconKey) {
            const oppKey = isPlayer1 ? data.game.player2IconKey : data.game.player1IconKey;
            if (oppKey) setOpponentIconKey(oppKey);
          }
          if (data.game.player2NameColor) {
            const oppColor = isPlayer1 ? data.game.player2NameColor : data.game.player1NameColor;
            if (oppColor) setOpponentNameColor(oppColor);
          }
        }

        const actions = data.actions || [];
        for (const a of actions) {
          if (cancelled || isGameOverRef.current) break;
          enqueueRemoteAction({
            type: a.actionType,
            sourceKey: a.sourceKey ?? undefined,
            targetKey: a.targetKey ?? undefined,
            troopCount: a.troopCount ?? undefined,
            id: a.id,
          });
        }
        if (actions.length > 0) {
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
  }, [isSpectator, multiplayerGameId, effectiveWinner, enqueueRemoteAction]);

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
    if (gameMode === "multiplayer" && !isLocalTurn) return;
    const prevTurn = currentTurn;
    skipRound();
    if (gameMode === "multiplayer") {
      // Server turn state is updated by the dedicated turn-change
      // useEffect (see the ref above the polling useEffect) — no need
      // to POST here, which also removes a redundant double-POST that
      // used to race with the polling fallback.
      const action: MultiplayerAction = { type: "skipRound", player: prevTurn };
      sendMultiplayerAction(action);
      recordMultiplayerAction(action);
    }
  }, [skipRound, gameMode, sendMultiplayerAction, recordMultiplayerAction, multiplayerGameId, currentTurn, isLocalTurn]);

  const handleRestart = useCallback(() => {
    resetGame(); setGameMode("idle"); setWager(0); setWagerError(null);
    setPayoutResult(null); payoutProcessedRef.current = false; startedAtRef.current = null; fetchBalance();
    setMultiplayerGameId(null); setOpponentReady(false); opponentReadyRef.current = false; multiplayerJoinedRef.current = false;
    lastKnownActionIdRef.current = 0;
    // Audit reviewer HIGH fix: clear the action queue + dedup set so queued
    // actions from the previous game cannot drain against a fresh game's
    // state. Without this, after restart `processQueue` would resume
    // applying old actions (whose `processQueue` guard `isGameOverRef` is
    // now false again) and corrupt the new game.
    actionQueueRef.current = [];
    processedSocketActionsRef.current.clear();
    processedSeqRef.current = 0;
    if (connectionTimerRef.current) {
      clearTimeout(connectionTimerRef.current);
      connectionTimerRef.current = null;
    }
    setConnectionStatus("connected");
    setIsSpectator(false);
    // Drop any persisted AI session token — restart means a new game
    // (with a new token) and we don't want the old token's 15-min TTL
    // window to leak into a later match.
    aiSessionIdRef.current = null;
    aiDifficultyAtStartRef.current = null;
    if (typeof window !== "undefined" && aiSessionStorageKey) {
      try { window.localStorage.removeItem(aiSessionStorageKey); } catch {}
    }
    setIsAiGame(false);
    window.history.replaceState({}, '', window.location.pathname);
  }, [resetGame, fetchBalance]);

  // ── Action system: wrapped click, confirm, clear ──────────────────

  const handleTileClickWithActions = useCallback((displayX: number, displayY: number) => {
    // `displayGrid` is no longer mirrored for the P2 viewer (see
    // `displayGrid` memo below — both players view the board with the
    // same orientation, blue top-left / red bottom-right). Display
    // coords ARE game coords here, so no flip is applied. The rest of
    // the action pipeline (engine, attack/displace resolution, etc.)
    // continues to speak in game-space coordinates.
    const x = displayX;
    const y = displayY;
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
      } else if (pendingActionPhase === "inputTroops" && pendingTarget) {
        // Troop popup is open. A source swap wins over a re-target because
        // only sources can send; otherwise a different attackable tile
        // becomes the new target and a fresh source is awaited. Re-tapping the
        // tile the popup is anchored to is a no-op, so a stray tap right under
        // the popup can't discard the pending action.
        const sources = getAttackSources(`${pendingTarget.x},${pendingTarget.y}`);
        if (sources.some((s) => s.x === x && s.y === y)) {
          const maxFromNewSource = sendableTroops(tileTroops[key] ?? 1);
          setPendingSource({ x, y });
          setPendingTroopCount((prev) => clampSendCount(prev, maxFromNewSource));
        } else if (
          (x !== pendingTarget.x || y !== pendingTarget.y) &&
          attackableTargets.some((t) => t.x === x && t.y === y)
        ) {
          setPendingTarget({ x, y });
          setPendingSource(null);
          setPendingActionPhase("selectSource");
          setPendingTroopCount(1);
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
      } else if (pendingActionPhase === "inputTroops" && pendingTarget) {
        // Troop popup is open. A source swap wins over a re-target because
        // only sources can send; otherwise a different friendly tile becomes
        // the new target and a fresh source is awaited. (Every friendly tile
        // is a displace candidate, so there is no narrower target test.)
        // Re-tapping the tile the popup is anchored to is a no-op.
        const newSource = getDisplaceSources(`${pendingTarget.x},${pendingTarget.y}`).find(
          (s) => s.x === x && s.y === y,
        );
        if (newSource) {
          setPendingSource({ x, y });
          setPendingTroopCount((prev) => clampSendCount(prev, newSource.maxTroops));
        } else if (
          (x !== pendingTarget.x || y !== pendingTarget.y) &&
          capturedTiles[key] === currentTurn
        ) {
          setPendingTarget({ x, y });
          setPendingSource(null);
          setPendingActionPhase("selectSource");
          setPendingTroopCount(1);
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
        return `Attack (${pendingTarget!.x},${pendingTarget!.y}). Click source tile`;
      }
      if (pendingActionPhase === "inputTroops" && pendingSource && pendingTarget) {
        const sourceKey = `${pendingSource.x},${pendingSource.y}`;
        const maxSend = (tileTroops[sourceKey] ?? 1) - 1;
        return `Attack from (${pendingSource.x},${pendingSource.y}) → (${pendingTarget.x},${pendingTarget.y}). Send ${pendingTroopCount} of ${maxSend} troops`;
      }
    }
    if (selectedAction === "displace") {
      if (pendingActionPhase === "selectTarget") {
        return "Click a friendly tile to reinforce";
      }
      if (pendingActionPhase === "selectSource") {
        return `Reinforce (${pendingTarget!.x},${pendingTarget!.y}). Click source with spare troops`;
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

  // Max troops available to send from the selected source (must leave 1 behind)
  const maxSendTroops = useMemo(() => {
    if (!pendingSource) return 0;
    return sendableTroops(tileTroops[`${pendingSource.x},${pendingSource.y}`] ?? 1);
  }, [pendingSource, tileTroops]);

  // ── Perspective-aware mapping ────────────────────────────────────────
  // Computed here after all dependencies (troop totals, clock) are declared.
  //
  // Colors are derived from the player's SLOT (player1 = cyan, player2 = red),
  // not from a hardcoded "local=blue / opponent=red". This is the POV fix:
  // previously `localColor` was hardcoded to cyan, so a player2 (red) local
  // user saw themselves styled as blue — the "your turn" badge appeared on a
  // card painted with the wrong slot color, the action board used cyan
  // borders, and the HexBoard legend labeled "You" with cyan. Now it
  // mirrors the actual slot, so the visual perspective reflects the
  // engine slot the local user occupies.
  const localPlayerIsP1 = gameMode !== "multiplayer" || isPlayer1;
  const localDuelPlayer: DuelPlayer = localPlayerIsP1 ? "player1" : "player2";
  const opponentDuelPlayer: DuelPlayer = localPlayerIsP1 ? "player2" : "player1";
  const localColor = localDuelPlayer === "player1" ? "#22d3ee" : "#ef4444";
  const opponentColor = opponentDuelPlayer === "player1" ? "#22d3ee" : "#ef4444";

  // ── View-layer perspective swap ──────────────────────────────────────
  // The engine tracks owners absolutely ("player1" at capital 0,0, "player2" at capital 4,4).
  // For the board UI we want each player to see their own tiles as their own color
  // (Clash Royale style). Coordinates stay the same on both sides so engine
  // interactions are unaffected — only the visual owner label is swapped.
  // Render the grid in engine-space for BOTH players. Previously the
  // P2 viewer got a 180°-rotated grid so their own capital (which
  // lives at GRID_SIZE-1, GRID_SIZE-1 in the engine) appeared
  // top-left — but that swapped blue and red positions on the board
  // for the opponent, contradicting the invariant that player1
  // (blue) always owns the top-left capital and player2 (red) owns
  // the bottom-right. Removing the rotation keeps the board
  // orientation consistent across viewers; the player-card swap
  // (see the `lg:order-X` classes below) handles the per-POV
  // "your-color on your-side" feel without moving owned tiles.
  const displayGrid = grid;

  // Translate a key (e.g. "x,y") from GAME coords to DISPLAY coords for
  // the non-P1 perspective. HexBoard iterates displayGrid and looks up
  // highlight keys by its own display iteration coords, so the wire of
  // highlight sets coming from the engine (game-space) must be flipped
  // before being passed down.  // Identity flip helpers left intentionally. `displayGrid` is no
  // longer mirrored, so the engine-space keys/coordinates we surface
  // to the board map 1:1 onto the rendered tiles — no perspective
  // swap is applied here right now. The helpers are kept in place
  // (rather than inlined at call sites) so a future per-POV mirror
  // can be reintroduced by editing only these two functions; all
  // call sites already route through them.
  const flipKey = useCallback((k: string): string => k, []);
  const flipPoint = useCallback(
    (p: { x: number; y: number }): { x: number; y: number } => p,
    [],
  );

  // Stats for local player
  const localMoves = localPlayerIsP1 ? p1MoveCount : p2MoveCount;
  const localTerritory = localPlayerIsP1 ? p1Territory : p2Territory;
  const localTotalTroops = localPlayerIsP1 ? p1TotalTroops : p2TotalTroops;
  // Vs-AI games are untimed — freeze the displayed clock at its start
  // value so the card doesn't show a running countdown.
  const localClockTime = aiEnabled ? 600000 : localPlayerIsP1 ? clock.p1TimeLeft : clock.p2TimeLeft;
  const localIsWinner = effectiveWinner === localDuelPlayer;
  const localIsActive = currentTurn === localDuelPlayer;

  // Stats for opponent
  const opponentMoves = localPlayerIsP1 ? p2MoveCount : p1MoveCount;
  const opponentTerritory = localPlayerIsP1 ? p2Territory : p1Territory;
  const opponentTotalTroops = localPlayerIsP1 ? p2TotalTroops : p1TotalTroops;
  const opponentClockTime = aiEnabled ? 600000 : localPlayerIsP1 ? clock.p2TimeLeft : clock.p1TimeLeft;
  const opponentIsWinner = effectiveWinner === opponentDuelPlayer;
  const opponentIsActive = currentTurn === opponentDuelPlayer;

  // Labels
  const localLabel = isSpectator ? (player1Name || "Player 1") : (user?.firstName || user?.username || "You");
  const opponentLabel = aiEnabled ? "AI" : gameMode === "multiplayer" ? (opponentName || "Opponent") : "Player 2";
  // Per-seat identity for the player cards. In multiplayer the viewer
  // is seat 1 or 2; spectator view follows seat 1. AI seat stays null.
  const localIconKey = isSpectator || isPlayer1 ? player1IconKey : opponentIconKey;
  const localNameColor = isSpectator || isPlayer1 ? player1NameColor : opponentNameColor;
  const localProfileFrame = isSpectator || isPlayer1 ? player1ProfileFrame : opponentProfileFrame;
  const oppIconKey = aiEnabled ? null : gameMode === "multiplayer" ? (isPlayer1 ? opponentIconKey : player1IconKey) : null;
  const oppNameColor = aiEnabled ? null : gameMode === "multiplayer" ? (isPlayer1 ? opponentNameColor : player1NameColor) : null;
  const oppProfileFrame = aiEnabled ? null : gameMode === "multiplayer" ? (isPlayer1 ? opponentProfileFrame : player1ProfileFrame) : null;

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
          const oppKey = isPlayer1 ? d.game.player2IconKey : d.game.player1IconKey;
          if (oppKey) setOpponentIconKey(oppKey);
          const oppColor = isPlayer1 ? d.game.player2NameColor : d.game.player1NameColor;
          if (oppColor) setOpponentNameColor(oppColor);
          const oppFrame = isPlayer1 ? d.game.player2ProfileFrame : d.game.player1ProfileFrame;
          if (oppFrame) setOpponentProfileFrame(oppFrame);
          const myKey = isPlayer1 ? d.game.player1IconKey : d.game.player2IconKey;
          if (myKey) setPlayer1IconKey(myKey);
          const myColor = isPlayer1 ? d.game.player1NameColor : d.game.player2NameColor;
          if (myColor) setPlayer1NameColor(myColor);
          const myFrame = isPlayer1 ? d.game.player1ProfileFrame : d.game.player2ProfileFrame;
          if (myFrame) setPlayer1ProfileFrame(myFrame);
        }
      })
      .catch(() => {});
  }, [gameMode, multiplayerGameId, opponentReady, isPlayer1]);

  // ── Waiting for opponent UI ───────────────────────────────────────
  if (gameMode === "multiplayer" && multiplayerGameId && !opponentReady) {
    return (
      <>
        <style>{GLOBAL_KEYFRAMES}</style>
        {/* Unified full-screen waiting takeover (except when the
            opponent disconnected — that keeps its own red screen). */}
        {connectionStatus !== "opponent_disconnected" && (
          <MatchWaiting
            state="waiting"
            gameName="Hex Duel"
            subtitle={`Game #${multiplayerGameId} · Another player needs to join before the match starts…`}
            seats={[
              {
                label: "You",
                name: isPlayer1 ? "Player 1 (Host)" : "Player 2",
                occupied: true,
              },
              { label: "Opponent", occupied: false },
            ]}
            onCancel={handleRestart}
            cancelLabel="Cancel & Return to Lobby"
          />
        )}
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
                      <IconMoodSad size={28} className="text-red-400" />
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
                    Game #{multiplayerGameId}: {isPlayer1 ? "Player 1 (Host)" : "Player 2"}
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


  const statusBar = (
    <>
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
    </>
  );
  const leftPanel = (
    <>
<div className={`order-2 ${localPlayerIsP1 ? "lg:order-1" : "lg:order-3"} w-full max-w-xs mx-auto lg:mx-0 space-y-3`}>
                <PlayerCard
                  player={localDuelPlayer} label={localLabel}
                  isActive={localIsActive} isSelected={false}
                  color={localColor} moves={localMoves} territory={localTerritory}
                  currentAP={localIsActive ? currentAP : 0} maxAP={maxAP}
                  isWinner={localIsWinner} isLocal={true} turnJustChanged={turnJustChanged}
                  totalTroops={localTotalTroops} maxTroops={maxTroops}
                  clockTime={localClockTime}
                  emoteBubble={myEmote} emoteSide="mine"
                  iconKey={localIconKey} nameColor={localNameColor} profileFrame={localProfileFrame}
                />
                {showGame && !isSpectator && (gameMode !== "multiplayer" || isPlayer1) && (
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
                {/* The troop-count step is not rendered here any more — it
                    lives in HexTroopPopup, anchored to the tile the player is
                    acting on (see `troopPopup` below). */}
              </div>
    </>
  );
  const boardStage = (
    <>
<div className="order-1 lg:order-2 flex flex-col items-center w-full">
                {/* Turn banner. It is mounted for as long as the multiplayer
                    match is — it does NOT come and go with the turn. It used
                    to be a "Waiting for opponent" card that existed only on
                    the opponent's turn, so ending a turn inserted it (and the
                    next snapshot removed it again) and the board below it
                    jumped by the card's full height. It is now the SAME box in
                    both turn states — the same elements with the same classes,
                    only the text, the hue and the spinner change — so the
                    height is identical whether it's your move or theirs. */}
                {gameMode === "multiplayer" && !isGameOver && (
                  <div
                    data-hex-turn-band=""
                    className={`relative z-20 mb-3 w-full max-w-md mx-auto rounded-xl border bg-gradient-to-b from-[#071230]/90 to-[#0a1a3f]/80 backdrop-blur-md p-4 text-center ${
                      isLocalTurn ? "border-cyan-400/20" : "border-red-500/20"
                    }`}
                    style={isLocalTurn ? undefined : { animation: "waitingFadeIn 0.4s ease-out, waitingPulse 2s ease-in-out infinite" }}
                  >
                    <div className="flex items-center justify-center gap-3">
                      <span
                        className={`inline-block w-5 h-5 rounded-full border-2 ${
                          isLocalTurn ? "border-cyan-400/30 border-t-cyan-400" : "border-red-400/30 border-t-red-400"
                        }`}
                        style={isLocalTurn ? undefined : { animation: "waitingSpin 0.8s linear infinite" }}
                      />
                      <span className={`text-xs font-bold uppercase tracking-[0.15em] ${isLocalTurn ? "text-cyan-300" : "text-red-300"}`}>
                        {isLocalTurn ? "Your move" : "Waiting for opponent..."}
                      </span>
                    </div>
                    {/* `min-h` on the sub-line so a one-line hint and a
                        two-line one occupy the same space at narrow widths. */}
                    <p className="mt-1.5 min-h-[14px] text-[10px] text-slate-500">
                      {isLocalTurn
                        ? "Attack enemy tiles (1 AP) or displace troops (1 AP)"
                        : opponentReady
                        ? `${opponentLabel} is planning their next move`
                        : `Connecting to ${opponentLabel}...`}
                    </p>
                  </div>
                )}
                <div className="flex justify-center overflow-x-auto overflow-y-hidden px-1 sm:px-2 -mx-1 sm:-mx-2" style={{ scrollbarWidth: "none" }}>
                <HexBoard
                  grid={displayGrid}
                  localColor={localColor}
                  opponentColor={opponentColor}
                  localLabel={localLabel}
                  opponentLabel={opponentLabel}
                  selectedTile={selectedTile ? flipPoint(selectedTile) : selectedTile}
                  onTileClick={handleTileClickWithActions}
                  recentlyCaptured={recentlyCaptured.map(flipKey)}
                  disabled={
  isGameOver || isSpectator ||
  (aiThinking && currentTurn === "player2")
}
                  attackHighlightKeys={
  isGameOver || (aiThinking && currentTurn === "player2")
    ? []
    : selectedAction === "attack"
    ? attackHighlightKeys.map(flipKey)
    : selectedAction === "displace"
    ? displaceHighlightKeys.map(flipKey)
    : []
}
                  sourceHighlightKeys={
  isGameOver || (aiThinking && currentTurn === "player2")
    ? []
    : sourceHighlightKeys.map(flipKey)
}
                  displaceTargetKey={
  isGameOver || (aiThinking && currentTurn === "player2") ||
  selectedAction !== "displace" || !pendingTarget
    ? undefined
    : flipKey(`${pendingTarget.x},${pendingTarget.y}`)
}
                />
              </div>
              </div>
    </>
  );
  const rightPanel = (
    <>
<div className={`order-3 ${localPlayerIsP1 ? "" : "lg:order-1"} w-full max-w-xs mx-auto lg:mx-0 space-y-3`}>
                <PlayerCard
                  player={opponentDuelPlayer} label={opponentLabel}
                  isActive={opponentIsActive} isSelected={false}
                  color={opponentColor} moves={opponentMoves} territory={opponentTerritory}
                  currentAP={opponentIsActive ? currentAP : 0} maxAP={maxAP}
                  isWinner={opponentIsWinner} isAI={aiEnabled} isLocal={false} turnJustChanged={turnJustChanged}
                  totalTroops={opponentTotalTroops} maxTroops={maxTroops}
                  clockTime={opponentClockTime}
                  emoteBubble={incomingEmote} emoteSide="incoming"
                  iconKey={oppIconKey} nameColor={oppNameColor} profileFrame={oppProfileFrame}
                />
                {showGame && !isSpectator && gameMode === "multiplayer" && !isPlayer1 && (
                  // Right-side action panel for the red local user
                  // (`!isPlayer1`). Identical wiring to the LEFT panel —
                  // real handlers, shared React state, isActive
                  // mirrors the LEFT panel's logic — so this panel IS
                  // the red local user's actual action board during
                  // multiplayer, not decoration. `localColor` /
                  // `localLabel` already swap to red on a player2 tab,
                  // so the panel renders in red. Combined with the
                  // LEFT-panel gate
                  // `(gameMode !== "multiplayer" || isPlayer1)` above,
                  // exactly one action board is visible per local
                  // user: blue local → left, red local → right.
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
                {/* Action history log — visible for all game modes */}
                {showGame && actionLog.length > 0 && (
                  <HexActionLog log={actionLog} compact={true} />
                )}
              </div>
    </>
  );

  const desktopGrid = (
    <>
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
        {leftPanel}
        {boardStage}
        {rightPanel}
      </div>
      )}
    </>
  );

  const desktopContent = (
    <>
      {statusBar}
      {desktopGrid}
    </>
  );

  // ── Troop-send popup ───────────────────────────────────────────────
  // Appears directly above the SOURCE tile once it is picked, replacing the
  // old panel that sat under the board and forced a scroll on phones. The
  // count, the source swap (tap another green tile) and confirm/cancel all
  // live in this one control.
  //
  // What the popup's tip tells the player they can tap instead. Only promise
  // the source swap when there is another source to swap to.
  const troopPopupTip = [
    sourceHighlightKeys.length > 1 ? "Tap another green tile to send from there" : null,
    selectedAction === "displace"
      ? "tap another tile to change the target"
      : "tap another enemy tile to change the target",
  ]
    .filter(Boolean)
    .join(", or ");

  const troopPopup =
    showGame && !isGameOver && !isSpectator && pendingActionPhase === "inputTroops" &&
    pendingSource && pendingTarget ? (
      <HexTroopPopup
        // Anchored above the SOURCE tile — the territory the troops leave —
        // so the count and the source swap share one control. Picking another
        // green tile moves the popup with it; the chosen target stays
        // highlighted on the board so it's still clear where they're going.
        anchorKey={`${pendingSource.x},${pendingSource.y}`}
        // Open on the side of the source facing away from the target, so the
        // popup never hides the territory the troops are heading to. Same row
        // (the target is beside the source, not under it) keeps the default.
        preferPlacement={pendingTarget.y < pendingSource.y ? "below" : "above"}
        title={selectedAction === "displace" ? "Displace troops" : "Send troops"}
        hint={`(${pendingSource.x},${pendingSource.y}) → (${pendingTarget.x},${pendingTarget.y})`}
        tip={troopPopupTip}
        value={pendingTroopCount}
        max={maxSendTroops}
        color={localColor}
        onChange={setPendingTroopCount}
        onConfirm={handleConfirmAction}
        onCancel={handleClearAction}
      />
    ) : null;

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
              <p className="mt-2 flex items-center justify-center gap-1.5 text-[10px] font-medium text-purple-400/70"><IconDeviceGamepad2 size={12} /> Play-for-Fun mode. No real tokens</p>
            )}

            {/* History link */}
            {isSignedIn && (
              <button
                onClick={() => router.push("/casino/hex-duel/history")}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[11px] font-medium border border-white/10 text-slate-400 hover:text-white hover:border-white/20 hover:bg-white/5 transition-all duration-200"
              >
                <span className="inline-flex items-center gap-1.5"><IconNotebook size={14} /> Match History</span>
              </button>
            )}
          </div>

          {/* ── AI Control Panel ────────────────────────────────────── */}
          {/* This row is mounted for as long as the match is, and its items
              keep their boxes once the match is under way. It used to be
              gated on `p1MoveCount === 0 && p2MoveCount === 0`, so the FIRST
              move of the match (which, on a fresh game, is the AI replying to
              the player's first End Turn) unmounted the whole row and pulled
              the board 48px up the page — the "board jumps when a turn ends"
              the player sees. The controls can't act once a move exists, so
              they are made invisible rather than unmounted: the same items
              with the same widths, so the row keeps one line at every
              breakpoint, and the sound toggle stays where it has always been
              and stays usable mid-match. Same reasoning for the "AI
              analyzing..." chip, which also used to wrap the row onto a
              second line on phones while the AI was thinking. */}
          {showGame && (
            <div data-hex-ai-panel="" className="mb-4 flex items-center justify-center gap-4 flex-wrap">
              <button
                onClick={() => {
  if (p1MoveCount === 0 && p2MoveCount === 0) {
    handleToggleAI();
  }
}}
                disabled={aiControlsLocked}
                tabIndex={aiControlsLocked ? -1 : undefined}
                title={aiControlsLocked ? "AI control is fixed once the match has started" : undefined}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-[0.12em] duration-200 transition-[color,background-color,border-color,box-shadow,transform] border ${
                  aiControlsLocked
                    ? "invisible"
                    : aiEnabled
                    ? "bg-purple-500/30 text-purple-200 border-purple-400/60 shadow-[0_0_12px_rgba(168,85,247,0.3)]"
                    : "border-white/15 text-slate-400 hover:text-white hover:border-white/30 hover:bg-white/5"
                }`}
              >
                <span className="inline-flex items-center gap-1.5">{aiEnabled ? <><IconRobot size={14} /> AI: ON</> : <><IconRobot size={14} /> VS AI</>}</span>
              </button>

              {aiEnabled && (
                <div className={`flex items-center gap-1.5 ${aiControlsLocked ? "invisible" : ""}`}>
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest">Difficulty:</span>
                  {(["easy", "medium"] as AIDifficulty[]).map((d) => (
                    <button
                      key={d}
                      onClick={() => handleDifficultyChange(d)}
                      disabled={aiControlsLocked}
                      tabIndex={aiControlsLocked ? -1 : undefined}
                      className={`px-3 py-1 rounded-md text-[11px] font-medium duration-200 transition-[color,background-color,border-color,box-shadow,transform] border capitalize ${
                        aiDifficulty === d
                          ? d === "easy" ? "bg-green-500/20 text-green-300 border-green-400/60" : "bg-yellow-500/20 text-yellow-300 border-yellow-400/60"
                          : "border-white/10 text-slate-400 hover:text-white hover:border-white/20"
                      }`}
                    >{d}</button>
                  ))}
                </div>
              )}

              {aiEnabled && (
                <span className={`inline-flex items-center gap-1 text-[10px] text-purple-400/70 animate-pulse ${aiAnalyzing ? "" : "invisible"}`}>
                  <IconRobot size={12} /> AI analyzing...
                </span>
              )}

                      {/* Sound toggle */}
              <button
                onClick={() => audio.setEnabled(!audio.enabled)}
                className={`px-3 py-1.5 rounded-lg text-[10px] transition-all duration-200 border ${
                  audio.enabled ? "border-white/10 text-slate-400" : "border-red-400/40 text-red-400/60"
                }`}
                title={audio.enabled ? "Mute sounds" : "Unmute sounds"}
              >
                {audio.enabled ? <IconVolume size={16} /> : <IconVolumeOff size={16} />}
              </button>


            </div>
          )}

          {/* ── Status Bar ──────────────────────────────────────────── */}
          {desktopContent}

          {/* ── Troop send popup (anchored to the target tile) ──────── */}
          {troopPopup}

          {/* ── Emotes ──────────────────────────────────────────────── */}
          {showGame && !isGameOver && !isSpectator && (
            <div className="mt-6 flex justify-center">
              <EmotePicker
                compact
                hideBubbles
                incomingEmote={incomingEmote}
                myEmote={myEmote}
                onSend={(emote) => sendEmote(emote)}
              />
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
                  <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report Player</span>
                </button>
              )}
            </div>
          )}

          {/* ── How to play ───────────────────────────────────────── */}
          <div className="mt-8 rounded-xl border border-white/[0.04] bg-[#050a18] p-4 text-center">
            <p className="text-[10px] text-slate-600 uppercase tracking-[0.25em] mb-2">▦ How to Play: Territory Conquest</p>
            <div className="flex flex-wrap items-center justify-center gap-3 text-[10px] text-slate-500">
              <span className="flex items-center gap-1"><span className="text-cyan-400">1.</span> Start with 5 troops on your <IconStar size={10} className="inline text-yellow-400" /> capital</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-yellow-400">2.</span> Select Attack (1 AP) to conquer adjacent enemy tiles</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-cyan-400">3.</span> Need 1 more troop than defender to conquer</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-green-400">4.</span> Use Displace (1 AP) to move troops between tiles</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-purple-400">5.</span> Each end-turn: +1 troop on all tiles, +1 AP (max 3)</span>
              <span className="text-slate-700">→</span>
              <span className="flex items-center gap-1"><span className="text-red-400">6.</span> Conquer the enemy&apos;s <IconStar size={10} className="inline text-yellow-400" /> capital to win!</span>
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
            noRealTokensWagered={isAiGame || gameMode === "for-fun" || gameMode === "idle"}
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

        {/* Victory / Lose result screen */}
        {effectiveWinner && (() => {
          const localPlayerWon = gameMode === "multiplayer"
            ? (isPlayer1 && effectiveWinner === "player1") || (!isPlayer1 && effectiveWinner === "player2")
            : effectiveWinner === "player1";

          // The winner is the opponent on a loss; on a win the opponent is
          // the other side. Keep the generic labels the old modals used.
          const opponentLabel = localPlayerWon
            ? (effectiveWinner === "player1"
                ? (aiEnabled ? "AI" : gameMode === "multiplayer" ? "Opponent" : "Player 2")
                : "Player 1")
            : (effectiveWinner === "player1" ? "Player 1"
                : (aiEnabled ? "AI" : gameMode === "multiplayer" ? "Opponent" : "Player 2"));

          const winnerMoves = effectiveWinner === "player1" ? p1MoveCount : p2MoveCount;
          const winnerTerritory = effectiveWinner === "player1" ? p1Territory : p2Territory;
          // Only real / multiplayer matches carry a token settlement; for-fun
          // and AI practice games keep payoutInfo null (sections auto-hide).
          const payoutInfo = payoutLoading ? null : (gameMode === "real" || gameMode === "multiplayer") ? payoutResult : null;

          return (
            <PvpResultScreen
              open
              outcome={localPlayerWon ? "win" : "loss"}
              gameName="Hex Duel"
              headline={localPlayerWon ? "Capital conquered!" : "Defeat!"}
              subline={localPlayerWon ? undefined : `${opponentLabel} conquered your capital!`}
              opponent={{
                name: opponentLabel,
                iconKey: oppIconKey,
                isAi: aiEnabled,
              }}
              tokenDelta={
                localPlayerWon
                  ? (payoutInfo && payoutInfo.payout > 0 ? payoutInfo.payout : null)
                  : (payoutInfo && payoutInfo.wager > 0 ? -payoutInfo.wager : null)
              }
              summary={[
                { label: localPlayerWon ? "Moves" : "Their Moves", value: String(winnerMoves) },
                { label: localPlayerWon ? "Territory" : "Their Territory", value: String(winnerTerritory) },
              ]}
              playAgain={localPlayerWon ? { onClick: handleRestart } : null}
              onReturnToLobby={handleRestart}
            />
          );
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
