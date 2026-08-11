"use client";

// src/app/casino/slots-pvp/[matchId]/page.jsx
//
// MATCH view for the PvP Slots ("Skill Slots") system — mirrors the
// plinko-pvp match view's structure (status poll + socket room +
// player side panels + result popups) with a 3×3 skill-stop slot
// board in the centre.
//
// How a round plays:
//   1. The server opens a 10-second spin window for both players
//      (hidden final reels are generated server-side per player).
//   2. Each player manually stops Reel 1/2/3 with the STOP buttons.
//      The server records each stop's timing (stop-accuracy bonus).
//   3. When BOTH boards are locked — or the 10s deadline passes
//      (AFK auto-stop) — the server scores both boards, picks the
//      round winner, and either opens the next round or finishes the
//      match (first to 3 round wins, best-of-5).
//
// Anti-cheat: the opponent's final reels stay hidden while a round is
// live (the status route scrubs them); the client only sees the
// opponent's stop progress. All scores are computed server-side.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import ReportModal from "../../../../components/ReportModal";
import { useSocket } from "../../../../context/SocketProvider";
import {
  SLOTS_PVP_MATCH_UPDATED,
  slotsPvpMatchRoom,
} from "../../../../lib/slots-pvp/rooms";
import {
  MATCH_STATUS,
  MAX_ROUNDS,
  RESULT,
  ROUNDS_TO_WIN,
} from "../../../../lib/slots-pvp/constants";
import { getTheme } from "../../../../lib/slotThemes";

// ── Inline SVG icons ─────────────────────────────────────────────────

function ReelIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" opacity="0.4" />
      <rect x="7" y="6" width="4.5" height="5" rx="0.75" />
      <rect x="13.5" y="6" width="4.5" height="5" rx="0.75" />
      <rect x="7" y="12.5" width="4.5" height="5" rx="0.75" />
      <rect x="13.5" y="12.5" width="4.5" height="5" rx="0.75" />
    </svg>
  );
}

function CrossIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M6 6 L18 18" />
      <path d="M18 6 L6 18" />
    </svg>
  );
}

function CheckIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

function LockIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5 V7 a4 4 0 0 1 8 0 v3.5" />
    </svg>
  );
}

function LoadingDotsIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

function AlertIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 3 L22 20 H2 Z" />
      <line x1="12" y1="10" x2="12" y2="15" />
      <circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TrophyIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M7 4 H17 V10 a5 5 0 0 1 -10 0 V4 Z" />
      <path d="M5 5 H3 a3 3 0 0 0 3 3" />
      <path d="M19 5 H21 a3 3 0 0 1 -3 3" />
      <path d="M9 19 H15" />
      <path d="M12 14 V19" />
    </svg>
  );
}

function SparkIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z" />
    </svg>
  );
}

// ── Player side panel ────────────────────────────────────────────────
// Shows the seat name, rounds won (the match score), aggregate points
// (the rounds-won tie-break) and the current board-lock chip.

