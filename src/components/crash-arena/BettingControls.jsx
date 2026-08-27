"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  IconArrowUp,
  IconCircleCheck,
  IconClock,
  IconFlag,
  IconHandStop,
} from "@tabler/icons-react";

/**
 * BettingControls — Crash Poker betting panel shown while a checkpoint
 * window is open and the local player is still in the hand.
 *
 * Shows the current checkpoint multiplier, the required contribution, the
 * player's own commitment, and the three decisions:
 *
 *   FOLD  — give up the hand, losing only what was already contributed.
 *   CALL  — match the required bet (rendered as CHECK when already matched;
 *           rendered as ALL-IN when matching would commit the whole stack).
 *   RAISE — increase the required contribution for everyone still in, by a
 *           chosen amount (min +1 big blind). Presets and the input are
 *           capped at the player's stack; when the stack can't cover the
 *           minimum raise the panel offers an all-in shove instead.
 *
 * All decisions go through `onAction(action, raiseTo)` which posts to the
 * server-authoritative /api/crash-arena/action route — the server re-validates
 * everything and caps commitments at the real DB balance, so the numbers here
 * are purely presentational.
 *
 * Props:
 *   requiredBet       — total contribution needed to stay in (round state)
 *   contributed       — what "You" has already committed this hand
 *   bigBlind          — the table wager (raise unit)
 *   balance           — "You"'s remaining stack at the table (caps everything)
 *   checkpointLabel   — e.g. "1.50x" for the open window
 *   bettingOpen       — whether the window currently accepts actions
 *   waitingForCheckpoint — true while the shared curve hasn't reached the
 *                       next 0.25x checkpoint yet (actions are locked until
 *                       it does). Distinct from a resolved checkpoint.
 *   youActed           — "You" already decided at this checkpoint; a raise
 *                       by anyone re-opens action and clears this. While
 *                       true the buttons are locked and the panel says the
 *                       table is waiting.
 *   deadlineAt        — server-authoritative epoch-ms deadline for the open
 *                       window (stall guard). While the player owes an
 *                       action, a countdown shows; at 0 an unmatched player
 *                       auto-folds and a matched player auto-checks.
 *   disabled          — an API call is in flight
 *   onAction          — (action: "fold"|"call"|"raise", raiseTo?: number) => void
 */
