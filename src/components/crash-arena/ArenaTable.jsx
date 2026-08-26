"use client";
import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  IconBomb,
  IconBook,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconHome,
  IconRocket,
  IconTrophy,
  IconUsers,
} from "@tabler/icons-react";
import PlayerList from "./PlayerList";
import PlayerSidebar from "./PlayerSidebar";
import PotDisplay from "./PotDisplay";
import TableBalance from "./TableBalance";
import RoundTimer from "./RoundTimer";
import RoundStatus from "./RoundStatus";
import BuyInModal from "./BuyInModal";
import RoundResultModal from "./RoundResultModal";
import CrashArenaRulesModal from "./CrashArenaRulesModal";
import CashoutButton from "../games/crash-engine/CashoutButton";
import { playCrash, playVictory, playDefeat } from "../../lib/gameAudio";

const ROUND_START_COUNTDOWN = 12; // seconds between rounds / after ready votes
const READY_VOTES_NEEDED = 2;

/**
 * ArenaTable — full poker-style Crash Arena table room.
 *
 * Driven by roundState from useCrashArenaRound.
 *
 * Round-start flow:
 *   • First round (no round played yet): seated players press "Start Round"
 *     (a ready vote). When 2+ players are ready a countdown begins and the
 *     round starts automatically — the button only ever starts the timer.
 *   • Later rounds: no button — the countdown runs automatically and starts
 *     the next round for everyone at the same time.
 *
 * Props:
 *   table             — base table info (name, wager, minBuyIn, maxBuyIn, maxPlayers, latestRound)
 *   roundState        — { phase, pot, crashPoint, roundNumber, players, waitingPlayers, results }
 *   crashEngineRef    — ref to CrashEngine for cashout()
 *   readyVotes        — array of user ids who pressed Start Round
 *   markReady         — () => void
 *   onStartRound      — () => void (called when the countdown expires)
 *   onNextRound       — () => void
 *   onJoin            — (buyInAmount) => void
 *   onLeave           — () => void (→ wait list)
 *   onExitToLobby     — () => void (permanent leave → lobby)
 *   onBuyChips        — (amount) => void
 *   onReportPlayer    — (player) => void — opens the report modal for an opponent
 *   playerName        — "You"
 *   maxBalance        — player's wallet balance (caps buy-in amount)
 *   busy              — whether an API call is in flight
 *   children          — CrashEngine
 */
