"use client";
import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  IconBomb,
  IconBook,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconFlag,
  IconHome,
  IconRocket,
  IconTrophy,
  IconUsers,
} from "@tabler/icons-react";
import PlayerList from "./PlayerList";
import PlayerSidebar from "./PlayerSidebar";
import IconAvatar from "../IconAvatar";
import PotDisplay from "./PotDisplay";
import TableBalance from "./TableBalance";
import RoundTimer from "./RoundTimer";
import RoundStatus from "./RoundStatus";
import BuyInModal from "./BuyInModal";
import RoundResultModal from "./RoundResultModal";
import CrashArenaRulesModal from "./CrashArenaRulesModal";
import BettingControls from "./BettingControls";
import CrashRiskMeter from "./CrashRiskMeter";
import { computePots } from "../../lib/crash-poker/roundSystem";
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
 *   onSubmitAction    — (action: "fold"|"call"|"raise", raiseTo?: number) => void
 *   currentMultiplier — live curve multiplier (drives the CRASH RISK meter;
 *                      shared across clients via the synchronized curve)
 *   activeCheckpointIndex — highest checkpoint the shared curve reached
 *                      (null = betting not open yet this window)
 *   checkpointMultiplierFor — (index) => multiplier of a checkpoint
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
  onSubmitAction,
  currentMultiplier = 1,
  activeCheckpointIndex = null,
  checkpointMultiplierFor = (i) => (125 + 25 * i) / 100,
  onJoin,
  onLeave,
  onExitToLobby,
  onBuyChips,
  onReportPlayer,
  // Private tables: the host adds / removes / renames AI seats (mirrors
  // the poker table AIs — the host who added them manages them).
  onAddAi,
  onRemoveAi,
  onRenameAi,
  // Invite code for PRIVATE tables — from the shared URL (?code=) or the
  // host's own table row. Players without it are prompted before joining.
  inviteCode = null,
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
  // Private host-created tables: hidden from the public grid; the host may
  // add AI seats (and only the host's client drives them).
  const isPrivate = Boolean(table?.isPrivate);
  const amIHost = Boolean(table?.amIHost);

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
  const youFolded = you?.folded || false;
  const youAllIn = you?.allIn || false;
  // All-in players are still in the hand (active) but can no longer act —
  // they're committed and just ride the curve.
  const youInHand = Boolean(you && you.isActive && !you.folded && !youBusted);
  // Checkpoint window shown to the player: the one the curve reached, else
  // the next one coming up.
  const windowIndex =
    activeCheckpointIndex != null
      ? activeCheckpointIndex
      : roundState.checkpointIndex >= 0
        ? roundState.checkpointIndex + 1
        : 0;
  const windowMultiplier = checkpointMultiplierFor(windowIndex);
  const canActNow = activeCheckpointIndex != null && youInHand;
  // Whether "You" has already made a decision at the open checkpoint (a
  // raise by anyone re-opens action and clears this).
  const youActedThisCheckpoint = Boolean(you?.actedThisCheckpoint);
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
  // Seated AI bots are effectively ALWAYS ready — they never cast a vote
  // (the host drives their actions), so counting them lets a host playing
  // only against AIs start the first round with their own ready vote
  // instead of being stuck forever at "1/2 ready".
  const seatedBotCount = players.filter((p) => p.isBot).length;
  const readyCount = readyVotes.length + seatedBotCount;
  const youReady = you?.userId != null && readyVotes.includes(you.userId);
  // Server-scheduled next-round deadline (epoch ms) — written when a hand
  // settles. Every client counts down to the SAME wall-clock moment, so
  // the round starts exactly on schedule for everyone (no per-client
  // drift that could start a hand before a slow client's countdown ends).
  const nextRoundAt =
    roundState?.nextRoundAt ?? table?.nextRoundAt ?? null;
  // Countdown runs once 2+ players are seated and (first round) 2+ are
  // ready. AI practice tables skip the ready-vote gate entirely — the
  // bot never votes, so the human + bot pair just count down. Later
  // rounds always have a server-scheduled nextRoundAt.
  const countdownActive =
    isWaiting &&
    !practiceStackEmpty &&
    seatedCount >= 2 &&
    (nextRoundAt != null || !isFirstRound || isAi || readyCount >= READY_VOTES_NEEDED);

  // ── Local UI state ──────────────────────────────────────────────────

  const [showBuyInModal, setShowBuyInModal] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [resultDismissed, setResultDismissed] = useState(false);
  // ── Add-AI modal (private tables, host only) ─────────────────────────
  const [showAddAi, setShowAddAi] = useState(false);
  const [aiDifficulty, setAiDifficulty] = useState("medium");
  const [aiStackInput, setAiStackInput] = useState("");
  const [addingAi, setAddingAi] = useState(false);
  const [addAiError, setAddAiError] = useState(null);
  // Optional custom name for the AI being added.
  const [aiNameInput, setAiNameInput] = useState("");
  // ── Invite-code prompt (private tables: joining requires the code) ───
  const [showJoinCodePrompt, setShowJoinCodePrompt] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [enteredInviteCode, setEnteredInviteCode] = useState(null);
  // The effective invite code: from the shared URL / host row, or the code
  // the player typed in the prompt.
  const effectiveInviteCode = inviteCode ?? enteredInviteCode;
  const [copiedInvite, setCopiedInvite] = useState(false);

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

  // ── Host AI management ───────────────────────────────────────────────
  // Only the host of a private table sees the controls; the server
  // re-validates host + private on every add/remove call.
  const canManageAi = isPrivate && amIHost;
  const handleRemoveAi = useCallback((player) => {
    if (!canManageAi || !player?.userId) return;
    if (!window.confirm(`Remove ${player.name || "this AI"} from the table?`)) return;
    onRemoveAi?.(player);
  }, [canManageAi, onRemoveAi]);

  const handleRenameAi = useCallback((player) => {
    if (!canManageAi || !player?.userId) return;
    const current = player.name && player.name !== "GRYND AI" ? player.name : "";
    const newName = window.prompt("Name this AI:", current);
    if (newName == null) return; // cancelled
    const trimmed = newName.trim();
    if (!trimmed) return;
    onRenameAi?.(player, trimmed);
  }, [canManageAi, onRenameAi]);

  // ── Side-pot tier breakdown for the pot display (running hands) ──────
  // Mirrors the server's tier accounting so players see the main pot and
  // each side pot (what an all-in short stack can actually win).
  const potTiers = useMemo(() => {
    if (phase !== "running") return [];
    return computePots(
      { players: roundState.players, carryOver: roundState.carryOver ?? 0 },
      roundState.carryOver ?? 0,
    );
  }, [phase, roundState.players, roundState.carryOver]);

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
          // After the first hand the server writes an absolute next-round
          // deadline — every client counts down to the same moment and the
          // round starts exactly on schedule (never before). The first
          // round (no deadline yet) uses the classic local ready-vote
          // countdown.
          nextRoundAt != null ? (
            <RoundTimer
              label="Next round in"
              deadlineAt={nextRoundAt}
              isRunning={true}
              onExpire={handleTimerExpire}
            />
          ) : (
            <RoundTimer
              label={isFirstRound ? "Starting in" : "Next round in"}
              seconds={ROUND_START_COUNTDOWN}
              isRunning={true}
              onExpire={handleTimerExpire}
            />
          )
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
          <CrashRiskMeter multiplier={currentMultiplier} />
        )}
        <PotDisplay pot={pot} pots={potTiers} />
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
                {results.wonByFold
                  ? `Latest fold before the crash at ${results.winnerMultiplier?.toFixed(2)}x`
                  : `Last player standing at ${results.winnerMultiplier?.toFixed(2)}x`}
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
            {isPrivate && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border border-amber-400/50 bg-amber-400/15 text-amber-300">
                Private
              </span>
            )}
            {/* The host sees the invite code + a copy-link button so they
                can invite friends (the code is the ONLY way others join). */}
            {isPrivate && amIHost && effectiveInviteCode && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border border-emerald-400/50 bg-emerald-400/15 text-emerald-300">
                Invite code: {effectiveInviteCode}
                <button
                  onClick={() => {
                    const link = `${window.location.origin}/casino/crash-arena/table/${table?.id}?code=${effectiveInviteCode}`;
                    navigator.clipboard?.writeText(link).then(() => {
                      setCopiedInvite(true);
                      setTimeout(() => setCopiedInvite(false), 2000);
                    }).catch(() => {});
                  }}
                  title="Copy invite link"
                  className="px-1.5 py-0.5 rounded-md text-[10px] font-black border border-emerald-400/40 bg-emerald-400/20 hover:bg-emerald-400/35 transition-all"
                >
                  {copiedInvite ? "✓ Copied" : "Copy link"}
                </button>
              </span>
            )}
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
            {/* Crash Poker blinds — the SB/BB rotate every hand */}
            {isRunning && roundState.smallBlind != null && roundState.bigBlind != null && (
              <span className="text-xs text-[#9dd8ff]/60">
                Blinds:{" "}
                <span className="text-[#d8fbff] font-bold">
                  ${Number(roundState.smallBlind).toLocaleString()} / ${Number(roundState.bigBlind).toLocaleString()}
                </span>
              </span>
            )}
            {isCrashed && crashMultiplier != null && (
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
              onClick={() => {
                // Private tables are invite-only: without a code (from the
                // shared URL or a previously entered one) the player is
                // prompted before the buy-in.
                if (isPrivate && !effectiveInviteCode) {
                  setJoinCodeInput("");
                  setShowJoinCodePrompt(true);
                } else {
                  setShowBuyInModal(true);
                }
              }}
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

              {/* Private tables (host only): add an AI seat — mirrors the
                  poker table AIs. Every click seats a NEW bot (up to
                  capacity); bots join as seated players and the host's
                  client drives their fold/call/raise decisions. Remove
                  buttons sit on each bot card in the player list. */}
              {canManageAi && !isFull && (
                <button
                  onClick={() => {
                    setAddAiError(null);
                    setShowAddAi(true);
                  }}
                  className="px-3 py-2 rounded-lg text-xs font-bold border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 text-[#ff4fd8] hover:bg-[#ff4fd8]/20 transition-all"
                >
                  + Add AI
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

              {/* Folded / busted / all-in status badges during the hand */}
              {youAllIn && (
                <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-[#ff4fd8]/15 text-[#ff4fd8] border border-[#ff4fd8]/40">
                  All-in
                </span>
              )}
              {youFolded && (
                <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/30">
                  <IconFlag size={14} /> Folded
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

      {/* ═══ Crash Poker betting panel — placed at the TOP of the game
          board so the action buttons are always visible while the hand
          runs (fold / call / raise at every 0.25x checkpoint). Shown
          while the local player is still in the hand AND can still act
          (all-in players are committed and ride the curve). The buttons
          themselves stay hidden until the curve reaches the checkpoint. ═══ */}
      {isRunning && youInHand && !youAllIn && (
        <BettingControls
          requiredBet={roundState.requiredBet || 0}
          contributed={you?.contributed || 0}
          bigBlind={roundState.bigBlind || wager || 2}
          balance={playerChips}
          checkpointLabel={`${windowMultiplier.toFixed(2)}x`}
          bettingOpen={canActNow}
          // True while the shared curve hasn't reached the target
          // checkpoint yet (the hand-start climb to 1.25x, or the climb
          // between resolved checkpoints while this player hasn't decided
          // at the upcoming one) — the buttons stay hidden until it does.
          waitingForCheckpoint={
            activeCheckpointIndex == null && !youActedThisCheckpoint
          }
          youActed={youActedThisCheckpoint}
          deadlineAt={roundState.windowDeadlineAt ?? null}
          disabled={busy || !canActNow}
          onAction={(action, raiseTo) => onSubmitAction?.(action, raiseTo)}
        />
      )}

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

        {/* Live betting/status overlay during running — shows on top of CrashEngine */}
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

      {/* ═══ Your status while the hand runs but you can't act ═══ */}
      {isRunning && youAllIn && youInHand && (
        <div className="px-4 py-2 rounded-xl border border-[#ff4fd8]/40 bg-[#ff4fd8]/10 text-[#ff4fd8] text-sm font-bold text-center">
          You&apos;re all-in — committed and riding the curve. Good luck!
        </div>
      )}
      {isRunning && you && !youInHand && (youFolded || youBusted) && (
        <div
          className={`px-4 py-2 rounded-xl border text-sm font-bold text-center ${
            youFolded
              ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
              : "border-red-500/30 bg-red-500/10 text-red-400"
          }`}
        >
          {youFolded ? `You folded — out of this hand.` : `You busted — the crash got you.`}
        </div>
      )}

      {/* ═══ Player list + wait list ═══ */}
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 px-4 py-3 rounded-2xl border border-[#ff4fd8]/25 bg-[#040d24]/60 backdrop-blur-sm">
          <h3 className="text-xs uppercase tracking-wider text-[#ff4fd8]/70 mb-3 text-center">
            Players &bull; {seatedCount}/{maxPlayers}
          </h3>
          <PlayerList
            players={players}
            maxSeats={maxPlayers}
            phase={phase}
            onReport={onReportPlayer}
            // Host-only controls for AI seats (bots carry isBot + userId
            // from the server roster).
            onRemoveAi={canManageAi ? handleRemoveAi : undefined}
            onRenameAi={canManageAi ? handleRenameAi : undefined}
          />
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
                    className={`w-6 h-6 rounded-full overflow-hidden border shrink-0 ${
                      p.isYou ? "border-[#FFD700]" : "border-yellow-500/30"
                    }`}
                  >
                    <IconAvatar
                      iconKey={p.iconKey}
                      name={p.name}
                      size="h-full w-full"
                      showFrame={false}
                    />
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
          onBuyIn={async (amount) => {
            if (isSeated) {
              onBuyChips?.(amount);
            } else {
              // Private tables: the invite code travels with the join so
              // the server can validate it.
              const ok = await onJoin?.(amount, effectiveInviteCode);
              // The code was wrong (or the join was rejected) — clear the
              // typed code so the invite prompt shows again on retry.
              if (ok === false && isPrivate && enteredInviteCode) {
                setEnteredInviteCode(null);
              }
            }
            setShowBuyInModal(false);
          }}
          onClose={() => setShowBuyInModal(false)}
        />
      )}

      {/* ═══ Invite-code prompt (private tables) ═══ */}
      {showJoinCodePrompt && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
          <div className="relative w-full max-w-sm rounded-2xl border border-[#00e5ff]/40 bg-[#0a1a2e] p-6 shadow-[0_0_30px_rgba(0,229,255,0.2)]">
            <h2 className="text-xl font-black text-[#d8fbff] mb-1">Private Table</h2>
            <p className="text-sm text-[#9dd8ff]/70 mb-4">
              This game is invite-only. Enter the invite code the host shared
              to join it.
            </p>
            <input
              type="text"
              value={joinCodeInput}
              onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
              placeholder="e.g. K7PM2A"
              autoFocus
              className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#020617] px-3 py-2.5 text-sm font-bold uppercase tracking-widest text-[#d8fbff] outline-none focus:border-[#00e5ff] mb-4"
              onKeyDown={(e) => {
                if (e.key === "Enter" && joinCodeInput.trim()) {
                  setEnteredInviteCode(joinCodeInput.trim().toUpperCase());
                  setShowJoinCodePrompt(false);
                  setShowBuyInModal(true);
                }
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowJoinCodePrompt(false)}
                className="flex-1 rounded-lg border border-gray-600/50 bg-gray-800/40 px-4 py-2 text-sm font-bold text-gray-300 hover:bg-gray-800/70 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!joinCodeInput.trim()) return;
                  setEnteredInviteCode(joinCodeInput.trim().toUpperCase());
                  setShowJoinCodePrompt(false);
                  setShowBuyInModal(true);
                }}
                disabled={!joinCodeInput.trim()}
                className="flex-1 rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/20 px-4 py-2 text-sm font-black text-[#00e5ff] hover:bg-[#00e5ff]/35 disabled:opacity-50 transition-all"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Rules popup ═══ */}
      {showRules && <CrashArenaRulesModal onClose={() => setShowRules(false)} />}

      {/* ═══ Add-AI popup (private tables, host only) ═══ */}
      {showAddAi && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
          <div className="relative w-full max-w-sm rounded-2xl border border-[#ff4fd8]/40 bg-[#0a1a2e] p-6 shadow-[0_0_30px_rgba(255,79,216,0.2)]">
            <h2 className="text-xl font-black text-[#d8fbff] mb-1">Add AI Player</h2>
            <p className="text-sm text-[#9dd8ff]/70 mb-4">
              Seat a GRYND AI bot at this private table. Its fold/call/raise
              decisions follow the difficulty you pick.
            </p>

            {/* Optional custom name */}
            <label className="block text-xs uppercase tracking-wider text-[#9dd8ff]/60 mb-1">
              AI Name (optional)
            </label>
            <input
              type="text"
              value={aiNameInput}
              onChange={(e) => setAiNameInput(e.target.value.slice(0, 40))}
              placeholder="GRYND AI"
              className="w-full rounded-lg border border-[#ff4fd8]/30 bg-[#020617] px-3 py-2 text-sm font-bold text-[#d8fbff] outline-none focus:border-[#ff4fd8] mb-4"
            />

            {/* Difficulty picker */}
            <label className="block text-xs uppercase tracking-wider text-[#9dd8ff]/60 mb-1">
              AI Difficulty
            </label>
            <div className="flex gap-1.5 mb-4">
              {["easy", "medium", "hard"].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setAiDifficulty(d)}
                  className={`flex-1 rounded-full border px-3 py-1.5 text-xs font-bold capitalize transition-all duration-200 ${
                    aiDifficulty === d
                      ? "border-[#ff4fd8] bg-[#ff4fd8]/20 text-[#ff4fd8] shadow-[0_0_10px_rgba(255,79,216,0.35)]"
                      : "border-gray-600/50 bg-gray-800/40 text-gray-400 hover:border-[#ff4fd8]/60 hover:text-[#ff4fd8]/80"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>

            {/* Optional stack override (defaults to 20× the wager) */}
            <label className="block text-xs uppercase tracking-wider text-[#9dd8ff]/60 mb-1">
              Stack (optional)
            </label>
            <input
              type="number"
              value={aiStackInput}
              onChange={(e) => setAiStackInput(e.target.value)}
              min={minBuyIn}
              step="0.01"
              placeholder={`Default: $${(Number(wager || 0) * 20).toLocaleString()}`}
              className="w-full rounded-lg border border-[#ff4fd8]/30 bg-[#020617] px-3 py-2 text-sm font-bold text-[#d8fbff] outline-none focus:border-[#ff4fd8] mb-4"
            />

            {addAiError && (
              <p className="text-xs text-red-400 mb-3">{addAiError}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setShowAddAi(false)}
                className="flex-1 rounded-lg border border-gray-600/50 bg-gray-800/40 px-4 py-2 text-sm font-bold text-gray-300 hover:bg-gray-800/70 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setAddingAi(true);
                  setAddAiError(null);
                  try {
                    const stack = aiStackInput !== "" ? Number(aiStackInput) : undefined;
                    const name = aiNameInput.trim() ? aiNameInput.trim() : undefined;
                    const ok = await onAddAi?.(aiDifficulty, stack, name);
                    if (ok === false) {
                      setAddAiError("Couldn't add the AI — the table may be full.");
                    } else {
                      setShowAddAi(false);
                    }
                  } catch (err) {
                    setAddAiError(err?.message || "Failed to add AI");
                  } finally {
                    setAddingAi(false);
                  }
                }}
                disabled={addingAi}
                className="flex-1 rounded-lg border border-[#ff4fd8]/50 bg-[#ff4fd8]/20 px-4 py-2 text-sm font-black text-[#ff4fd8] hover:bg-[#ff4fd8]/35 disabled:opacity-50 transition-all"
              >
                {addingAi ? "Adding…" : "Add AI"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