function PlayerPanel({
  seat,
  displayName,
  avatarUrl,
  roundsWon,
  points,
  isViewer,
  stoppedCount,
  boardLocked,
  autoStopped,
  isLive,
  isFinished,
}) {
  const isCyan = seat === "player1";
  const headerColour = isCyan ? "text-cyan-200" : "text-fuchsia-200";
  const scoreColour = isCyan ? "text-cyan-100" : "text-fuchsia-100";
  const ringColour = isCyan
    ? "border-cyan-300/40 shadow-[0_0_18px_rgba(0,229,255,0.18)]"
    : "border-fuchsia-300/40 shadow-[0_0_18px_rgba(255,79,216,0.18)]";

  let chip = null;
  if (isFinished) {
    chip = { label: "MATCH OVER", cls: "bg-white/10 text-white/50 border-white/10" };
  } else if (boardLocked) {
    chip = {
      label: autoStopped ? "AFK LOCKED" : "LOCKED",
      cls: isCyan
        ? "bg-cyan-500/20 text-cyan-100 border-cyan-300/40 shadow-[0_0_14px_rgba(0,229,255,0.25)]"
        : "bg-fuchsia-500/20 text-fuchsia-100 border-fuchsia-300/40 shadow-[0_0_14px_rgba(255,79,216,0.25)]",
    };
  } else if (isLive) {
    chip = {
      label: `STOPPING ${stoppedCount}/3`,
      cls: isCyan
        ? "bg-cyan-500/20 text-cyan-100 border-cyan-300/40"
        : "bg-fuchsia-500/20 text-fuchsia-100 border-fuchsia-300/40",
    };
  } else {
    chip = { label: "WAITING", cls: "bg-white/5 text-white/50 border-white/10" };
  }

  return (
    <div
      className={`rounded-2xl border ${ringColour} bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] p-3 sm:p-4 flex flex-col gap-3 h-full`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="w-8 h-8 rounded-full border border-white/20 object-cover shrink-0"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <span
            className={`w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-sm font-black ${
              isCyan
                ? "bg-cyan-500/25 text-cyan-100 border border-cyan-300/40"
                : "bg-fuchsia-500/25 text-fuchsia-100 border border-fuchsia-300/40"
            }`}
          >
            {(displayName || "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className={`text-[10px] uppercase tracking-wider ${headerColour}/70 font-semibold`}>
            {(isCyan ? "Player 1" : "Player 2") + (isViewer ? " · You" : "")}
          </p>
          <p className={`text-sm font-bold ${headerColour} truncate`} title={displayName}>
            {displayName}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-white/5 border border-white/10 p-2 text-center">
          <p className="text-[9px] uppercase tracking-wider text-white/50">Rounds won</p>
          <p className={`text-2xl sm:text-3xl font-black tabular-nums ${scoreColour}`}>{roundsWon}</p>
        </div>
        <div className="rounded-xl bg-white/5 border border-white/10 p-2 text-center">
          <p className="text-[9px] uppercase tracking-wider text-white/50">Points</p>
          <p className={`text-2xl sm:text-3xl font-black tabular-nums ${scoreColour}`}>{points}</p>
        </div>
      </div>

      <motion.div
        key={chip.label}
        initial={{ scale: 0.82, opacity: 0.55 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 26 }}
        className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold tracking-wide ${chip.cls}`}
        aria-live="polite"
      >
        {chip.label === "LOCKED" || chip.label === "AFK LOCKED" ? (
          <CheckIcon className="w-3.5 h-3.5" />
        ) : isLive && !boardLocked ? (
          <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
        ) : (
          <CrossIcon className="w-3 h-3 opacity-60" />
        )}
        {chip.label}
      </motion.div>
    </div>
  );
}

// ── Round result popup ──────────────────────────────────────────────

function RoundPopup({
  spinNumber,
  p1Name,
  p2Name,
  p1Score,
  p2Score,
  p1Lines,
  p2Lines,
  roundWinner,
  onNextRound,
}) {
  const [timer, setTimer] = useState(5);
  const timerRef = useRef(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setTimer((t) => {
        if (t <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          onNextRound();
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [onNextRound]);

  const p1Won = roundWinner === RESULT.PLAYER1;
  const p2Won = roundWinner === RESULT.PLAYER2;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
    >
      <div className="rounded-2xl border border-cyan-300/40 bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] p-6 sm:p-8 max-w-md w-full shadow-[0_0_80px_rgba(0,229,255,0.25)]">
        <h3 className="text-center text-sm uppercase tracking-widest text-cyan-200/70 font-semibold mb-1">
          Round {spinNumber} Results
        </h3>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="text-center">
            <p className="text-[11px] uppercase tracking-wider text-cyan-300/70 font-semibold truncate" title={p1Name}>
              {p1Name}
            </p>
            <p className={`text-3xl font-black mt-1 tabular-nums ${p1Won ? "text-cyan-300" : "text-white/60"}`}>
              {p1Score}
            </p>
            <p className="text-[10px] text-white/45 mt-1">{p1Lines} line{p1Lines === 1 ? "" : "s"}</p>
          </div>
          <div className="text-center">
            <p className="text-[11px] uppercase tracking-wider text-fuchsia-300/70 font-semibold truncate" title={p2Name}>
              {p2Name}
            </p>
            <p className={`text-3xl font-black mt-1 tabular-nums ${p2Won ? "text-fuchsia-300" : "text-white/60"}`}>
              {p2Score}
            </p>
            <p className="text-[10px] text-white/45 mt-1">{p2Lines} line{p2Lines === 1 ? "" : "s"}</p>
          </div>
        </div>

        {p1Won && (
          <p className="text-center text-sm font-bold text-cyan-300 mt-4">
            <SparkIcon className="w-4 h-4 inline-block mr-1 text-cyan-300" />
            {p1Name} wins this round!
          </p>
        )}
        {p2Won && (
          <p className="text-center text-sm font-bold text-fuchsia-300 mt-4">
            <SparkIcon className="w-4 h-4 inline-block mr-1 text-fuchsia-300" />
            {p2Name} wins this round!
          </p>
        )}
        {!p1Won && !p2Won && (
          <p className="text-center text-sm font-bold text-yellow-300 mt-4">
            It&apos;s a tie — no round point awarded!
          </p>
        )}

        <button
          onClick={onNextRound}
          className="mt-6 w-full px-4 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-400 to-cyan-500 text-[#001933] hover:from-cyan-300 hover:to-cyan-400 transition shadow-[0_0_25px_rgba(0,229,255,0.4)]"
        >
          Next Round ({timer}s)
        </button>
      </div>
    </motion.div>
  );
}

// ── Winner popup ────────────────────────────────────────────────────

function WinnerPopup({ match, user, onBack, p1Name, p2Name }) {
  const isDraw = match.result === RESULT.DRAW;
  const iWon = Boolean(match.winnerId && user?.id && match.winnerId === user.id);
  const roundsDiff = Math.abs((match.roundsWonPlayer1 || 0) - (match.roundsWonPlayer2 || 0));

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
    >
      <div className="rounded-2xl border border-cyan-300/40 bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] p-6 sm:p-8 max-w-md w-full shadow-[0_0_80px_rgba(0,229,255,0.25)]">
        <div className="flex items-center justify-center mb-4">
          <TrophyIcon className="w-10 h-10 text-yellow-300 drop-shadow-[0_0_16px_rgba(255,200,0,0.5)]" />
        </div>
        <h3 className="text-center text-sm uppercase tracking-widest text-cyan-200/70 font-semibold mb-1">
          Match Over
        </h3>

        <p
          className={`text-center text-3xl font-black mt-2 ${
            isDraw ? "text-yellow-300" : iWon ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {isDraw ? "It's a Draw!" : iWon ? "You Win!" : "You Lose"}
        </p>

        {!isDraw && (
          <p className="text-center text-sm text-white/70 mt-2">
            <span className="font-bold text-white">
              {iWon ? "You" : match.winnerId === match.player1Id ? p1Name : p2Name}
            </span>{" "}
            won{" "}
            <span className="font-bold text-white">
              {Math.max(match.roundsWonPlayer1 || 0, match.roundsWonPlayer2 || 0)}
            </span>
            {" "}rounds to{" "}
            <span className="font-bold text-white">
              {Math.min(match.roundsWonPlayer1 || 0, match.roundsWonPlayer2 || 0)}
            </span>
            {roundsDiff === 0 ? "" : ` (by ${roundsDiff} round${roundsDiff === 1 ? "" : "s"})`}
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 mt-5">
          <div className="rounded-xl border border-cyan-300/30 bg-cyan-500/10 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-cyan-200/70 truncate">{p1Name}</p>
            <p className="mt-1 text-2xl font-black text-cyan-100 tabular-nums">
              {match.roundsWonPlayer1 || 0} rounds
            </p>
            <p className="text-[10px] text-white/50 mt-0.5 tabular-nums">{match.p1Score || 0} pts</p>
          </div>
          <div className="rounded-xl border border-fuchsia-300/30 bg-fuchsia-500/10 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-fuchsia-200/70 truncate">{p2Name}</p>
            <p className="mt-1 text-2xl font-black text-fuchsia-100 tabular-nums">
              {match.roundsWonPlayer2 || 0} rounds
            </p>
            <p className="text-[10px] text-white/50 mt-0.5 tabular-nums">{match.p2Score || 0} pts</p>
          </div>
        </div>

        {!isDraw && (
          <p className="text-center text-xs text-white/60 mt-4">
            Prize paid:{" "}
            <span className="text-white font-bold">{(match.prizePaid || 0).toFixed(2)}</span>
          </p>
        )}
        {isDraw && (
          <p className="text-center text-xs text-white/60 mt-4">
            Both players refunded — no house fee
          </p>
        )}

        <button
          onClick={onBack}
          className="mt-6 w-full px-4 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-400 to-cyan-500 text-[#001933] hover:from-cyan-300 hover:to-cyan-400 transition shadow-[0_0_25px_rgba(0,229,255,0.4)]"
        >
          Back to Lobby
        </button>
      </div>
    </motion.div>
  );
}

// ── VS scoreboard ───────────────────────────────────────────────────
// The match-header scoreboard: YOU vs OPPONENT, the current match
// score (rounds won each), Round X/5, a live countdown ring, per-player
// round-win dots and the viewer's CURRENT round score (server-computed;
// the opponent's score never appears here).

function ScoreBoard({
  p1Name,
  p2Name,
  p1Avatar,
  p2Avatar,
  roundsWonP1,
  roundsWonP2,
  currentSpin,
  maxRounds,
  roundsToWin,
  isViewerP1,
  timeLeft,
  roundTimer,
  status,
  viewerRoundScore,
  winBySpin,
}) {
  const isFinished = status === MATCH_STATUS.FINISHED;
  const isCancelled = status === MATCH_STATUS.CANCELLED;
  const isReady = status === MATCH_STATUS.READY;
  const isWaiting = status === MATCH_STATUS.WAITING;
  const isSpin = /^spin_\d+$/.test(status || "");
  const countdownLive = (isSpin || isReady) && !isFinished && !isCancelled;
  const urgent = isSpin && timeLeft > 0 && timeLeft <= 5;
  const ringTotal = isReady ? 3 : roundTimer || 10;
  const progress = countdownLive
    ? Math.min(1, Math.max(0, timeLeft / ringTotal))
    : 0;
  const RING_R = 18;
  const RING_CIRC = 2 * Math.PI * RING_R;

  const dotState = (seat, spin) => {
    const w = winBySpin[spin];
    if (!w) return "pending";
    if (w === RESULT.DRAW) return "draw";
    const mine = seat === "player1" ? RESULT.PLAYER1 : RESULT.PLAYER2;
    return w === mine ? "won" : "lost";
  };

  function Side({ seat, name, avatar, roundsWon }) {
    const cyan = seat === "player1";
    const isYou = cyan ? isViewerP1 : !isViewerP1;
    const numColour = cyan ? "text-cyan-100" : "text-fuchsia-100";
    return (
      <div className="flex flex-col items-center text-center min-w-0">
        <span
          className={`text-[9px] sm:text-[10px] uppercase tracking-widest font-black ${
            cyan ? "text-cyan-300/80" : "text-fuchsia-300/80"
          }`}
        >
          {isYou ? "You" : "Opponent"}
        </span>
        <div className="flex items-center gap-1.5 mt-1 min-w-0 max-w-full">
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              alt=""
              className="w-6 h-6 sm:w-7 sm:h-7 rounded-full border border-white/20 object-cover shrink-0"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <span
              className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-xs font-black shrink-0 border ${
                cyan
                  ? "border-cyan-300/40 bg-cyan-500/25 text-cyan-100"
                  : "border-fuchsia-300/40 bg-fuchsia-500/25 text-fuchsia-100"
              }`}
            >
              {(name || "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          <p
            className={`text-xs sm:text-sm font-bold truncate ${numColour}`}
            title={name}
          >
            {name}
          </p>
        </div>
        <p
          className={`text-2xl sm:text-3xl font-black tabular-nums leading-none mt-1 ${numColour}`}
        >
          {roundsWon}
        </p>
        <div className="flex items-center justify-center gap-1 mt-1.5">
          {Array.from({ length: maxRounds }, (_, i) => {
            const spin = i + 1;
            const state = dotState(seat, spin);
            const cls =
              state === "won"
                ? cyan
                  ? "bg-cyan-300 shadow-[0_0_6px_rgba(0,229,255,0.9)]"
                  : "bg-fuchsia-300 shadow-[0_0_6px_rgba(255,79,216,0.9)]"
                : state === "lost"
                  ? "bg-red-500/40"
                  : state === "draw"
                    ? "bg-yellow-300/70"
                    : "bg-white/10 border border-white/25";
            return (
              <span
                key={spin}
                className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${cls}`}
                title={`Round ${spin}: ${state}`}
              />
            );
          })}
        </div>
      </div>
    );
  }

  const rs = viewerRoundScore;
  let roundScoreChip = null;
  if (!isFinished && !isCancelled && !isWaiting && !isReady) {
    if (rs?.locked) {
      roundScoreChip = (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-0.5 text-[10px] font-bold text-emerald-300 tabular-nums">
          <CheckIcon className="w-3 h-3" />
          Your round: {rs.totalScore} pts
          {rs.lineCount > 0
            ? ` · ${rs.lineCount} line${rs.lineCount === 1 ? "" : "s"} ×${rs.multiplier}`
            : ""}
        </span>
      );
    } else if (rs && rs.stopBonus > 0) {
      roundScoreChip = (
        <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/40 bg-sky-500/15 px-2.5 py-0.5 text-[10px] font-bold text-sky-300 tabular-nums">
          <SparkIcon className="w-3 h-3" />
          Bonus +{rs.stopBonus}
        </span>
      );
    } else {
      roundScoreChip = (
        <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[10px] font-semibold text-white/50 tabular-nums">
          Your round: —
        </span>
      );
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] px-3 sm:px-6 py-3 sm:py-4 shadow-[0_0_40px_rgba(0,229,255,0.12)]">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-5">
        <Side seat="player1" name={p1Name} avatar={p1Avatar} roundsWon={roundsWonP1} />

        {/* Center: round X/5 + countdown ring + round score */}
        <div className="flex flex-col items-center gap-0.5 min-w-0">
          <span className="text-[9px] sm:text-[10px] uppercase tracking-widest text-white/50 font-bold">
            Round{" "}
            <span className="text-white font-black text-sm sm:text-base tabular-nums">
              {currentSpin}
            </span>
            <span className="text-white/40">/{maxRounds}</span>
          </span>
          <span className="text-[9px] uppercase tracking-wider text-white/40 font-semibold">
            First to {roundsToWin}
          </span>

          <div className="relative w-12 h-12 sm:w-14 sm:h-14 mt-1">
            {countdownLive ? (
              <>
                <svg viewBox="0 0 48 48" className="w-full h-full -rotate-90">
                  <circle
                    cx="24"
                    cy="24"
                    r={RING_R}
                    fill="none"
                    stroke="rgba(255,255,255,0.12)"
                    strokeWidth="4"
                  />
                  <circle
                    cx="24"
                    cy="24"
                    r={RING_R}
                    fill="none"
                    stroke={urgent ? "#f87171" : "#22d3ee"}
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRC}
                    strokeDashoffset={RING_CIRC * (1 - progress)}
                    style={{
                      transition: "stroke-dashoffset 300ms linear, stroke 300ms",
                    }}
                  />
                </svg>
                <span
                  className={`absolute inset-0 flex items-center justify-center text-base sm:text-lg font-black tabular-nums ${
                    urgent ? "text-red-300" : "text-cyan-100"
                  }`}
                >
                  {timeLeft}
                </span>
              </>
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-lg">
                {isFinished ? (
                  <TrophyIcon className="w-7 h-7 text-yellow-300 drop-shadow-[0_0_10px_rgba(255,200,0,0.5)]" />
                ) : (
                  <span className="text-white/30">—</span>
                )}
              </span>
            )}
          </div>

          <div className="mt-0.5">{roundScoreChip}</div>
        </div>

        <Side seat="player2" name={p2Name} avatar={p2Avatar} roundsWon={roundsWonP2} />
      </div>
    </div>
  );
}

