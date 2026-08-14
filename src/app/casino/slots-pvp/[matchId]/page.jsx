"use client";

// src/app/casino/slots-pvp/[matchId]/page.jsx
//
// MATCH view for PvP Slots — "Fruit Fortune Survival".
//
// How the survival round plays:
//   1. The server opens ONE survival round. Each player stops columns
//      on their own 3-column sliding window (column symbols are
//      generated server-side per player, deterministically).
//   2. The board shows the NEXT column's REAL symbols (the "peek") —
//      no cosmetic spinner, because stop-timing never changed the
//      outcome. The skill is deciding: take the column, or burn your
//      one JETTISON to skip it and take the following column instead.
//   3. GRACE phase: you CANNOT bust until you form your first 3-in-a-row
//      combo (horizontal row or diagonal). You have at most 10 grace
//      stops to find it.
//   4. SURVIVAL phase: from the first combo on, every column you stop
//      must re-form a horizontal/diagonal combo or you're OUT. The
//      window slides left with every column; the oldest falls off.
//   5. Each active column has a 15s countdown plus a 2.5s stop-grace
//      window (a click landing just after the deadline still counts) —
//      lag can never cost you a column. AFK columns auto-stop.
//   6. The round resolves ONLY when BOTH players' runs have ended: no
//      early loss popup. The winner is whoever survived more columns
//      (tiebreak: total combos formed). Both grace-fail → tie with a
//      5%-each rake.
//
// Stops are sent over the existing socket (near-instant, with an HTTP
// fallback) so the 800ms status poll is only the safety net, not the
// stop path.
//
// Anti-cheat: the opponent's columns stay hidden while the round is
// live (the status route scrubs them); the client only sees the
// opponent's run status (grace / alive / out + survival count). All
// combo logic is server-side.

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
  GRACE_MAX_STOPS,
  MATCH_STATUS,
  MAX_JETTISONS_PER_RUN,
  RESULT,
  ROUND_TIMER_SECONDS,
} from "../../../../lib/slots-pvp/constants";
import { SlotSymbol } from "../../../../lib/slotIcons";
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

