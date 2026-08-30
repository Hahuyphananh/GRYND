"use client";

// src/components/SessionGuard.jsx
//
// Responsible-play break reminder (soft — never blocks).
//
// Tracks a "session" from the first lobby visit and, after
// SESSION_REMINDER_INTERVAL_MS of continuous play, shows a "take a break"
// reminder. The reminder repeats every interval as long as the player keeps
// playing, but each one is a single dismiss.
//
// Session semantics:
//   * session start persists in localStorage, so navigating between lobbies
//     and games keeps the clock running;
//   * leaving the tab for > IDLE_RESET_MS resets the clock (that was a
//     break);
//   * a start older than STALE_SESSION_MS is treated as a fresh session
//     (closed the app, came back next day).

import { useEffect, useState, useCallback } from "react";
import { IconClock, IconX } from "@tabler/icons-react";

/** Remind every 60 minutes of continuous play. */
const SESSION_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
/** Away from the tab longer than this → the clock resets (real break). */
const IDLE_RESET_MS = 15 * 60 * 1000;
/** A stored start older than this is a stale session (new day / reload). */
const STALE_SESSION_MS = 12 * 60 * 60 * 1000;

const START_KEY = "session-guard:started-at";
const NEXT_KEY = "session-guard:next-reminder-at";

function readNum(key) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeNum(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage unavailable — reminders still work for this page visit
  }
}

function minutesLabel(ms) {
  const mins = Math.max(1, Math.floor(ms / 60000));
  return mins;
}

export default function SessionGuard() {
  const [showReminder, setShowReminder] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState(60);

  useEffect(() => {
    const now = Date.now();
    let start = readNum(START_KEY);
    if (!start || now - start > STALE_SESSION_MS) {
      start = now;
      writeNum(START_KEY, start);
      writeNum(NEXT_KEY, start + SESSION_REMINDER_INTERVAL_MS);
    }

    let nextReminder = readNum(NEXT_KEY) ?? start + SESSION_REMINDER_INTERVAL_MS;
    let lastActive = now;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const t = Date.now();
      lastActive = t;
      if (t >= nextReminder) {
        setElapsedLabel(minutesLabel(t - start));
        setShowReminder(true);
      }
    };

    const onVisibility = () => {
      if (cancelled) return;
      const t = Date.now();
      // Coming back after a real break → start a fresh session.
      if (document.visibilityState === "visible" && t - lastActive > IDLE_RESET_MS) {
        start = t;
        nextReminder = t + SESSION_REMINDER_INTERVAL_MS;
        writeNum(START_KEY, start);
        writeNum(NEXT_KEY, nextReminder);
        setShowReminder(false);
      }
      lastActive = t;
    };

    document.addEventListener("visibilitychange", onVisibility);
    const interval = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, []);

  const dismiss = useCallback(() => {
    const next = Date.now() + SESSION_REMINDER_INTERVAL_MS;
    writeNum(NEXT_KEY, next);
    setShowReminder(false);
  }, []);

  if (!showReminder) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Break reminder"
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border-2 border-cyan-400/50 bg-gradient-to-b from-[#041a2e] to-[#040d24] p-6 shadow-[0_0_60px_rgba(0,229,255,0.2)]">
        <div className="absolute left-0 top-0 h-[2px] w-full bg-gradient-to-r from-transparent via-cyan-400 to-transparent" />
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss reminder"
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-gray-600/40 text-gray-400 transition hover:border-cyan-400/60 hover:text-white"
        >
          <IconX size={15} />
        </button>

        <div className="flex items-center gap-2 text-cyan-300">
          <IconClock size={22} />
          <h2 className="text-lg font-black uppercase tracking-wider">
            Time for a break
          </h2>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-white/80">
          You've been playing for about{" "}
          <span className="font-bold text-cyan-300">
            {elapsedLabel} {elapsedLabel === 1 ? "minute" : "minutes"}
          </span>
          . Step away for a bit — your balance and games will be right here
          when you're back.
        </p>

        <button
          type="button"
          onClick={dismiss}
          className="mt-5 w-full rounded-xl border-b-4 border-cyan-800 bg-cyan-500 px-4 py-2.5 text-sm font-extrabold text-black transition hover:brightness-110"
        >
          Keep playing
        </button>
      </div>
    </div>
  );
}