// ── Slot board ──────────────────────────────────────────────────────
// 3×3 grid. Each column rolls (cosmetic tick) until the player stops
// it, then freezes on the server-generated final symbols.

function SlotBoard({
  theme,
  viewerInputs,
  canStop,
  onStop,
  rolling,
  rollTick,
  isLive,
  accuracyByReel,
}) {
  const themeObj = getTheme(theme);
  const symbols = themeObj.symbols;
  const reels = viewerInputs?.reels || null; // [col][row]
  const reelsStopped = Array.isArray(viewerInputs?.reelsStopped)
    ? viewerInputs.reelsStopped
    : [];
  const boardLocked = Boolean(viewerInputs?.boardLocked);

  const stopped = (col) => reelsStopped.includes(col);
  const accuracyFor = (col) => {
    if (!Array.isArray(accuracyByReel)) return null;
    return accuracyByReel.find((a) => a.reel === col) || null;
  };

  return (
    <div className="rounded-2xl border border-cyan-300/30 bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814] p-3 sm:p-4 shadow-[0_0_60px_rgba(0,229,255,0.18),inset_0_0_30px_rgba(0,229,255,0.08)]">
      {/* Belly-glass header */}
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-[10px] uppercase tracking-widest text-cyan-200/70 font-bold">
          {themeObj.name}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-white/40 font-bold">
          3×3 · Skill Stop
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {[0, 1, 2].map((col) => {
          const isStopped = stopped(col);
          const spinning = isLive && !isStopped && !boardLocked;
          const acc = accuracyFor(col);
          return (
            <div key={col} className="flex flex-col gap-1.5">
              {/* Reel label + lock badge */}
              <div className="flex items-center justify-between px-0.5">
                <span className="text-[9px] uppercase tracking-widest text-white/40 font-bold">
                  Reel {col + 1}
                </span>
                {isStopped && (
                  <span className="inline-flex items-center gap-0.5 text-[9px] font-black tracking-widest text-emerald-300">
                    <LockIcon className="w-3 h-3" />
                    LOCKED
                  </span>
                )}
              </div>

              {/* Reel column */}
              <div
                className={`rounded-xl border bg-gradient-to-b from-[#08142f] to-[#020617] overflow-hidden ${
                  isStopped
                    ? "border-emerald-400/60 shadow-[0_0_16px_rgba(16,185,129,0.35)]"
                    : spinning
                      ? "border-white/25"
                      : "border-white/15"
                }`}
              >
                {[0, 1, 2].map((row) => {
                  const finalSym =
                    reels && reels[col] ? reels[col][row] : "?";
                  const shown = spinning
                    ? symbols[(rollTick + col * 7 + row * 13) % symbols.length]
                    : finalSym;
                  return (
                    <div
                      key={row}
                      className={`flex items-center justify-center h-16 sm:h-20 md:h-24 text-3xl sm:text-4xl md:text-5xl select-none ${
                        spinning ? "blur-[0.5px]" : ""
                      } ${row > 0 ? "border-t border-white/10" : ""}`}
                      aria-hidden={spinning}
                    >
                      {shown}
                    </div>
                  );
                })}
              </div>

              {/* STOP button */}
              <button
                onClick={() => onStop(col)}
                disabled={!canStop || isStopped || boardLocked}
                className={`w-full px-2 py-2 rounded-lg text-xs font-black tracking-widest transition ${
                  isStopped
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/50"
                    : boardLocked
                      ? "bg-white/5 text-white/30 border border-white/10 cursor-not-allowed"
                      : canStop
                        ? "bg-gradient-to-r from-red-500 to-orange-500 text-white hover:from-red-400 hover:to-orange-400 shadow-[0_0_14px_rgba(255,60,60,0.45)] animate-pulse"
                        : "bg-white/5 text-white/30 border border-white/10 cursor-not-allowed"
                }`}
              >
                {isStopped ? "✓ STOPPED" : "STOP"}
              </button>

              {/* Accuracy chip (server-computed, once known) */}
              {isStopped && acc && (
                <span
                  className={`text-center text-[9px] font-black tracking-widest uppercase ${
                    acc.accuracy === "perfect"
                      ? "text-emerald-300"
                      : acc.accuracy === "good"
                        ? "text-sky-300"
                        : "text-white/40"
                  }`}
                >
                  {acc.accuracy === "perfect"
                    ? "Perfect +100"
                    : acc.accuracy === "good"
                      ? "Good +50"
                      : "Normal +0"}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Status strip under the board */}
      <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-white/55">
        {boardLocked ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-300">
            <CheckIcon className="w-3.5 h-3.5" />
            Board locked — waiting for opponent{isLive ? " or the deadline" : ""}…
          </span>
        ) : isLive ? (
          <span className="inline-flex items-center gap-1.5">
            <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
            Stop all 3 reels — fast stops earn accuracy bonuses!
          </span>
        ) : (
          <span>Board ready</span>
        )}
      </div>
    </div>
  );
}

// ── Page component ───────────────────────────────────────────────────

export default function SlotsPvpMatchPage({ params }) {
  const paramsPromise = useMemo(() => Promise.resolve(params), [params]);
  const resolvedParams = use(paramsPromise);
  const rawMatchId =
    resolvedParams && typeof resolvedParams === "object"
      ? resolvedParams.matchId
      : undefined;
  const numericMatchId = Number(rawMatchId);
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;
  const isValidMatchId = matchId !== null;
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Core match state ─────────────────────────────────────────────
  const [match, setMatch] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [roundPopup, setRoundPopup] = useState(null);
  // Cosmetic reel-roll ticker (advances while any reel is spinning).
  const [rollTick, setRollTick] = useState(0);

  const fetchStatusPendingRef = useRef(false);
  const lastRoundsLenRef = useRef(0);
  const hasInitializedRoundsRef = useRef(false);
  const resolvedFiredRef = useRef(false);

  // ── Status fetch (mirrors plinko-pvp: 800ms poll + in-flight guard) ──
  const fetchStatus = useCallback(async () => {
    if (isSignedIn === false) {
      setLoading(false);
      setError("You must be signed in to view this match.");
      return null;
    }
    if (isSignedIn !== true) return null;
    if (!isValidMatchId) {
      setLoading(false);
      setError("Invalid match link.");
      return null;
    }
    if (fetchStatusPendingRef.current) return null;
    fetchStatusPendingRef.current = true;
    try {
      const res = await fetch(`/api/slots-pvp/match/${matchId}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to load match");
        return null;
      }
      const nextMatch =
        data?.data?.match && typeof data.data.match === "object"
          ? data.data.match
          : null;
      const nextRounds = Array.isArray(data?.data?.rounds)
        ? data.data.rounds
        : [];
      setMatch(nextMatch);
      setRounds(nextRounds);
      // Seed the round-popup baseline on FIRST load so a mid-match
      // page refresh never replays popups for already-resolved rounds.
      if (!hasInitializedRoundsRef.current) {
        hasInitializedRoundsRef.current = true;
        lastRoundsLenRef.current = nextRounds.length;
      }
      setError(nextMatch ? null : "Match not found.");
      return nextMatch;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      return null;
    } finally {
      setLoading(false);
      fetchStatusPendingRef.current = false;
    }
  }, [isSignedIn, isValidMatchId, matchId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 800);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // ── Socket subscription (per-match room; re-join on reconnect) ────
  useEffect(() => {
    if (!socket) return;
    if (!isValidMatchId) return;
    const refresh = () => fetchStatus();
    const roomId = slotsPvpMatchRoom(matchId);
    // Re-join on EVERY socket (re)connection — Socket.IO doesn't
    // re-join rooms automatically, and the realtime server's
    // disconnect grace timer is only cancelled by a re-join.
    const join = () => socket.emit("join_room", { roomId });
    join();
    socket.on("connect", join);
    socket.on(SLOTS_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.off("connect", join);
      socket.emit("leave_room", { roomId });
      socket.off(SLOTS_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, isValidMatchId, fetchStatus]);

  // ── Countdown tick ───────────────────────────────────────────────
  useEffect(() => {
    if (!match?.roundDeadline) {
      setTimeLeft(0);
      return;
    }
    if (
      match.status === MATCH_STATUS.FINISHED ||
      match.status === MATCH_STATUS.CANCELLED
    ) {
      setTimeLeft(0);
      return;
    }
    const deadlineMs = new Date(match.roundDeadline).getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setTimeLeft(remaining);
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [match?.roundDeadline, match?.status]);

  // ── Reel-roll ticker: animate unstopped reels while a round is live ──
  useEffect(() => {
    if (!match) return;
    const isSpin = /^spin_\d+$/.test(match.status || "");
    const viewerInputs = match.viewerIsPlayer1
      ? match.p1CurrentInputs
      : match.p2CurrentInputs;
    const stillRolling =
      isSpin &&
      viewerInputs &&
      !viewerInputs.boardLocked &&
      (viewerInputs.reelsStopped?.length || 0) < 3;
    if (!stillRolling) return;
    const id = setInterval(() => setRollTick((t) => t + 1), 70);
    return () => clearInterval(id);
  }, [match?.status, match?.p1CurrentInputs, match?.p2CurrentInputs]);

  // ── Round result popup: fires when a NEW round row appears ───────
  useEffect(() => {
    if (rounds.length === 0) return;
    if (rounds.length <= lastRoundsLenRef.current) return;
    lastRoundsLenRef.current = rounds.length;
    // The match-finishing round shows the WinnerPopup instead.
    if (match?.status === MATCH_STATUS.FINISHED) return;
    const row = rounds[rounds.length - 1];
    setRoundPopup({
      spinNumber: row.spinNumber,
      p1Score: row.spinPointsPlayer1,
      p2Score: row.spinPointsPlayer2,
      p1Lines: row.player1Result?.lineCount ?? 0,
      p2Lines: row.player2Result?.lineCount ?? 0,
      roundWinner: row.roundWinner,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds, match?.status]);

  const onNextRound = useCallback(() => {
    setRoundPopup(null);
    fetchStatus();
  }, [fetchStatus]);

  // ── Stop a reel ──────────────────────────────────────────────────
  const handleStopReel = useCallback(
    async (reelIndex) => {
      if (busy || !isValidMatchId) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/slots-pvp/match/${matchId}/stop-reel`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reelIndex,
            currentSpin: match?.currentSpin ?? null,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          // 409 / 400 (already stopped / expired) are expected races —
          // a fresh poll reconciles. Only surface unexpected errors.
          if (res.status !== 409 && res.status !== 400) {
            setError(data?.error || "Unable to stop reel");
          }
          return;
        }
        posthog?.capture("slots_pvp_reel_stopped", {
          match_id: matchId,
          reel: reelIndex,
          round_resolved: data?.data?.roundResolved === true,
        });
        fetchStatus();
      } finally {
        setBusy(false);
      }
    },
    [busy, isValidMatchId, matchId, match?.currentSpin, posthog, fetchStatus],
  );

  // ── Cancel handler (host-only while waiting) ─────────────────────
  const handleCancel = useCallback(async () => {
    if (cancelling || !isValidMatchId) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/slots-pvp/match/${matchId}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Cancel failed");
        return;
      }
      posthog?.capture("slots_pvp_lobby_cancelled", { match_id: matchId });
      router.push("/casino/slots-pvp");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, matchId, posthog, router]);

  // ── Busy safety-net (mirrors plinko-pvp) ─────────────────────────
  useEffect(() => {
    if (!busy) return;
    const watchdog = setTimeout(() => setBusy(false), 8000);
    return () => clearTimeout(watchdog);
  }, [busy]);

  // ── Posthog: match-just-resolved ────────────────────────────────
  useEffect(() => {
    if (!match || match.status !== MATCH_STATUS.FINISHED) {
      if (resolvedFiredRef.current) resolvedFiredRef.current = false;
      return;
    }
    if (resolvedFiredRef.current) return;
    resolvedFiredRef.current = true;
    const isDraw = match.result === RESULT.DRAW;
    const iWon = Boolean(match.winnerId && user?.id && match.winnerId === user.id);
    const winner = isDraw ? "draw" : iWon ? "you" : "opponent";
    posthog?.capture("slots_pvp_match_resolved", {
      match_id: match?.id ?? matchId ?? -1,
      winner,
      result: match.result,
      stake: (match.stakeAmount || 0).toFixed(2),
      prize_paid: (match.prizePaid || 0).toFixed(2),
      house_fee: (match.houseFee || 0).toFixed(2),
      rounds_won_p1: match.roundsWonPlayer1,
      rounds_won_p2: match.roundsWonPlayer2,
    });
  }, [match, matchId, user?.id, posthog]);

  // ── Loading / error renders ────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-12 flex max-w-3xl items-center justify-center gap-3 text-cyan-200">
          <LoadingDotsIcon className="w-6 h-6 text-cyan-300 animate-pulse" />
          <span>Loading match…</span>
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-red-400/40 bg-red-900/30 p-6 text-red-200">
          <div className="flex items-center gap-2">
            <AlertIcon className="w-5 h-5 text-red-300" />
            <span className="font-semibold">{error || "Match not found."}</span>
          </div>
          <button
            onClick={() => router.push("/casino/slots-pvp")}
            className="mt-4 px-4 py-2 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold"
          >
            Back to lobby
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  if (!match.viewerIsParticipant) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-red-400/40 bg-red-900/30 p-6 text-red-200">
          <div className="flex items-center gap-2">
            <AlertIcon className="w-5 h-5 text-red-300" />
            <span className="font-semibold">
              You are not a participant in this match.
            </span>
          </div>
          <button
            onClick={() => router.push("/casino/slots-pvp")}
            className="mt-4 px-4 py-2 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold"
          >
            Back to lobby
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  // ── Derived state ─────────────────────────────────────────────
  const isFinished = match.status === MATCH_STATUS.FINISHED;
  const isCancelled = match.status === MATCH_STATUS.CANCELLED;
  const isReady = match.status === MATCH_STATUS.READY;
  const isWaiting = match.status === MATCH_STATUS.WAITING;
  const isSpin = /^spin_\d+$/.test(match.status || "");
  // Urgency only applies to live ROUND countdowns — the 3s "Get ready"
  // window must not render red (its timeLeft is always <= 5).
  const urgent = isSpin && timeLeft > 0 && timeLeft <= 5;

  const isViewerP1 = match.viewerIsPlayer1;
  const viewerSeat = isViewerP1 ? "player1" : "player2";
  const viewerInputs = isViewerP1
    ? match.p1CurrentInputs
    : match.p2CurrentInputs;
  const opponentInputs = isViewerP1
    ? match.p2CurrentInputs
    : match.p1CurrentInputs;

  const stake = match.stakeAmount;

  function shortId(id) {
    if (!id) return "Opponent";
    return id.length <= 7 ? id : id.slice(0, 6) + "…";
  }
  const p1Name = match.players?.p1?.displayName ?? shortId(match.player1Id);
  const p2Name = match.players?.p2?.displayName ?? shortId(match.player2Id);
  const p1Avatar = match.players?.p1?.profileImageUrl ?? null;
  const p2Avatar = match.players?.p2?.profileImageUrl ?? null;
  const opponentClerkId = isViewerP1 ? match.player2Id : match.player1Id;
  const opponentName = isViewerP1 ? p2Name : p1Name;

  const viewerStoppedCount = Array.isArray(viewerInputs?.reelsStopped)
    ? viewerInputs.reelsStopped.length
    : 0;
  const opponentStoppedCount = Array.isArray(opponentInputs?.reelsStopped)
    ? opponentInputs.reelsStopped.length
    : 0;

  // Server-computed current round score for the VIEWER's own board
  // (null while waiting / ready / after the match ends).
  const viewerRoundScore = match.viewerRoundScore || null;
  const roundTimer = match.roundTimer || 10;
  // spinNumber → roundWinner map, drives the scoreboard win dots.
  const winBySpin = {};
  rounds.forEach((r) => {
    if (r.spinNumber != null) winBySpin[r.spinNumber] = r.roundWinner;
  });

  // ── Status banner ─────────────────────────────────────────────
  function renderStatusBanner() {
    if (isCancelled) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-4 py-3 text-red-200">
          <AlertIcon className="w-5 h-5 text-red-300" />
          <span className="font-semibold">
            This match was cancelled — your stake was refunded.
          </span>
        </div>
      );
    }
    if (isFinished) return null;
    if (isWaiting) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3 text-cyan-200">
          <LoadingDotsIcon className="w-5 h-5 text-cyan-200 animate-pulse" />
          <span className="font-semibold">
            Waiting for an opponent to join… (your stake is escrowed)
          </span>
        </div>
      );
    }
    if (isReady) {
      return (
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3 text-cyan-200">
          <span className="font-bold text-base sm:text-lg">
            Both players joined — match starting…
          </span>
        </div>
      );
    }
    if (isSpin) {
      const bothLocked = match.viewerHasLocked && match.opponentHasLocked;
      if (bothLocked) {
        return (
          <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-3 text-emerald-200 animate-pulse">
            <span className="font-bold text-base sm:text-lg">
              Both boards locked — scoring the round!
            </span>
          </div>
        );
      }
      return (
        <div
          className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border px-4 py-3 ${
            urgent
              ? "border-red-400/60 bg-red-900/30 text-red-200 animate-pulse"
              : "border-cyan-300/40 bg-cyan-500/10 text-cyan-200"
          }`}
        >
          <span className="font-bold text-base sm:text-lg">
            {match.viewerCanStop
              ? "Stop your 3 reels — perfect stops earn +100!"
              : match.viewerHasLocked
                ? match.opponentHasLocked
                  ? "Scoring…"
                  : "You're locked — waiting for opponent"
                : "Opponent is stopping their reels…"}
          </span>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-3 sm:mt-4 max-w-[1200px]">
        {/* Title + status */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ReelIcon className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
            <h1 className="text-lg sm:text-xl font-black tracking-tight">
              Slots Duel · Match #{matchId ?? "?"}
            </h1>
          </div>
          <div className="text-[11px] sm:text-xs text-white/60 flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  socket?.connected
                    ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]"
                    : "bg-white/30"
                }`}
              />
              {socket?.connected ? "Live" : "Polling"}
            </span>
            <span className="font-mono">{(stake || 0).toFixed(2)} stake</span>
            <span className="font-mono">Best-of-5</span>
            <span className="font-mono">
              {viewerSeat === "player1" ? "P1" : "P2"} seat
            </span>
            {opponentClerkId && (
              <button
                onClick={() => setShowReportModal(true)}
                className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 font-bold text-red-400 transition-all hover:bg-red-500/20 hover:shadow-[0_0_10px_rgba(239,68,68,0.3)]"
              >
                🚩 Report
              </button>
            )}
          </div>
        </div>

        <div className="mt-3">{renderStatusBanner()}</div>

        {/* VS scoreboard: You vs Opponent, match score, round, countdown */}
        <div className="mt-3">
          <ScoreBoard
            p1Name={p1Name}
            p2Name={p2Name}
            p1Avatar={p1Avatar}
            p2Avatar={p2Avatar}
            roundsWonP1={match.roundsWonPlayer1 || 0}
            roundsWonP2={match.roundsWonPlayer2 || 0}
            currentSpin={match.currentSpin ?? 1}
            maxRounds={MAX_ROUNDS}
            roundsToWin={ROUNDS_TO_WIN}
            isViewerP1={isViewerP1}
            timeLeft={timeLeft}
            roundTimer={roundTimer}
            status={match.status}
            viewerRoundScore={viewerRoundScore}
            winBySpin={winBySpin}
          />
        </div>

        {/* 3-column layout (mobile: stacked) */}
        <div className="mt-4 grid gap-4 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_280px]">
          {/* Player 1 panel (left) */}
          <div className="order-2 lg:order-1">
            <PlayerPanel
              seat="player1"
              displayName={p1Name}
              avatarUrl={p1Avatar}
              roundsWon={match.roundsWonPlayer1 || 0}
              points={match.p1Score || 0}
              isViewer={isViewerP1}
              stoppedCount={isViewerP1 ? viewerStoppedCount : opponentStoppedCount}
              boardLocked={
                isViewerP1
                  ? Boolean(viewerInputs?.boardLocked)
                  : Boolean(opponentInputs?.boardLocked)
              }
              autoStopped={
                isViewerP1
                  ? Boolean(viewerInputs?.autoStopped)
                  : Boolean(opponentInputs?.autoStopped)
              }
              isLive={isSpin && !isFinished && !isCancelled}
              isFinished={isFinished}
            />
          </div>

          {/* Center: slot board */}
          <div className="order-1 lg:order-2 min-w-0">
            <SlotBoard
              theme={match.theme || "fruit"}
              viewerInputs={viewerInputs}
              canStop={Boolean(match.viewerCanStop)}
              onStop={handleStopReel}
              rolling={isSpin}
              rollTick={rollTick}
              isLive={isSpin && !isFinished && !isCancelled}
              accuracyByReel={viewerRoundScore?.accuracyByReel || null}
            />

            {/* 10s countdown progress bar */}
            {(isSpin || isReady) && !isFinished && !isCancelled && (
              <div className="mt-2">
                <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      urgent ? "bg-red-400" : "bg-cyan-400"
                    }`}
                    style={{
                      width: `${Math.min(100, Math.max(0, (timeLeft / (isReady ? 3 : roundTimer)) * 100))}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[9px] uppercase tracking-widest text-white/35 font-bold">
                  <span>{isReady ? "Get ready…" : "Round timer"}</span>
                  <span>{timeLeft}s</span>
                </div>
              </div>
            )}

            {/* Opponent progress line */}
            <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-white/55">
              {isSpin && !isFinished && !isCancelled ? (
                <span className="inline-flex items-center gap-1.5">
                  {opponentInputs?.boardLocked ? (
                    <span className="inline-flex items-center gap-1 text-fuchsia-300">
                      <CheckIcon className="w-3.5 h-3.5" />
                      Opponent board locked
                    </span>
                  ) : opponentStoppedCount > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
                      Opponent stopped {opponentStoppedCount}/3 reels
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
                      Waiting for opponent to stop…
                    </span>
                  )}
                </span>
              ) : (
                <span>{isFinished ? "Match complete" : "Waiting for match to start"}</span>
              )}
            </div>
            {match.viewerCanCancel && (
              <div className="mt-3 flex justify-center">
                <button
                  onClick={() => handleCancel()}
                  disabled={cancelling}
                  className={`px-4 py-2 rounded-xl text-xs font-bold ${
                    cancelling
                      ? "bg-white/10 text-white/40 cursor-not-allowed"
                      : "bg-red-500/20 text-red-200 border border-red-400/40 hover:bg-red-500/30"
                  }`}
                >
                  {cancelling ? "Cancelling…" : "Cancel lobby"}
                </button>
              </div>
            )}
            {error && (
              <div className="mt-3 mx-auto max-w-md rounded-xl border border-red-400/40 bg-red-900/30 p-3 text-sm text-red-200 flex items-center gap-2">
                <AlertIcon className="w-4 h-4 shrink-0 text-red-300" />
                {error}
              </div>
            )}
          </div>

          {/* Player 2 panel (right) */}
          <div className="order-3">
            <PlayerPanel
              seat="player2"
              displayName={p2Name}
              avatarUrl={p2Avatar}
              roundsWon={match.roundsWonPlayer2 || 0}
              points={match.p2Score || 0}
              isViewer={!isViewerP1}
              stoppedCount={!isViewerP1 ? viewerStoppedCount : opponentStoppedCount}
              boardLocked={
                !isViewerP1
                  ? Boolean(viewerInputs?.boardLocked)
                  : Boolean(opponentInputs?.boardLocked)
              }
              autoStopped={
                !isViewerP1
                  ? Boolean(viewerInputs?.autoStopped)
                  : Boolean(opponentInputs?.autoStopped)
              }
              isLive={isSpin && !isFinished && !isCancelled}
              isFinished={isFinished}
            />
          </div>
        </div>

        {/* Winner popup */}
        {isFinished && (
          <WinnerPopup
            match={match}
            user={user}
            onBack={() => router.push("/casino/slots-pvp")}
            p1Name={p1Name}
            p2Name={p2Name}
          />
        )}

        {/* Round result popup */}
        <AnimatePresence>
          {roundPopup && (
            <RoundPopup
              spinNumber={roundPopup.spinNumber}
              p1Name={p1Name}
              p2Name={p2Name}
              p1Score={roundPopup.p1Score}
              p2Score={roundPopup.p2Score}
              p1Lines={roundPopup.p1Lines}
              p2Lines={roundPopup.p2Lines}
              roundWinner={roundPopup.roundWinner}
              onNextRound={onNextRound}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Report modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentClerkId,
              gameType: "slots-pvp",
              gameId: String(matchId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponentName || "Opponent"}
        gameType="Slots Duel"
      />

      <Footer />
    </div>
  );
}