function EyeIcon({ className = "" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M2 12 C4.5 6.5 8.5 4 12 4 C15.5 4 19.5 6.5 22 12 C19.5 17.5 15.5 20 12 20 C8.5 20 4.5 17.5 2 12 Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// ── Run-status helpers ───────────────────────────────────────────────
// `run` is a viewerRun snapshot (own full run, or opponent's scrubbed
// run). During waiting/ready there is no run yet.

function deriveRunStatus(match, run) {
  if (!match) return "idle";
  if (match.status === MATCH_STATUS.FINISHED) return "finished";
  if (match.status === MATCH_STATUS.CANCELLED) return "cancelled";
  if (match.status === MATCH_STATUS.WAITING) return "waiting";
  if (match.status === MATCH_STATUS.READY) return "ready";
  if (!run) return "idle";
  if (run.ended) {
    if (run.busted) return "busted";
    if (run.graceFailed) return "grace_failed";
    return "capped";
  }
  return run.firstComboAt === null ? "grace" : "alive";
}

// ── Player side panel ────────────────────────────────────────────────
// Shows the seat, survival count (big), combos formed, and a live
// run-status chip (grace / alive / out).

function PlayerPanel({
  seat,
  displayName,
  avatarUrl,
  survived,
  lines,
  runStatus,
  graceStopsUsed,
  isViewer,
  isLive,
}) {
  const isCyan = seat === "player1";
  const headerColour = isCyan ? "text-cyan-200" : "text-fuchsia-200";
  const scoreColour = isCyan ? "text-cyan-100" : "text-fuchsia-100";
  const ringColour = isCyan
    ? "border-cyan-300/40 shadow-[0_0_18px_rgba(0,229,255,0.18)]"
    : "border-fuchsia-300/40 shadow-[0_0_18px_rgba(255,79,216,0.18)]";

  let chip = null;
  const tone = isCyan ? "cyan" : "fuchsia";
  if (runStatus === "finished" || runStatus === "cancelled") {
    chip = { label: runStatus === "finished" ? "MATCH OVER" : "CANCELLED", cls: "bg-white/10 text-white/50 border-white/10" };
  } else if (runStatus === "waiting") {
    chip = { label: "WAITING", cls: "bg-white/5 text-white/50 border-white/10" };
  } else if (runStatus === "ready") {
    chip = { label: "GET READY", cls: "bg-amber-500/15 text-amber-200 border-amber-300/40" };
  } else if (runStatus === "grace") {
    chip = {
      label: `FIND COMBO ${Math.min(graceStopsUsed ?? 0, GRACE_MAX_STOPS)}/${GRACE_MAX_STOPS}`,
      cls: tone === "cyan"
        ? "bg-amber-500/15 text-amber-200 border-amber-300/40"
        : "bg-amber-500/15 text-amber-200 border-amber-300/40",
    };
  } else if (runStatus === "alive") {
    chip = {
      label: "SURVIVING",
      cls: tone === "cyan"
        ? "bg-emerald-500/15 text-emerald-200 border-emerald-300/40 shadow-[0_0_14px_rgba(16,185,129,0.25)]"
        : "bg-emerald-500/15 text-emerald-200 border-emerald-300/40 shadow-[0_0_14px_rgba(16,185,129,0.25)]",
    };
  } else if (runStatus === "busted") {
    chip = { label: "OUT · BUSTED", cls: "bg-red-500/15 text-red-200 border-red-400/40" };
  } else if (runStatus === "grace_failed") {
    chip = { label: "OUT · NO COMBO", cls: "bg-red-500/15 text-red-200 border-red-400/40" };
  } else if (runStatus === "capped") {
    chip = { label: "OUT · CAP", cls: "bg-white/10 text-white/50 border-white/10" };
  } else {
    chip = { label: "…", cls: "bg-white/5 text-white/50 border-white/10" };
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
          <p className="text-[9px] uppercase tracking-wider text-white/50">Survived</p>
          <p className={`text-2xl sm:text-3xl font-black tabular-nums ${scoreColour}`}>
            {survived}
          </p>
        </div>
        <div className="rounded-xl bg-white/5 border border-white/10 p-2 text-center">
          <p className="text-[9px] uppercase tracking-wider text-white/50">Combos</p>
          <p className={`text-2xl sm:text-3xl font-black tabular-nums ${scoreColour}`}>
            {lines}
          </p>
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
        {chip.label === "SURVIVING" ? (
          <CheckIcon className="w-3.5 h-3.5" />
        ) : isLive && (chip.label === "FIND COMBO" || chip.label === "GET READY") ? (
          <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
        ) : chip.label.startsWith("OUT") || chip.label === "MATCH OVER" || chip.label === "CANCELLED" ? (
          <CrossIcon className="w-3 h-3 opacity-60" />
        ) : (
          <span />
        )}
        {chip.label}
      </motion.div>
    </div>
  );
}

// ── Survival board ───────────────────────────────────────────────────
// The 3-column sliding window. Each landed column shows its final SVG
// symbols; the active column spins (cosmetic tick) until stopped. In
// the sliding phase a new column enters from the right and the oldest
// slides out left (framer-motion layout transitions).

function SurvivalBoard({
  run,
  canStop,
  onStop,
  onJettison,
  isLive,
  themeName,
}) {
  const windowCols = run?.window || [null, null, null];
  const stoppedCount = run?.stoppedCount ?? 0;
  const ended = Boolean(run?.ended);
  const sliding = stoppedCount >= 3;
  const baseIndex = sliding ? stoppedCount - 3 : 0;
  const activeIndex = !ended ? (run?.activeIndex ?? null) : null;

  // Skill preview: the REAL symbols of the next column to land (the one
  // STOP / JETTISON act on). The old cosmetic "rolling" animation is
  // gone — stop-timing never changed the outcome, so the board shows
  // the truth and the player makes the call: take it or jettison it.
  const preview = run?.preview ?? null;
  const previewIndex = run?.previewIndex ?? null;
  const jettisonsUsed = run?.jettisonsUsed ?? 0;
  const jettisonsLeft = run?.jettisonsLeft ?? 0;
  const canJettison =
    Boolean(canStop) &&
    !ended &&
    isLive &&
    sliding &&
    activeIndex != null &&
    jettisonsLeft > 0;

  // Real-preview cell: the next column's ACTUAL symbols (no fake
  // spinner). Used for the active slot (initial phase) and the entering
  // column (sliding phase). `preview` always corresponds to the active
  // column index, so the symbols shown are exactly what will land.
  const previewCell = (colIndex, entering = false) => (
    <div className="flex flex-col gap-1.5 h-full">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[9px] uppercase tracking-widest text-cyan-200/90 font-bold">
          {entering ? "Incoming" : "Active"}
        </span>
        <span className="inline-flex items-center gap-0.5 text-[9px] font-black tracking-widest text-amber-300">
          <EyeIcon className="w-3 h-3" />
          PEEK
        </span>
      </div>
      <div className="flex-1 rounded-xl border border-amber-300/40 bg-gradient-to-b from-[#08142f] to-[#020617] shadow-[0_0_16px_rgba(255,200,0,0.18)] overflow-hidden">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className={`flex items-center justify-center h-16 sm:h-20 md:h-24 ${
              row > 0 ? "border-t border-white/10" : ""
            }`}
          >
            <SlotSymbol
              symbol={preview?.[row] ?? "?"}
              className="w-9 h-9 sm:w-12 sm:h-12 md:w-14 md:h-14 drop-shadow-[0_0_8px_rgba(255,200,0,0.3)]"
            />
          </div>
        ))}
      </div>
      <div className="h-9" />
    </div>
  );

  // A column that isn't the active one yet (initial phase only — the
  // player stops columns in order) shows a dim placeholder instead of a
  // misleading fake spinner.
  const pendingCell = (colIndex) => (
    <div className="flex flex-col gap-1.5 h-full">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[9px] uppercase tracking-widest text-white/40 font-bold">
          Col {colIndex + 1}
        </span>
      </div>
      <div className="flex-1 rounded-xl border border-white/10 bg-[#020617] flex items-center justify-center">
        <span className="text-white/15 text-3xl">?</span>
      </div>
      <div className="h-9" />
    </div>
  );

  const lockedCell = (col, colIndex) => (
    <div className="flex flex-col gap-1.5 h-full">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[9px] uppercase tracking-widest text-white/40 font-bold">
          Col {colIndex + 1}
        </span>
        <span className="inline-flex items-center gap-0.5 text-[9px] font-black tracking-widest text-emerald-300">
          <LockIcon className="w-3 h-3" />
          LOCKED
        </span>
      </div>
      <div className="flex-1 rounded-xl border border-emerald-400/60 bg-gradient-to-b from-[#08142f] to-[#020617] shadow-[0_0_16px_rgba(16,185,129,0.35)] overflow-hidden">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className={`flex items-center justify-center h-16 sm:h-20 md:h-24 ${
              row > 0 ? "border-t border-white/10" : ""
            }`}
          >
            <SlotSymbol
              symbol={col[row]}
              className="w-9 h-9 sm:w-12 sm:h-12 md:w-14 md:h-14"
            />
          </div>
        ))}
      </div>
      <div className="h-9" />
    </div>
  );

  return (
    <div className="rounded-2xl border border-amber-300/30 bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814] p-3 sm:p-4 shadow-[0_0_60px_rgba(255,200,0,0.14),inset_0_0_30px_rgba(255,200,0,0.06)]">
      {/* Belly-glass header */}
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-[10px] uppercase tracking-widest text-amber-200/70 font-bold">
          {themeName}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-white/40 font-bold">
          Survival · 3×3
        </span>
      </div>

      <div className="relative grid grid-cols-3 gap-2 sm:gap-3">
        <AnimatePresence initial={false}>
          {[0, 1, 2].map((slot) => {
            const colIndex = baseIndex + slot;
            const col = windowCols[slot];
            const locked = col !== null;
            const isActiveSlot =
              !locked && isLive && !ended && colIndex === previewIndex;
            return (
              <motion.div
                key={`w-${colIndex}`}
                layout
                initial={{ opacity: 0, x: 42 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -42 }}
                transition={{ duration: 0.32 }}
                className="min-w-0"
              >
                {locked
                  ? lockedCell(col, colIndex)
                  : isActiveSlot
                    ? previewCell(colIndex)
                    : pendingCell(colIndex)}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Entering column — slides in from the right during the sliding
            phase, showing the REAL next column (the peek) */}
        {sliding && activeIndex !== null && isLive && !ended && (
          <motion.div
            key={`enter-${activeIndex}`}
            initial={{ x: "112%" }}
            animate={{ x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-y-0 right-0 w-[calc((100%-1rem)/3)] sm:w-[calc((100%-1.5rem)/3)] z-10"
          >
            {preview ? previewCell(activeIndex, true) : pendingCell(activeIndex)}
          </motion.div>
        )}
      </div>

      {/* Status strip + the STOP / JETTISON buttons (all phases) */}
      <div className="mt-3 space-y-2">
        {isLive && !ended && activeIndex != null && (
          <div className="flex gap-2">
            <button
              onClick={() => onStop(activeIndex)}
              disabled={!canStop || !isLive || ended}
              className="flex-1 px-4 py-3 rounded-xl text-sm font-black tracking-widest bg-gradient-to-r from-red-500 to-orange-500 text-white hover:from-red-400 hover:to-orange-400 shadow-[0_0_20px_rgba(255,60,60,0.5)] animate-pulse disabled:opacity-40 disabled:animate-none disabled:cursor-not-allowed transition"
            >
              STOP THE COLUMN
            </button>
            {sliding && (
              <button
                onClick={() => onJettison?.(activeIndex)}
                disabled={!canJettison}
                title="Skip the incoming column and take the next one instead — once per run."
                className="px-3 py-3 rounded-xl text-xs font-black tracking-widest bg-amber-500/15 text-amber-200 border border-amber-300/40 hover:bg-amber-500/25 shadow-[0_0_14px_rgba(255,200,0,0.2)] disabled:opacity-35 disabled:cursor-not-allowed transition"
              >
                JETTISON {jettisonsUsed}/{MAX_JETTISONS_PER_RUN}
              </button>
            )}
          </div>
        )}

        <div className="flex items-center justify-center gap-2 text-[11px] text-white/55">
          {!isLive ? (
            <span>Waiting for the round to start</span>
          ) : ended ? (
            <span className="inline-flex items-center gap-1.5 text-red-200">
              <CrossIcon className="w-3.5 h-3.5" />
              You&apos;re out — waiting for the opponent to finish…
            </span>
          ) : run?.status === "grace" ? (
            <span className="inline-flex items-center gap-1.5 text-amber-200">
              <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
              Find your first 3-in-a-row — stops used:{" "}
              <b>{(run?.graceStopsUsed ?? 0)}/{GRACE_MAX_STOPS}</b>
            </span>
          ) : run?.status === "alive" ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-200">
              <SparkIcon className="w-3.5 h-3.5" />
              Streak <b>{run?.survived ?? 0}</b> — keep the combos coming!
            </span>
          ) : (
            <span>Round live</span>
          )}
        </div>

        {/* Jettison hint — the one real decision in the sliding phase */}
        {isLive && !ended && sliding && (
          <div className="flex items-center justify-center gap-2 text-[10px] text-white/45">
            {jettisonsLeft > 0 ? (
              <span className="inline-flex items-center gap-1">
                <SparkIcon className="w-3 h-3 text-amber-300/80" />
                <b className="text-amber-200/80">Jettison {jettisonsLeft}</b>
                <span>— skip the incoming column if it won&apos;t make a combo</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <CrossIcon className="w-3 h-3 opacity-50" />
                Jettison used — every stop must combo from here
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── VS scoreboard ────────────────────────────────────────────────────
// Compact match header: You vs Opponent, live survival counts, the
// per-column countdown ring and the viewer's run chip.

function ScoreBoard({
  p1Name,
  p2Name,
  p1Avatar,
  p2Avatar,
  isViewerP1,
  status,
  secondsLeft,
  ringTotal,
  viewerStatus,
  opponentStatus,
  viewerSurvived,
  opponentSurvived,
}) {
  const isFinished = status === MATCH_STATUS.FINISHED;
  const isCancelled = status === MATCH_STATUS.CANCELLED;
  const isReady = status === MATCH_STATUS.READY;
  const isWaiting = status === MATCH_STATUS.WAITING;
  const isSpin = /^spin_\d+$/.test(status || "");
  const countdownLive = (isSpin || isReady) && !isFinished && !isCancelled;
  const urgent = isSpin && secondsLeft > 0 && secondsLeft <= 5;
  const progress = countdownLive
    ? Math.min(1, Math.max(0, secondsLeft / (ringTotal || 10)))
    : 0;
  const RING_R = 18;
  const RING_CIRC = 2 * Math.PI * RING_R;

  const statusText = (s) => {
    if (s === "grace") return "finding combo";
    if (s === "alive") return "surviving";
    if (s === "busted") return "out";
    if (s === "grace_failed") return "no combo";
    if (s === "capped") return "out";
    if (s === "finished") return "done";
    return s;
  };

  function Side({ seat, name, avatar, survived, runStatus }) {
    const cyan = seat === "player1";
    const isYou = cyan ? isViewerP1 : !isViewerP1;
    const numColour = cyan ? "text-cyan-100" : "text-fuchsia-100";
    const alive = runStatus === "alive" || runStatus === "grace";
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
          <p className={`text-xs sm:text-sm font-bold truncate ${numColour}`} title={name}>
            {name}
          </p>
        </div>
        <p className={`text-2xl sm:text-3xl font-black tabular-nums leading-none mt-1 ${numColour}`}>
          {survived}
        </p>
        <span
          className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
            alive
              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-400/40"
              : runStatus === "busted" || runStatus === "grace_failed" || runStatus === "capped"
                ? "bg-red-500/15 text-red-300 border border-red-400/40"
                : "bg-white/5 text-white/45 border border-white/10"
          }`}
        >
          {alive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
          {statusText(runStatus)}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] px-3 sm:px-6 py-3 sm:py-4 shadow-[0_0_40px_rgba(255,200,0,0.1)]">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-5">
        <Side seat="player1" name={p1Name} avatar={p1Avatar} survived={isViewerP1 ? viewerSurvived : opponentSurvived} runStatus={isViewerP1 ? viewerStatus : opponentStatus} />
        {/* Note: Side's isYou label uses the seat; the survived/status passed
            above intentionally reflect the VIEWER's seat orientation. */}

        <div className="flex flex-col items-center gap-0.5 min-w-0">
          <span className="text-[9px] sm:text-[10px] uppercase tracking-widest text-white/50 font-bold">
            Survival Round
          </span>
          <span className="text-[9px] uppercase tracking-wider text-white/40 font-semibold">
            More columns = win
          </span>

          <div className="relative w-12 h-12 sm:w-14 sm:h-14 mt-1">
            {countdownLive ? (
              <>
                <svg viewBox="0 0 48 48" className="w-full h-full -rotate-90">
                  <circle cx="24" cy="24" r={RING_R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
                  <circle
                    cx="24"
                    cy="24"
                    r={RING_R}
                    fill="none"
                    stroke={urgent ? "#f87171" : "#fbbf24"}
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRC}
                    strokeDashoffset={RING_CIRC * (1 - progress)}
                    style={{ transition: "stroke-dashoffset 300ms linear, stroke 300ms" }}
                  />
                </svg>
                <span
                  className={`absolute inset-0 flex items-center justify-center text-base sm:text-lg font-black tabular-nums ${
                    urgent ? "text-red-300" : "text-amber-100"
                  }`}
                >
                  {Math.max(0, Math.ceil(secondsLeft))}
                </span>
              </>
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-lg">
                {isFinished ? (
                  <TrophyIcon className="w-7 h-7 text-yellow-300 drop-shadow-[0_0_10px_rgba(255,200,0,0.5)]" />
                ) : isWaiting ? (
                  <span className="text-white/30">—</span>
                ) : (
                  <span className="text-white/30">—</span>
                )}
              </span>
            )}
          </div>

          <span className="text-[9px] uppercase tracking-wider text-white/40 font-semibold">
            {isReady ? "Get ready…" : isSpin ? "Column timer" : ""}
          </span>
        </div>

        <Side seat="player2" name={p2Name} avatar={p2Avatar} survived={isViewerP1 ? opponentSurvived : viewerSurvived} runStatus={isViewerP1 ? opponentStatus : viewerStatus} />
      </div>
    </div>
  );
}

// ── Winner / reveal popup ────────────────────────────────────────────
// Shown ONLY when both players' runs have ended (the server resolves
// then) — no early loss popup. Reveals both survival runs + the result.

function WinnerPopup({ match, user, onBack, p1Name, p2Name, roundResult }) {
  const isGraceDraw = match.result === RESULT.GRACE_DRAW;
  const isDraw = match.result === RESULT.DRAW;
  const iWon = Boolean(match.winnerId && user?.id && match.winnerId === user.id);
  const p1 = roundResult?.player1Result || {};
  const p2 = roundResult?.player2Result || {};
  const p1Survived = Number(match.p1Score) || 0;
  const p2Survived = Number(match.p2Score) || 0;

  const title = isGraceDraw
    ? "Double No-Combo!"
    : isDraw
      ? "It's a Draw!"
      : iWon
        ? "You Win!"
        : "You Lose";
  const titleColour = isDraw || isGraceDraw ? "text-yellow-300" : iWon ? "text-emerald-300" : "text-red-300";

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
    >
      <div className="rounded-2xl border border-amber-300/40 bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] p-6 sm:p-8 max-w-md w-full shadow-[0_0_80px_rgba(255,200,0,0.22)]">
        <div className="flex items-center justify-center mb-4">
          <TrophyIcon className="w-10 h-10 text-yellow-300 drop-shadow-[0_0_16px_rgba(255,200,0,0.5)]" />
        </div>
        <h3 className="text-center text-sm uppercase tracking-widest text-amber-200/70 font-semibold mb-1">
          Match Over
        </h3>
        <p className={`text-center text-3xl font-black mt-2 ${titleColour}`}>{title}</p>

        {!isDraw && !isGraceDraw && (
          <p className="text-center text-sm text-white/70 mt-2">
            <span className="font-bold text-white">
              {iWon ? "You" : match.winnerId === match.player1Id ? p1Name : p2Name}
            </span>{" "}
            survived{" "}
            <span className="font-bold text-white">
              {Math.max(p1Survived, p2Survived)}
            </span>{" "}
            columns to{" "}
            <span className="font-bold text-white">{Math.min(p1Survived, p2Survived)}</span>
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 mt-5">
          <div className="rounded-xl border border-cyan-300/30 bg-cyan-500/10 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-cyan-200/70 truncate">{p1Name}</p>
            <p className="mt-1 text-2xl font-black text-cyan-100 tabular-nums">
              {p1Survived} survived
            </p>
            <p className="text-[10px] text-white/50 mt-0.5 tabular-nums">
              {p1.linesFormed || 0} combos
              {p1.graceFailed ? " · no combo" : p1.busted ? " · busted" : ""}
            </p>
          </div>
          <div className="rounded-xl border border-fuchsia-300/30 bg-fuchsia-500/10 p-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-fuchsia-200/70 truncate">{p2Name}</p>
            <p className="mt-1 text-2xl font-black text-fuchsia-100 tabular-nums">
              {p2Survived} survived
            </p>
            <p className="text-[10px] text-white/50 mt-0.5 tabular-nums">
              {p2.linesFormed || 0} combos
              {p2.graceFailed ? " · no combo" : p2.busted ? " · busted" : ""}
            </p>
          </div>
        </div>

        {match.isBot ? (
          <p className="text-center text-xs text-fuchsia-200/80 mt-4">
            Practice match — no tokens were wagered.
          </p>
        ) : !isDraw && !isGraceDraw ? (
          <p className="text-center text-xs text-white/60 mt-4">
            Prize paid:{" "}
            <span className="text-white font-bold">{(match.prizePaid || 0).toFixed(2)}</span>
          </p>
        ) : null}
        {!match.isBot && isGraceDraw && (
          <p className="text-center text-xs text-yellow-200/80 mt-4">
            Both players failed to make a combo — each refunded 95% (house keeps 10%).
          </p>
        )}
        {!match.isBot && isDraw && !isGraceDraw && (
          <p className="text-center text-xs text-white/60 mt-4">
            Equal survival — both players refunded, no house fee.
          </p>
        )}

        <button
          onClick={onBack}
          className="mt-6 w-full px-4 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-amber-400 to-orange-500 text-[#001933] hover:from-amber-300 hover:to-orange-400 transition shadow-[0_0_25px_rgba(255,200,0,0.4)]"
        >
          Back to Lobby
        </button>
      </div>
    </motion.div>
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
  const [readyLeft, setReadyLeft] = useState(0);
  const [columnLeftMs, setColumnLeftMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const fetchStatusPendingRef = useRef(false);
  const resolvedFiredRef = useRef(false);
  // When the rate limiter trips, pause polling briefly instead of
  // hammering the endpoint every 800ms (which would keep the board
  // frozen and make STOP appear broken).
  const rateLimitCooldownRef = useRef(0);

  // ── Status fetch (800ms poll + in-flight guard) ─────────────────
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
    if (Date.now() < rateLimitCooldownRef.current) return null;
    fetchStatusPendingRef.current = true;
    try {
      const res = await fetch(`/api/slots-pvp/match/${matchId}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json();
      if (res.status === 429) {
        // Rate limited — pause polling for a few seconds instead of
        // spinning against the limit, then resume.
        rateLimitCooldownRef.current = Date.now() + 3000;
        setError(data?.error || "You're going too fast — slowing down.");
        return null;
      }
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

  // ── Socket subscription (per-match room; re-join on reconnect) ───
  useEffect(() => {
    if (!socket) return;
    if (!isValidMatchId) return;
    const refresh = () => fetchStatus();
    const roomId = slotsPvpMatchRoom(matchId);
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

  // ── Ready-window countdown (3s "get ready" banner) ───────────────
  useEffect(() => {
    if (
      match?.status !== MATCH_STATUS.READY ||
      !match.roundDeadline
    ) {
      setReadyLeft(0);
      return;
    }
    const deadlineMs = new Date(match.roundDeadline).getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setReadyLeft(remaining);
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [match?.status, match?.roundDeadline]);

  // ── Per-column countdown (viewer's active column) ────────────────
  useEffect(() => {
    const run = match?.viewerRun;
    if (
      !match ||
      !/^spin_\d+$/.test(match.status || "") ||
      !run ||
      run.ended ||
      !run.activeDeadline
    ) {
      setColumnLeftMs(0);
      return;
    }
    const deadlineMs = new Date(run.activeDeadline).getTime();
    const tick = () => setColumnLeftMs(Math.max(0, deadlineMs - Date.now()));
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [match?.status, match?.viewerRun]);

  // ── Stop / jettison a column ─────────────────────────────────────
  // Near-instant path: the stop is sent over the existing socket (the
  // realtime server proxies it to the internal, token-verified route),
  // so the click locks the column without waiting for the 800ms poll.
  // Falls back to the direct HTTP route when the socket isn't
  // connected (first paint / mobile suspend).
  const handleStop = useCallback(
    async (columnIndex, jettison = false) => {
      if (busy || !isValidMatchId) return;
      if (columnIndex == null) return;
      setBusy(true);
      setError(null);
      try {
        const payload = {
          matchId,
          columnIndex,
          currentSpin: match?.currentSpin ?? null,
          jettison: !!jettison,
        };

        if (socket?.connected) {
          const ack = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 4000);
            socket.emit("slots:stop", payload, (reply) => {
              clearTimeout(timer);
              resolve(reply);
            });
          });
          if (ack && ack.success === true) {
            posthog?.capture("slots_pvp_column_stopped", {
              match_id: matchId,
              column: columnIndex,
              jettison: !!jettison,
              transport: "socket",
              run_ended: ack.runEnded === true,
              round_resolved: ack.roundResolved === true,
            });
            fetchStatus();
            return;
          }
          // 409 / 400 (already stopped / expired) are expected races —
          // the server may have auto-stopped this column at its
          // deadline, or the round already advanced. Re-poll RIGHT AWAY
          // so the board re-syncs instantly. Only surface genuinely
          // unexpected errors.
          if (!ack) {
            setError("Stop timed out — re-syncing…");
          } else if (ack.status !== 409 && ack.status !== 400) {
            setError(ack.error || "Unable to stop column");
          }
          fetchStatus();
          return;
        }

        const res = await fetch(`/api/slots-pvp/match/${matchId}/stop-reel`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          if (res.status === 429) {
            rateLimitCooldownRef.current = Date.now() + 3000;
            setError(
              data?.error || "You're going too fast — please wait a moment.",
            );
            fetchStatus();
            return;
          }
          if (res.status !== 409 && res.status !== 400) {
            setError(data?.error || "Unable to stop column");
          }
          fetchStatus();
          return;
        }
        posthog?.capture("slots_pvp_column_stopped", {
          match_id: matchId,
          column: columnIndex,
          jettison: !!jettison,
          transport: "http",
          run_ended: data?.data?.runEnded === true,
          round_resolved: data?.data?.roundResolved === true,
        });
        fetchStatus();
      } finally {
        setBusy(false);
      }
    },
    [busy, isValidMatchId, matchId, match?.currentSpin, socket, posthog, fetchStatus],
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
      router.push("/casino/slots");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, matchId, posthog, router]);

  // ── Busy safety-net ──────────────────────────────────────────────
  useEffect(() => {
    if (!busy) return;
    const watchdog = setTimeout(() => setBusy(false), 8000);
    return () => clearTimeout(watchdog);
  }, [busy]);

  // ── Posthog: match-just-resolved ─────────────────────────────────
  useEffect(() => {
    if (!match || match.status !== MATCH_STATUS.FINISHED) {
      if (resolvedFiredRef.current) resolvedFiredRef.current = false;
      return;
    }
    if (resolvedFiredRef.current) return;
    resolvedFiredRef.current = true;
    const isDraw = match.result === RESULT.DRAW;
    const isGraceDraw = match.result === RESULT.GRACE_DRAW;
    const iWon = Boolean(match.winnerId && user?.id && match.winnerId === user.id);
    const winner = isDraw || isGraceDraw ? "draw" : iWon ? "you" : "opponent";
    posthog?.capture("slots_pvp_match_resolved", {
      match_id: match?.id ?? matchId ?? -1,
      winner,
      result: match.result,
      stake: (match.stakeAmount || 0).toFixed(2),
      prize_paid: (match.prizePaid || 0).toFixed(2),
      house_fee: (match.houseFee || 0).toFixed(2),
      survived_p1: match.p1Score,
      survived_p2: match.p2Score,
    });
  }, [match, matchId, user?.id, posthog]);

  // ── Loading / error renders ──────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-12 flex max-w-3xl items-center justify-center gap-3 text-amber-200">
          <LoadingDotsIcon className="w-6 h-6 text-amber-300 animate-pulse" />
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
            onClick={() => router.push("/casino/slots")}
            className="mt-4 px-4 py-2 rounded-lg bg-amber-400 text-[#001933] hover:bg-amber-300 text-sm font-bold"
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
            onClick={() => router.push("/casino/slots")}
            className="mt-4 px-4 py-2 rounded-lg bg-amber-400 text-[#001933] hover:bg-amber-300 text-sm font-bold"
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

  const isViewerP1 = match.viewerIsPlayer1;
  const viewerSeat = isViewerP1 ? "player1" : "player2";
  const viewerRun = match.viewerRun || null;
  const opponentRun = match.opponentRun || null;
  const viewerStatus = deriveRunStatus(match, viewerRun);
  const opponentStatus = deriveRunStatus(match, opponentRun);

  const viewerSurvived = viewerRun?.survived ?? (isFinished ? (isViewerP1 ? match.p1Score : match.p2Score) : 0);
  const opponentSurvived = opponentRun?.survived ?? (isFinished ? (isViewerP1 ? match.p2Score : match.p1Score) : 0);
  const viewerLines = viewerRun?.linesFormed ?? 0;
  const opponentLines = opponentRun?.linesFormed ?? 0;
  const viewerGraceStops = viewerRun?.graceStopsUsed ?? 0;
  const opponentGraceStops = opponentRun?.graceStopsUsed ?? 0;

  const stake = match.stakeAmount;
  const roundTimer = match.roundTimer || ROUND_TIMER_SECONDS;
  const secondsLeft = isReady ? readyLeft : columnLeftMs / 1000;
  const ringTotal = isReady ? 3 : roundTimer;

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

  const themeName = getTheme(match.theme || "fruit").name;
  const roundResult = rounds && rounds.length > 0 ? rounds[rounds.length - 1] : null;

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
      const urgent = columnLeftMs > 0 && columnLeftMs <= 5000;
      if (viewerStatus === "busted" || viewerStatus === "grace_failed" || viewerStatus === "capped") {
        return (
          <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-red-400/50 bg-red-900/25 px-4 py-3 text-red-200">
            <span className="font-bold text-base sm:text-lg">
              {viewerStatus === "busted"
                ? "You're out — no combo! Waiting for the opponent…"
                : viewerStatus === "grace_failed"
                  ? "No combo in 10 stops — you're out! Waiting for the opponent…"
                  : "Run capped — waiting for the opponent…"}
            </span>
          </div>
        );
      }
      if (opponentStatus === "busted" || opponentStatus === "grace_failed" || opponentStatus === "capped") {
        return (
          <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-4 py-3 text-emerald-200">
            <span className="font-bold text-base sm:text-lg">
              Opponent is out — keep going for the win!
            </span>
          </div>
        );
      }
      if (viewerStatus === "grace") {
        return (
          <div
            className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border px-4 py-3 ${
              urgent
                ? "border-red-400/60 bg-red-900/30 text-red-200 animate-pulse"
                : "border-amber-300/40 bg-amber-500/10 text-amber-200"
            }`}
          >
            <span className="font-bold text-base sm:text-lg">
              Find your first 3-in-a-row combo — stops used: {Math.min(viewerGraceStops, GRACE_MAX_STOPS)}/{GRACE_MAX_STOPS}
            </span>
          </div>
        );
      }
      return (
        <div
          className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border px-4 py-3 ${
            urgent
              ? "border-red-400/60 bg-red-900/30 text-red-200 animate-pulse"
              : "border-emerald-300/40 bg-emerald-500/10 text-emerald-200"
          }`}
        >
          <span className="font-bold text-base sm:text-lg">
            Streak {viewerSurvived} — keep the combos coming!
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
            <ReelIcon className="w-7 h-7 sm:w-8 sm:h-8 text-amber-300 drop-shadow-[0_0_12px_rgba(255,200,0,0.65)] flex-shrink-0" />
            <h1 className="text-lg sm:text-xl font-black tracking-tight">
              🍒 Fruit Fortune · Match #{matchId ?? "?"}
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
            <span className="font-mono">Survival round</span>
            {match.isBot && (
              <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-400/40 bg-fuchsia-500/10 px-2.5 py-0.5 font-bold text-fuchsia-300">
                🤖 Practice · vs Bot
              </span>
            )}
            <span className="font-mono">
              {viewerSeat === "player1" ? "P1" : "P2"} seat
            </span>
            {!match.isBot && opponentClerkId && (
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

        {/* VS scoreboard: You vs Opponent, survival counts, column timer */}
        <div className="mt-3">
          <ScoreBoard
            p1Name={p1Name}
            p2Name={p2Name}
            p1Avatar={p1Avatar}
            p2Avatar={p2Avatar}
            isViewerP1={isViewerP1}
            status={match.status}
            secondsLeft={secondsLeft}
            ringTotal={ringTotal}
            viewerStatus={viewerStatus}
            opponentStatus={opponentStatus}
            viewerSurvived={viewerSurvived}
            opponentSurvived={opponentSurvived}
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
              survived={isViewerP1 ? viewerSurvived : opponentSurvived}
              lines={isViewerP1 ? viewerLines : opponentLines}
              runStatus={isViewerP1 ? viewerStatus : opponentStatus}
              graceStopsUsed={isViewerP1 ? viewerGraceStops : opponentGraceStops}
              isViewer={isViewerP1}
              isLive={isSpin && !isFinished && !isCancelled}
            />
          </div>

          {/* Center: survival board */}
          <div className="order-1 lg:order-2 min-w-0">
            <SurvivalBoard
              run={viewerRun}
              canStop={Boolean(match.viewerCanStop) && !busy}
              onStop={handleStop}
              onJettison={(idx) => handleStop(idx, true)}
              isLive={isSpin && !isFinished && !isCancelled}
              themeName={themeName}
            />

            {/* Per-column countdown bar (viewer's active column) */}
            {(isSpin || isReady) && !isFinished && !isCancelled && (
              <div className="mt-2">
                <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      secondsLeft <= 5 ? "bg-red-400" : "bg-amber-400"
                    }`}
                    style={{
                      width: `${Math.min(100, Math.max(0, (secondsLeft / ringTotal) * 100))}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[9px] uppercase tracking-widest text-white/35 font-bold">
                  <span>{isReady ? "Get ready…" : "Column timer"}</span>
                  <span>{Math.max(0, Math.ceil(secondsLeft))}s</span>
                </div>
              </div>
            )}

            {/* Opponent progress line */}
            <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-white/55">
              {isSpin && !isFinished && !isCancelled ? (
                <span className="inline-flex items-center gap-1.5">
                  {opponentStatus === "busted" || opponentStatus === "grace_failed" || opponentStatus === "capped" ? (
                    <span className="inline-flex items-center gap-1 text-red-300">
                      <CrossIcon className="w-3.5 h-3.5" />
                      Opponent is out ({opponentSurvived} survived)
                    </span>
                  ) : opponentStatus === "grace" ? (
                    <span className="inline-flex items-center gap-1 text-amber-200">
                      <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
                      Opponent is finding their first combo…
                    </span>
                  ) : opponentStatus === "alive" ? (
                    <span className="inline-flex items-center gap-1 text-emerald-200">
                      <SparkIcon className="w-3.5 h-3.5" />
                      Opponent is surviving — streak {opponentSurvived}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
                      Waiting for opponent…
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
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="px-4 py-2 rounded-lg bg-red-500/15 text-red-200 border border-red-400/40 text-xs font-bold hover:bg-red-500/25 transition disabled:opacity-50"
                >
                  {cancelling ? "Cancelling…" : "Cancel lobby"}
                </button>
              </div>
            )}
          </div>

          {/* Player 2 panel (right) */}
          <div className="order-3">
            <PlayerPanel
              seat="player2"
              displayName={p2Name}
              avatarUrl={p2Avatar}
              survived={isViewerP1 ? opponentSurvived : viewerSurvived}
              lines={isViewerP1 ? opponentLines : viewerLines}
              runStatus={isViewerP1 ? opponentStatus : viewerStatus}
              graceStopsUsed={isViewerP1 ? opponentGraceStops : viewerGraceStops}
              isViewer={!isViewerP1}
              isLive={isSpin && !isFinished && !isCancelled}
            />
          </div>
        </div>

        {/* Winner / reveal popup — only once BOTH players are done */}
        {isFinished && (
          <WinnerPopup
            match={match}
            user={user}
            onBack={() => router.push("/casino/slots")}
            p1Name={p1Name}
            p2Name={p2Name}
            roundResult={roundResult}
          />
        )}
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
        gameType="Fruit Fortune"
      />

      <Footer />
    </div>
  );
}