export default function ArenaTable({
  table,
  roundState,
  crashEngineRef,
  readyVotes = [],
  markReady,
  onStartRound,
  onNextRound,
  onJoin,
  onLeave,
  onExitToLobby,
  onBuyChips,
  onReportPlayer,
  playerName = "You",
  maxBalance = null,
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
  // Free practice table (human vs the GRYND AI bot). Chips are virtual.
  const isAi = Boolean(table?.isAi);

  const {
    phase = "waiting",
    pot = 0,
    roundNumber = 1,
    players = [],
    waitingPlayers = [],
    results = null,
    crashMultiplier = null,
    crashPoint = null,
  } = roundState;

  // ── Derived state ───────────────────────────────────────────────────

  const you = players.find((p) => p.isYou) || null;
  const youWaiting = waitingPlayers.find((p) => p.isYou) || null;
  const isSeated = !!you;
  const isWaitingPlayer = !!youWaiting;
  const playerChips = you?.balance || 0;
  const isFull = players.length >= maxPlayers;
  const youCashedOut = you?.cashoutMultiplier != null;
  const youBusted = you?.busted || false;
  // The practice stack is virtual — once it drops below the wager the
  // round can't start; the player should head back to the lobby.
  const practiceStackEmpty = isAi && isSeated && playerChips < (wager || 0);

  const isRunning = phase === "running";
  const isCrashed = phase === "crashed" || phase === "settling";
  const isWaiting = phase === "waiting";

  // First round = round 1 AND the table has never hosted a round.
  const hasAnyRound = Boolean(table?.latestRound?.id);
  const isFirstRound = roundNumber === 1 && !hasAnyRound;

  const seatedCount = players.length;
  const readyCount = readyVotes.length;
  const youReady = you?.userId != null && readyVotes.includes(you.userId);
  // Countdown runs once 2+ players are seated and (first round) 2+ are
  // ready. AI practice tables skip the ready-vote gate entirely — the
  // bot never votes, so the human + bot pair just count down.
  const countdownActive =
    isWaiting &&
    !practiceStackEmpty &&
    seatedCount >= 2 &&
    (!isFirstRound || isAi || readyCount >= READY_VOTES_NEEDED);

  // ── Local UI state ──────────────────────────────────────────────────

  const [showBuyInModal, setShowBuyInModal] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [resultDismissed, setResultDismissed] = useState(false);

  // Reset the results-popup dismissal flag whenever we leave settling.
  useEffect(() => {
    if (phase !== "settling") setResultDismissed(false);
  }, [phase]);

  // Map phase to RoundStatus display
  const displayStatus = isRunning ? "flying" : isCrashed ? "crashed" : "waiting";

  const handleTimerExpire = useCallback(() => {
    onStartRound?.();
  }, [onStartRound]);

  const handleNextRound = useCallback(() => {
    setResultDismissed(true);
    onNextRound?.();
  }, [onNextRound]);

  // ── Live cashout feed (during running) ───────────────────────────────

  const liveCashouts = useMemo(() => {
    if (!isRunning) return [];
    return players
      .filter((p) => p.isPlaying && !p.isSittingOut && (p.cashoutMultiplier != null || p.busted))
      .sort((a, b) => (b.cashoutMultiplier || 0) - (a.cashoutMultiplier || 0));
  }, [players, isRunning]);

  const showResultModal = phase === "settling" && results && !resultDismissed && !!you;

  // ── Round audio ────────────────────────────────────────────────────
  // One shot per round settle: crash sweep, then victory if the local
  // player won the pot, defeat if they were still in and busted.
  const resultSoundPlayedRef = useRef(false);
  useEffect(() => {
    if (phase !== "settling") {
      resultSoundPlayedRef.current = false;
      return;
    }
    if (resultSoundPlayedRef.current) return;
    if (!results) return;
    resultSoundPlayedRef.current = true;
    playCrash();
    if (results.winner === playerName) {
      // Won the pot — victory after the crash sweep settles.
      setTimeout(() => playVictory(), 350);
    } else if (you && you.busted) {
      // Still in the round when it crashed → lost the wager.
      setTimeout(() => playDefeat(), 350);
    }
    // Cashout-but-lost-the-pot and spectators just hear the crash.
  }, [phase, results, you, playerName]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      {/* ═══ Top bar: status + timer + pot ═══ */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/60 backdrop-blur-sm">
        <RoundStatus
          status={displayStatus}
          roundNumber={roundNumber}
          crashedAt={crashMultiplier}
        />
        {isWaiting && countdownActive && (
          <RoundTimer
            label={isFirstRound ? "Starting in" : "Next round in"}
            seconds={ROUND_START_COUNTDOWN}
            isRunning={true}
            onExpire={handleTimerExpire}
          />
        )}
        {isWaiting && !countdownActive && (
          <div className="px-3 py-1.5 rounded-lg bg-[#9dd8ff]/5 border border-[#9dd8ff]/15 text-xs font-bold text-[#9dd8ff]">
            {practiceStackEmpty
              ? "Practice stack empty — leave and start a new practice session"
              : seatedCount < 2
                ? "Waiting for another player…"
                : isFirstRound
                  ? `${readyCount}/${READY_VOTES_NEEDED} ready. Press Start Round`
                  : "Waiting…"}
          </div>
        )}
        {isRunning && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#00e5ff]/10 border border-[#00e5ff]/20">
            <span className="text-xs text-[#9dd8ff]">Crash at</span>
            <span className="text-sm font-black text-[#00e5ff]">{crashPoint?.toFixed(2)}x</span>
          </div>
        )}
        <PotDisplay pot={pot} />
        {/* Rules popup button — always available during play */}
        <button
          onClick={() => setShowRules(true)}
          className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[#FFD700]/35 bg-[#FFD700]/10 text-[#FFD700] hover:bg-[#FFD700]/20 hover:shadow-[0_0_12px_rgba(255,215,0,0.3)] transition-all"
        >
          <IconBook size={14} className="mr-1.5" /> Rules
        </button>
        {/* Players sidebar toggle */}
        <button
          onClick={() => setShowSidebar((v) => !v)}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
            showSidebar
              ? "border-[#ff4fd8]/40 bg-[#ff4fd8]/15 text-[#ff4fd8]"
              : "border-gray-500/30 bg-gray-500/10 text-gray-400 hover:bg-gray-500/20"
          }`}
        >
          <IconUsers size={14} className="mr-1.5" /> Players{" "}
          {showSidebar ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
        </button>
      </div>

      {/* ═══ Round results (spectators / wait-listed players see banner) ═══ */}
      {phase === "settling" && results && !you && (
        <div className="px-4 py-3 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/5 text-center animate-in fade-in">
          {results.winner ? (
            <>
              <span className="inline-flex items-center gap-2 text-lg font-black text-[#FFD700]">
                <IconTrophy size={20} /> {results.winner} wins the pot!
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
              <span className="inline-flex items-center gap-2 text-lg font-black text-red-400">
                <IconBomb size={20} /> No winners! Pot carries over.
              </span>
              <span className="block text-sm text-[#9dd8ff] mt-1">
                ${pot.toLocaleString()} added to next round
              </span>
            </>
          )}
        </div>
      )}

      {/* ═══ Table info bar ═══ */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4">
        <div>
          <span className="text-xs text-[#9dd8ff]/60 uppercase tracking-wider">Table</span>
          <div className="flex items-center gap-2">
            <span className="text-lg font-black text-[#FFD700]">{name}</span>
            {isAi && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border border-[#00e5ff]/40 bg-[#00e5ff]/15 text-[#00e5ff]">
                AI Practice{/* Difficulty picked in the lobby (defaults to
                    medium for pre-difficulty practice tables). */}
                {table?.aiDifficulty ? ` · ${table.aiDifficulty}` : " · medium"}
              </span>
            )}
          </div>
          {isAi && (
            <p className="text-[11px] text-[#00e5ff]/80 mt-0.5">
              Free practice vs the GRYND AI bot — no real tokens wagered.
            </p>
          )}
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

          {/* On the wait list (joined mid-round or clicked Leave) */}
          {isWaitingPlayer && !isSeated && (
            <>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-yellow-500/30 bg-yellow-500/10 text-yellow-400">
                <IconClock size={13} /> On wait list. You&apos;ll join after this round
              </span>
              <button
                onClick={onExitToLobby}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
              >
                <IconHome size={14} className="mr-1.5" /> Back to Lobby
              </button>
            </>
          )}

          {/* Not seated */}
          {!isSeated && !isWaitingPlayer && isAi && (
            <button
              onClick={onExitToLobby}
              className="px-4 py-2 rounded-xl text-sm font-bold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
            >
              Back to Lobby
            </button>
          )}
          {!isSeated && !isWaitingPlayer && !isAi && !isFull && (
            <button
              onClick={() => setShowBuyInModal(true)}
              className="px-4 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-[#00e5ff] to-[#007cf0] text-white border border-[#00e5ff] shadow-[0_0_14px_rgba(0,229,255,0.4)] hover:shadow-[0_0_24px_rgba(0,229,255,0.7)] hover:scale-105 transition-all duration-300"
            >
              Join Table
            </button>
          )}
          {!isSeated && !isWaitingPlayer && !isAi && isFull && (
            <span className="px-3 py-1.5 rounded-lg text-xs font-bold border border-red-500/30 bg-red-500/10 text-red-400">
              Table Full
            </span>
          )}

          {/* Seated */}
          {isSeated && (
            <>
              {/* Buy chips (only in waiting, real tables only) — practice
                  stacks are virtual and can't be topped up. */}
              {isWaiting && !isAi && (
                <button
                  onClick={() => setShowBuyInModal(true)}
                  className="px-3 py-2 rounded-lg text-xs font-bold border border-[#00ffa6]/30 bg-[#00ffa6]/10 text-[#00ffa6] hover:bg-[#00ffa6]/20 transition-all"
                >
                  + Buy Chips
                </button>
              )}

              {/* First round: Start Round = ready vote. Starts the countdown
                  only — never the rocket directly. Skipped on AI practice
                  tables, where the human + bot pair auto-counts down. */}
              {isFirstRound && isWaiting && !isAi && (
                youReady ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-[#00ffa6]/40 bg-[#00ffa6]/15 text-[#00ffa6]">
                    <IconCircleCheck size={14} /> Ready ({readyCount}/{READY_VOTES_NEEDED})
                  </span>
                ) : (
                  <button
                    onClick={markReady}
                    disabled={busy || you?.userId == null}
                    title={you?.userId == null ? "Syncing your seat…" : "Vote to start the countdown"}
                    className="px-4 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-black border border-[#FFD700] shadow-[0_0_14px_rgba(255,215,0,0.4)] hover:shadow-[0_0_24px_rgba(255,215,0,0.7)] hover:scale-105 transition-all duration-300 disabled:opacity-50 disabled:hover:scale-100"
                  >
                    <IconRocket size={16} className="mr-1.5" /> Start Round
                  </button>
                )
              )}

              {/* Cashout button during running */}
              {isRunning && !youCashedOut && !youBusted && (
                <CashoutButton
                  onCashout={() => crashEngineRef?.current?.cashout()}
                />
              )}

              {/* Cashout status badges */}
              {youCashedOut && !isRunning && (
                <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-[#00ffa6]/15 text-[#00ffa6] border border-[#00ffa6]/30">
                  <IconCircleCheck size={14} /> {you.cashoutMultiplier?.toFixed(2)}x
                </span>
              )}
              {youBusted && (
                <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                  <IconBomb size={14} /> Busted
                </span>
              )}

              {/* Leave → steps off onto the wait list (balance kept). The
                  wait-list state then exposes the real "Back to Lobby"
                  (permanent leave + refund) — the ONLY in-page way out that
                  releases the seat server-side. Hidden on AI practice
                  tables, where "Back to Lobby" ends the session. */}
              {isWaiting && !isAi && (
                <button
                  onClick={onLeave}
                  className="px-3 py-2 rounded-lg text-xs font-bold border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 transition-all"
                >
                  Leave
                </button>
              )}

              {/* AI practice tables: "Back to Lobby" ends the session
                  (virtual chips are never refunded). */}
              {isWaiting && isAi && (
                <button
                  onClick={onExitToLobby}
                  className="px-3 py-2 rounded-lg text-xs font-bold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
                >
                  <IconHome size={14} className="mr-1.5" /> Back to Lobby
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ═══ Game area — centered, square-ish 4:3 canvas + side panel ═══ */}
      <div className="flex flex-col items-center gap-4 lg:flex-row lg:items-start lg:justify-center">
        {/* Main game canvas — hosts CrashEngine. The 4:3 ratio matches
            CrashGraph's internal 800×600 coordinate space, so the canvas
            scales uniformly and stays centered on every screen size. */}
        <div className="relative mx-auto flex w-full max-w-[720px] aspect-[4/3] items-center justify-center rounded-2xl border border-[#00e5ff]/30 bg-[#050d1f]/80 backdrop-blur-xl shadow-[0_0_25px_rgba(0,229,255,0.2)] overflow-hidden">
          {children || (
            <div className="text-center px-4">
              <IconRocket size={56} className="mb-4 text-[#00e5ff]" />
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
                  {p.name}{p.isYou ? " (You)" : ""}: {p.busted ? "Busted" : `${p.cashoutMultiplier?.toFixed(2)}x`}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Toggleable poker-style players sidebar */}
        {showSidebar && (
          <PlayerSidebar
            players={players}
            waitingPlayers={waitingPlayers}
            phase={phase}
            maxPlayers={maxPlayers}
            onExitToLobby={onExitToLobby}
          />
        )}
      </div>

      {/* ═══ Player list + wait list ═══ */}
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 px-4 py-3 rounded-2xl border border-[#ff4fd8]/25 bg-[#040d24]/60 backdrop-blur-sm">
          <h3 className="text-xs uppercase tracking-wider text-[#ff4fd8]/70 mb-3 text-center">
            Players &bull; {seatedCount}/{maxPlayers}
          </h3>
          <PlayerList players={players} maxSeats={maxPlayers} phase={phase} onReport={onReportPlayer} />
        </div>

        {waitingPlayers.length > 0 && (
          <div className="w-full lg:w-72 shrink-0 px-4 py-3 rounded-2xl border border-yellow-500/25 bg-[#040d24]/60 backdrop-blur-sm">
            <h3 className="text-xs uppercase tracking-wider text-yellow-400/70 mb-3 text-center">
              <IconClock size={13} className="mb-0.5 mr-1.5 inline" /> Wait List &bull; {waitingPlayers.length}
            </h3>
            <div className="flex flex-col gap-2">
              {waitingPlayers.map((p) => (
                <div
                  key={p.userId ?? p.name}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-xs"
                >
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black border shrink-0 ${
                      p.isYou
                        ? "bg-[#FFD700]/25 border-[#FFD700] text-[#FFD700]"
                        : "bg-[#020617] border-yellow-500/30 text-yellow-400"
                    }`}
                  >
                    {p.name?.charAt(0)?.toUpperCase() || "?"}
                  </span>
                  <span className={`truncate font-semibold flex-1 ${p.isYou ? "text-[#FFD700]" : "text-[#d8fbff]"}`}>
                    {p.name}
                    {p.isYou ? " (You)" : ""}
                  </span>
                  <span className="text-[#00ffa6] font-bold tabular-nums shrink-0">
                    ${p.balance?.toLocaleString() || 0}
                  </span>
                  {p.isYou ? (
                    <button
                      onClick={onExitToLobby}
                      className="px-2 py-1 rounded-md text-[10px] font-bold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all shrink-0"
                    >
                      <IconHome size={13} className="mr-1.5" /> Back to Lobby
                    </button>
                  ) : (
                    <IconClock size={14} className="shrink-0 text-yellow-400" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ═══ Round results popup ═══ */}
      {showResultModal && (
        <RoundResultModal
          roundNumber={roundNumber}
          results={results}
          you={you}
          wager={wager}
          pot={pot}
          onNextRound={handleNextRound}
        />
      )}

      {/* ═══ Buy-in modal ═══ */}
      {showBuyInModal && (
        <BuyInModal
          table={{ wager, minBuyIn, maxBuyIn }}
          maxBalance={maxBalance}
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

      {/* ═══ Rules popup ═══ */}
      {showRules && <CrashArenaRulesModal onClose={() => setShowRules(false)} />}
    </div>
  );
}