export default function BettingControls({
  requiredBet = 0,
  contributed = 0,
  bigBlind = 2,
  balance = 0,
  checkpointLabel = "1.25x",
  bettingOpen = false,
  waitingForCheckpoint = false,
  youActed = false,
  deadlineAt = null,
  disabled = false,
  onAction,
}) {
  const callAmount = Math.max(0, Number(requiredBet) - Number(contributed));
  const isCheck = callAmount <= 0;
  // Highest total commitment the player can reach: what they've already
  // posted plus their whole remaining stack.
  const maxTotal = Number(contributed) + Math.max(0, Number(balance));
  const callIsAllIn = callAmount > 0 && callAmount >= maxTotal - Number.EPSILON;
  const minRaiseTo = Number(requiredBet) + Number(bigBlind);
  // When the stack can't cover the minimum raise, the only legal raise is
  // an all-in shove (the server accepts below-min raises as all-in).
  const canOnlyShove = maxTotal < minRaiseTo - Number.EPSILON;

  const [raiseTo, setRaiseTo] = useState(() =>
    Math.min(Number(requiredBet) + Number(bigBlind), maxTotal),
  );
  const [showRaise, setShowRaise] = useState(false);

  // Keep the raise preset in sync when the required bet moves.
  useEffect(() => {
    if (!showRaise) {
      setRaiseTo(Math.min(Number(requiredBet) + Number(bigBlind), maxTotal));
    }
  }, [requiredBet, bigBlind, maxTotal, showRaise]);

  const raiseValid =
    Number.isFinite(Number(raiseTo)) &&
    Number(raiseTo) >= minRaiseTo - Number.EPSILON &&
    Number(raiseTo) <= maxTotal + Number.EPSILON;

  // ── Stall-guard countdown: while the player still owes a decision and
  //    the server window is open, show how long they have left and submit
  //    it for them at 0 — FOLD when they owe a call, otherwise an implicit
  //    CHECK (call with 0 needed). The server is authoritative — this is
  //    purely UX (the server auto-resolves overdue players regardless).
  const owesCall = callAmount > 0;
  const owesAction = !youActed && bettingOpen;
  const autoActionSentRef = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState(null);
  useEffect(() => {
    if (!owesAction || deadlineAt == null || !Number.isFinite(Number(deadlineAt))) {
      setSecondsLeft(null);
      autoActionSentRef.current = false;
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((Number(deadlineAt) - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0 && !autoActionSentRef.current && !disabled) {
        autoActionSentRef.current = true;
        // Matched players auto-check; unmatched players auto-fold.
        onAction?.(owesCall ? "fold" : "call");
      }
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [owesAction, owesCall, deadlineAt, disabled, onAction]);

  const handleRaisePreset = useCallback((units) => {
    setRaiseTo(Math.min(Number(requiredBet) + Number(bigBlind) * units, maxTotal));
    setShowRaise(true);
  }, [requiredBet, bigBlind, maxTotal]);

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-[#FFD700]/30 bg-[#0a1a2e]/90 p-3 backdrop-blur-md shadow-[0_0_20px_rgba(255,215,0,0.15)]">
      {/* Window header */}
      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1.5 font-black uppercase tracking-wider text-[#FFD700]">
          <IconHandStop size={14} className="text-[#FFD700]" />
          {waitingForCheckpoint ? `Next betting at ${checkpointLabel}` : `Betting at ${checkpointLabel}`}
        </span>
        <span className="text-[#9dd8ff]/80">
          To stay in: <strong className="text-[#d8fbff]">${requiredBet.toLocaleString()}</strong>
          <span className="ml-1.5 text-[#9dd8ff]/60">
            · You: <strong className="text-[#00ffa6]">${contributed.toLocaleString()}</strong>
            <span className="ml-1.5 text-[#9dd8ff]/50">Stack: ${Math.max(0, Number(balance)).toLocaleString()}</span>
          </span>
        </span>
      </div>

      {!bettingOpen && waitingForCheckpoint && (
        <p className="text-[11px] text-[#9dd8ff]/70 animate-pulse">
          The rocket hasn&apos;t reached {checkpointLabel} yet — the action buttons unlock there. No decisions can be made between checkpoints.
        </p>
      )}
      {!bettingOpen && !waitingForCheckpoint && (
        <p className="text-[11px] text-[#9dd8ff]/60">
          Checkpoint resolved — betting re-opens for everyone if someone raises.
        </p>
      )}
      {/* You already decided at this checkpoint — waiting on the table */}
      {bettingOpen && youActed && (
        <p className="text-[11px] text-[#00ffa6]/80">
          You&apos;re set — waiting for the other players to act. A raise re-opens your decision.
        </p>
      )}

      {/* Stall-guard countdown while this player still owes a decision */}
      {owesAction && secondsLeft != null && (
        <p
          className={`text-[11px] font-bold ${
            secondsLeft <= 3 ? "text-red-400 animate-pulse" : "text-[#9dd8ff]/70"
          }`}
        >
          <IconClock size={12} className="mr-1 inline" />
          {owesCall
            ? `Auto-fold in ${secondsLeft}s if you don't act`
            : `Window closes in ${secondsLeft}s — check to stay in`}
        </p>
      )}

      {/* Decision buttons — hidden until the rocket actually hits the
          0.25x checkpoint (bettingOpen) AND the player still owes a
          decision (a raise by anyone re-opens action). */}
      {bettingOpen && !youActed && <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onAction?.("fold")}
          disabled={disabled || youActed}
          className="flex-1 min-w-[86px] px-3 py-2.5 rounded-xl text-sm font-black border border-red-500/40 bg-red-500/15 text-red-400 hover:bg-red-500/30 hover:shadow-[0_0_14px_rgba(239,68,68,0.4)] transition-all disabled:opacity-50 disabled:hover:shadow-none"
        >
          <IconFlag size={15} className="mr-1.5 inline" /> Fold
        </button>

        <button
          onClick={() => onAction?.("call")}
          disabled={disabled || youActed}
          className={`flex-1 min-w-[110px] px-3 py-2.5 rounded-xl text-sm font-black border transition-all disabled:opacity-50 disabled:hover:shadow-none ${
            callIsAllIn
              ? "border-[#ff4fd8]/50 bg-[#ff4fd8]/20 text-[#ff4fd8] hover:bg-[#ff4fd8]/35 hover:shadow-[0_0_14px_rgba(255,79,216,0.4)]"
              : "border-[#00ffa6]/40 bg-[#00ffa6]/15 text-[#00ffa6] hover:bg-[#00ffa6]/30 hover:shadow-[0_0_14px_rgba(0,255,166,0.4)]"
          }`}
        >
          <IconCircleCheck size={15} className="mr-1.5 inline" />
          {isCheck ? "Check" : callIsAllIn ? `All-in $${callAmount.toLocaleString()}` : `Call $${callAmount.toLocaleString()}`}
        </button>

        <button
          onClick={() => setShowRaise((v) => !v)}
          disabled={disabled || youActed}
          className={`px-3 py-2.5 rounded-xl text-sm font-black border transition-all disabled:opacity-50 ${
            showRaise
              ? "border-[#FFD700] bg-[#FFD700]/25 text-[#FFD700]"
              : "border-[#FFD700]/40 bg-[#FFD700]/10 text-[#FFD700] hover:bg-[#FFD700]/20"
          }`}
        >
          <IconArrowUp size={15} className="mr-1.5 inline" /> Raise
        </button>
      </div>}

      {/* Raise sub-panel */}
      {bettingOpen && !youActed && showRaise && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {canOnlyShove ? (
            // Stack can't cover the minimum raise — the only raise is an
            // all-in shove of everything left.
            <button
              onClick={() => onAction?.("raise", maxTotal)}
              disabled={disabled || youActed}
              className="flex-1 px-3 py-2 rounded-lg text-xs font-black border border-[#ff4fd8]/50 bg-[#ff4fd8]/20 text-[#ff4fd8] hover:bg-[#ff4fd8]/35 hover:shadow-[0_0_14px_rgba(255,79,216,0.4)] transition-all disabled:opacity-50 disabled:hover:shadow-none"
            >
              All-in ${Math.max(0, Number(balance)).toLocaleString()}
            </button>
          ) : (
            <>
              {[1, 2, 3].map((units) => (
                <button
                  key={units}
                  onClick={() => handleRaisePreset(units)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-bold border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-all"
                >
                  +{units}BB (${Math.min(Number(requiredBet) + Number(bigBlind) * units, maxTotal).toLocaleString()})
                </button>
              ))}
              <div className="flex items-center gap-1.5 ml-auto">
                <span className="text-[10px] text-[#9dd8ff]/70 uppercase">To</span>
                <span className="text-[#FFD700] font-bold">$</span>
                <input
                  type="number"
                  value={raiseTo}
                  min={minRaiseTo}
                  max={maxTotal}
                  step="0.01"
                  onChange={(e) => setRaiseTo(e.target.value)}
                  className="w-24 rounded-lg border border-[#FFD700]/40 bg-[#020617] px-2 py-1.5 text-sm font-bold text-[#FFD700] outline-none focus:border-[#FFD700]"
                />
                <button
                  onClick={() => onAction?.("raise", Number(raiseTo))}
                  disabled={disabled || youActed || !raiseValid}
                  className="px-3 py-1.5 rounded-lg text-xs font-black border border-[#FFD700]/50 bg-[#FFD700] text-black hover:brightness-110 transition-all disabled:opacity-40 disabled:hover:brightness-100"
                >
                  Raise to ${Number(raiseTo).toLocaleString()}
                </button>
              </div>
            </>
          )}
          {!raiseValid && !canOnlyShove && (
            <p className="text-[10px] text-red-400 w-full">
              Minimum raise is to ${minRaiseTo.toLocaleString()} (stack: ${Math.max(0, Number(balance)).toLocaleString()})
            </p>
          )}
        </div>
      )}
    </div>
  );
}
