"use client";
import React, { useEffect, useState } from "react";
import { playTick } from "../../lib/gameAudio";

/**
 * RoundTimer — countdown to the next round start.
 *
 * Two modes:
 *   • Relative: pass `seconds` — the classic local countdown (first round
 *     ready-vote flow).
 *   • Absolute: pass `deadlineAt` (server epoch-ms) — every client counts
 *     down to the SAME wall-clock moment the server scheduled (settled
 *     hands write next_round_at), so a desynced client can never fire the
 *     round early. The round starts exactly on schedule.
 *
 * Props:
 *   seconds    — seconds until next round (relative mode)
 *   deadlineAt — server epoch-ms deadline (absolute mode; wins over seconds)
 *   isRunning  — whether the countdown is active
 *   onExpire   — called when timer reaches 0
 *   label      — caption above the countdown (default "Next Round")
 */
export default function RoundTimer({ seconds = 30, deadlineAt = null, isRunning = false, onExpire, label = "Next Round" }) {
  const [remaining, setRemaining] = useState(() =>
    deadlineAt != null
      ? Math.max(0, Math.ceil((Number(deadlineAt) - Date.now()) / 1000))
      : seconds,
  );
  // Absolute mode fires onExpire exactly ONCE per deadline — the poll runs
  // every 250ms and must not spam the caller after expiry.
  const firedRef = React.useRef(false);

  // Absolute mode: poll the server deadline (sub-second so the expiry fires
  // within ~250ms of the scheduled moment).
  useEffect(() => {
    if (deadlineAt == null) return;
    firedRef.current = false;
    const tick = () => {
      const rem = Math.max(0, Math.ceil((Number(deadlineAt) - Date.now()) / 1000));
      setRemaining(rem);
      if (rem <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpire?.();
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadlineAt, onExpire]);

  // Relative mode: second-by-second countdown (kept for the first-round
  // ready-vote flow and any fallback).
  useEffect(() => {
    if (deadlineAt != null) return;
    setRemaining(seconds);
    firedRef.current = false;
  }, [seconds, deadlineAt]);

  // IMPORTANT: side effects (onExpire, playTick, clearInterval) must NOT
  // run inside the setRemaining updater — updater functions execute during
  // React's render phase, so calling onExpire there updates the parent
  // mid-render and throws "Cannot update a component while rendering a
  // different component". The interval only updates state; the expiry and
  // the tick sound fire from dedicated effects below.
  useEffect(() => {
    if (deadlineAt != null) return;
    if (!isRunning || remaining <= 0) return;
    const timer = setInterval(() => {
      setRemaining((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, remaining, deadlineAt]);

  // Fire onExpire exactly ONCE when the relative countdown reaches zero.
  // (Runs after commit, so updating the parent from here is legal.)
  useEffect(() => {
    if (deadlineAt != null) return;
    if (!isRunning || remaining > 0) return;
    if (firedRef.current) return;
    firedRef.current = true;
    onExpire?.();
  }, [isRunning, remaining, onExpire, deadlineAt]);

  // Audible tick each second of the relative countdown — but NOT on the
  // final second (remaining becomes 0), matching the old behavior.
  useEffect(() => {
    if (deadlineAt != null) return;
    if (!isRunning || remaining <= 0 || remaining >= seconds) return;
    playTick();
  }, [deadlineAt, isRunning, remaining, seconds]);

  const isUrgent = remaining <= 5 && remaining > 0;

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs uppercase tracking-widest text-[#9dd8ff]/70">{label}</span>
      <div
        className={`text-4xl font-black tabular-nums transition-all duration-300
          ${isRunning && isUrgent
            ? "text-red-400 animate-pulse drop-shadow-[0_0_15px_rgba(248,113,113,0.6)]"
            : "text-[#00e5ff] drop-shadow-[0_0_10px_rgba(0,229,255,0.4)]"
          }`}
      >
        {remaining > 0 ? `0:${String(remaining).padStart(2, "0")}` : "NOW"}
      </div>
    </div>
  );
}
