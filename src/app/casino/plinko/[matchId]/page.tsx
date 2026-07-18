"use client";

// src/app/casino/plinko/[matchId]/page.tsx
//
// MATCH view for the Plinko Duel PvP system. Both players commit
// per-ball inputs (startX / power / angleDeg) on a shared 500x540
// plinko board; the server runs the deterministic physics
// simulator, caches the path, and resolves the ball as soon as
// both seats are in. The client animates BOTH players' balls
// concurrently on the same board when a ball resolves (using
// the dual-track `animateBall` helper below).
//
// Layout:
//   ┌─ Title: Plinko Duel · Match #N ──────────────────────┐
//   ├─ Match info strip: stake, ball N/3, seat, status ───┤
//   ├─ Turn indicator + 20s countdown timer ───────────────┤
//   ├─ Board (500x540 SVG): pegs + buckets + dual balls ───┤
//   │     • p1 ball: cyan, p2 ball: fuchsia                │
//   │     • 19-row peg grid (2..20 pegs per row)           │
//   │     • 5-bucket row at y=480                          │
//   ├─ Scoreboard: p1 score | p2 score | balls played ─────┤
//   ├─ Commit panel: 3 sliders (startX / power / angleDeg) │
//   │     + Launch button (enabled iff viewerCanLaunch)    │
//   ├─ Between-rounds banner (3s "Ball N incoming…") ─────┤
//   ├─ Cancel button (host-only while waiting) ────────────┤
//   ├─ Reveal screen (when status='finished') ─────────────┤
//   └─ Footer ─────────────────────────────────────────────┘
//
// Visual style reuses the cyan/fuchsia palette from the solo
// plinko page (src/app/casino/plinko/page.tsx) for visual
// continuity with the existing game. The page is intentionally
// a single self-contained file: the dual-ball animation
// (`animateBall`) is a tiny in-file helper rather than a shared
// module, since no other page in the codebase animates a
// physics-simulated trajectory.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import {
  PLINKO_PVP_LOBBY_ROOM,
  PLINKO_PVP_MATCH_UPDATED,
  plinkoPvpMatchRoom,
} from "../../../../lib/plinko-pvp/rooms";
import {
  BUCKETS,
  BOARD,
  BALL_RADIUS,
  MATCH_STATUS,
  PEG_HORIZ_SPACING,
  PEG_RADIUS,
  PEG_ROWS,
  PEG_COLS_BASE,
  PEG_VERT_SPACING,
  PEG_CENTER_X,
  RESULT,
  REQUIRED_BALLS,
} from "../../../../lib/plinko-pvp/constants";

// ── Animation tuning constants ────────────────────────────────────────

// Wall-clock duration of the per-ball drop animation. Matches the
// physics simulator's typical wall-clock runtime (~2 s for a
// 19-row board with 800-frame cap @ 60 fps) with a small buffer
// for the bucket-row landing flash.
const BALL_ANIMATION_MS = 2500;

// Client-side "ball N incoming" countdown between consecutive
// ball resolutions. The server advances ball_N → ball_(N+1)
// immediately on resolve; the 3 s banner is purely cosmetic.
const BETWEEN_BALLS_MS = 3000;

// Client-side "ready → ball_1" countdown mirror. The server
// auto-advances ready → ball_1 on the /status poll, but the
// client pre-empts with a countdown for snappier UX.
const READY_COUNTDOWN_MS = 3000;

// ── Types ─────────────────────────────────────────────────────────────

type Path = Array<{ x: number; y: number }>;

type BallResult = {
  path: Path;
  fellOut: boolean;
  finalX: number;
  finalY: number;
  bucketIndex: number;
  points: number;
};

type NormalisedMatch = {
  id: number;
  player1Id: string;
  player2Id: string | null;
  stakeAmount: number;
  status: string;
  currentBall: number;
  p1Score: number;
  p2Score: number;
  p1CurrentInputs:
    | { result: BallResult; autoLaunched: boolean; startX: number; power: number; angleDeg: number }
    | null;
  p2CurrentInputs:
    | { result: BallResult; autoLaunched: boolean; startX: number; power: number; angleDeg: number }
    | null;
  roundDeadline: string | null;
  roundTimer: number;
  winnerId: string | null;
  result: string | null;
  prizePaid: number;
  houseFee: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  viewerUserId: string;
  viewerIsParticipant: boolean;
  viewerSeat: "player1" | "player2" | null;
  viewerIsPlayer1: boolean;
  viewerCanLaunch: boolean;
  viewerHasCommitted: boolean;
  opponentHasCommitted: boolean;
  viewerCanCancel: boolean;
};

type NormalisedRound = {
  id: number;
  ballNumber: number;
  player1Inputs: { startX: number; power: number; angleDeg: number };
  player2Inputs: { startX: number; power: number; angleDeg: number };
  player1Result: BallResult;
  player2Result: BallResult;
  player1AutoLaunched: boolean;
  player2AutoLaunched: boolean;
  ballPointsPlayer1: number;
  ballPointsPlayer2: number;
  ballOutcome: "p1" | "p2" | "tie";
};

type Phase =
  | "idle" // commit panel is interactive
  | "launching" // POST in flight
  | "animating" // balls are dropping (animator active)
  | "transitioning" // ball just resolved, between-rounds banner up
  | "finished" // reveal screen
  | "cancelled";

// ── Peg grid (mirror of the physics module's buildPegs, kept in-file
// so the match view doesn't import the frozen module-level PEGS array
// from physics.js — the page only needs the read-only positions). ───

function buildPegs() {
  const pegs: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < PEG_ROWS; r++) {
    const cols = PEG_COLS_BASE + r;
    const firstX = PEG_CENTER_X - ((cols - 1) * PEG_HORIZ_SPACING) / 2;
    for (let c = 0; c < cols; c++) {
      pegs.push({
        x: firstX + c * PEG_HORIZ_SPACING,
        y: BOARD.topY + r * PEG_VERT_SPACING,
      });
    }
  }
  return pegs;
}
const PEGS = buildPegs();

// ── Dual-track ball animator ──────────────────────────────────────────
//
// `animateBall` walks a path (in svg units) over `durationMs`,
// calling `onTick({x, y})` on every animation frame and
// `onComplete()` when the path finishes. Returns a cancel
// function so React effects can abort the animation on unmount
// or when a new animation supersedes it.
//
// `animateBall` is path-aware: it parameterises the trajectory
// by cumulative segment length so the ball's screen velocity is
// proportional to the simulator's frame velocity (the simulator
// records more points where the ball is moving slowly, so naive
// "one point per frame" animation would judder). The dual-track
// pattern is achieved by running TWO `animateBall` instances
// concurrently from a useEffect — each writes to its own state
// (`p1BallPos` / `p2BallPos`) so they don't interfere.

function animateBall(
  path: Path,
  onTick: (point: { x: number; y: number }) => void,
  onComplete: () => void,
  durationMs: number = BALL_ANIMATION_MS,
): () => void {
  if (!path || path.length === 0) {
    onComplete();
    return () => {};
  }
  if (path.length === 1) {
    onTick(path[0]);
    onComplete();
    return () => {};
  }
  // Pre-compute segment lengths once so the per-frame cost is O(log n)
  // (we binary-search the segment containing `targetDist`).
  const segStarts: number[] = [0];
  const cumLens: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dy = path[i].y - path[i - 1].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    totalLen += len;
    cumLens.push(len);
    segStarts.push(totalLen);
  }
  if (totalLen === 0) {
    onTick(path[path.length - 1]);
    onComplete();
    return () => {};
  }
  const startTime = performance.now();
  let rafId = 0;
  let cancelled = false;
  const tick = (now: number) => {
    if (cancelled) return;
    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / durationMs);
    const targetDist = t * totalLen;
    // Linear scan is fine for paths with < 300 points (typical
    // case for a 19-row board). Falls through to the last segment
    // when targetDist exceeds totalLen (the path terminates with
    // a force-set to (finalX, finalY) inside the simulator).
    let segIdx = 0;
    for (let i = 0; i < cumLens.length; i++) {
      if (segStarts[i + 1] >= targetDist) {
        segIdx = i;
        break;
      }
      segIdx = i;
    }
    const segStartDist = segStarts[segIdx];
    const segLen = cumLens[segIdx];
    const localT = segLen === 0 ? 0 : (targetDist - segStartDist) / segLen;
    const p0 = path[segIdx];
    const p1 = path[segIdx + 1];
    onTick({
      x: p0.x + (p1.x - p0.x) * localT,
      y: p0.y + (p1.y - p0.y) * localT,
    });
    if (t < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      onTick(path[path.length - 1]);
      onComplete();
    }
  };
  rafId = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
  };
}

// ── Inline SVG icons (kept in-file so this page doesn't pull in
// other game-specific icon sets) ─────────────────────────────────────

function PlinkoIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3 L4 16 L20 16 Z" />
      <circle cx="9" cy="11" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="15" cy="11" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="20" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CoinIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <ellipse cx="12" cy="6" rx="8" ry="2.5" />
      <path d="M4 6 V18 a8 2.5 0 0 0 16 0 V6" />
      <ellipse cx="12" cy="18" rx="8" ry="2.5" />
    </svg>
  );
}

function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7 V12 L15 14" />
    </svg>
  );
}

function TrophyIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M7 4 H17 V10 a5 5 0 0 1 -10 0 V4 Z" />
      <path d="M5 5 H3 a3 3 0 0 0 3 3" />
      <path d="M19 5 H21 a3 3 0 0 1 -3 3" />
      <path d="M9 19 H15" />
      <path d="M12 14 V19" />
    </svg>
  );
}

function LoadingDotsIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3 L22 20 H2 Z" />
      <line x1="12" y1="10" x2="12" y2="15" />
      <circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 12 L10 17 L19 7" />
    </svg>
  );
}

function CrossIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 6 L18 18" />
      <path d="M18 6 L6 18" />
    </svg>
  );
}

// ── Board sub-component ──────────────────────────────────────────────
//
// Pure visual: renders the static board (background, pegs, bucket
// row) plus the optional animated ball positions for p1 and p2.
// No state, no effects — the parent drives `p1BallPos` / `p2BallPos`
// via the dual-track `animateBall` helper.

function PlinkoBoard({
  p1BallPos,
  p2BallPos,
  highlightBucket,
}: {
  p1BallPos: { x: number; y: number } | null;
  p2BallPos: { x: number; y: number } | null;
  highlightBucket: { index: number; side: "p1" | "p2" } | null;
}) {
  // Bucket colour palette by basePoints (40=red, 100=blue, 140=gold).
  function bucketFill(points: number) {
    if (points >= 140) return "url(#bucketGold)";
    if (points >= 100) return "url(#bucketBlue)";
    return "url(#bucketRed)";
  }
  function bucketStroke(points: number) {
    if (points >= 140) return "#ffd966";
    if (points >= 100) return "#3da9ff";
    return "#ff5577";
  }
  return (
    <div className="rounded-2xl border border-cyan-300/30 bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814] p-3 shadow-[0_0_60px_rgba(0,229,255,0.18),inset_0_0_30px_rgba(0,229,255,0.08)]">
      <svg
        viewBox="0 0 500 540"
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto block"
        role="img"
        aria-label="Plinko board"
      >
        <defs>
          <linearGradient id="boardBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#001a33" />
            <stop offset="100%" stopColor="#000814" />
          </linearGradient>
          <linearGradient id="bucketGold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5a4500" />
            <stop offset="100%" stopColor="#2a1f00" />
          </linearGradient>
          <linearGradient id="bucketBlue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0d2b48" />
            <stop offset="100%" stopColor="#061827" />
          </linearGradient>
          <linearGradient id="bucketRed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3a0d18" />
            <stop offset="100%" stopColor="#1f060d" />
          </linearGradient>
          <radialGradient id="ballCyan" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#a8f0ff" />
            <stop offset="100%" stopColor="#00b8d4" />
          </radialGradient>
          <radialGradient id="ballMagenta" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffb0e8" />
            <stop offset="100%" stopColor="#d436a0" />
          </radialGradient>
        </defs>

        {/* Board background */}
        <rect x="0" y="0" width="500" height="540" fill="url(#boardBg)" />

        {/* Side rails (subtle visual frame) */}
        <rect x="0" y="0" width="2" height="540" fill="#00e5ff" opacity="0.25" />
        <rect x="498" y="0" width="2" height="540" fill="#ff4fd8" opacity="0.25" />

        {/* Pegs */}
        {PEGS.map((peg, i) => (
          <circle
            key={i}
            cx={peg.x}
            cy={peg.y}
            r={PEG_RADIUS}
            fill="#a8e8ff"
            opacity="0.85"
          />
        ))}

        {/* Bucket row */}
        {BUCKETS.map((b) => {
          const isHighlighted =
            highlightBucket && highlightBucket.index === b.index;
          return (
            <g key={b.index}>
              <rect
                x={b.xMin + 1}
                y={BOARD.bucketY}
                width={b.xMax - b.xMin - 2}
                height={BOARD.height - BOARD.bucketY}
                fill={bucketFill(b.basePoints)}
                stroke={
                  isHighlighted
                    ? highlightBucket!.side === "p1"
                      ? "#00e5ff"
                      : "#ff4fd8"
                    : bucketStroke(b.basePoints)
                }
                strokeWidth={isHighlighted ? 2.5 : 1}
                opacity={isHighlighted ? 1 : 0.92}
              />
              <text
                x={b.xMin + (b.xMax - b.xMin) / 2}
                y={BOARD.bucketY + 28}
                textAnchor="middle"
                fontSize="14"
                fontWeight="700"
                fill={bucketStroke(b.basePoints)}
                opacity="0.95"
              >
                {b.basePoints}
              </text>
              <text
                x={b.xMin + (b.xMax - b.xMin) / 2}
                y={BOARD.bucketY + 45}
                textAnchor="middle"
                fontSize="7"
                fontWeight="600"
                fill="white"
                opacity="0.55"
                letterSpacing="0.5"
              >
                {b.label.replace(/_/g, " ").toUpperCase()}
              </text>
            </g>
          );
        })}

        {/* Bucket-row separator line */}
        <line
          x1="0"
          y1={BOARD.bucketY}
          x2="500"
          y2={BOARD.bucketY}
          stroke="#00e5ff"
          strokeWidth="1"
          opacity="0.3"
        />

        {/* Ball p2 (magenta) — drawn first so p1 sits on top in the
            rare case both balls overlap at the bucket row. */}
        {p2BallPos && (
          <g>
            <circle
              cx={p2BallPos.x}
              cy={p2BallPos.y}
              r={BALL_RADIUS + 2}
              fill="#ff4fd8"
              opacity="0.25"
            />
            <circle
              cx={p2BallPos.x}
              cy={p2BallPos.y}
              r={BALL_RADIUS}
              fill="url(#ballMagenta)"
              stroke="#fff"
              strokeWidth="1.5"
            />
          </g>
        )}

        {/* Ball p1 (cyan) */}
        {p1BallPos && (
          <g>
            <circle
              cx={p1BallPos.x}
              cy={p1BallPos.y}
              r={BALL_RADIUS + 2}
              fill="#00e5ff"
              opacity="0.25"
            />
            <circle
              cx={p1BallPos.x}
              cy={p1BallPos.y}
              r={BALL_RADIUS}
              fill="url(#ballCyan)"
              stroke="#fff"
              strokeWidth="1.5"
            />
          </g>
        )}
      </svg>
    </div>
  );
}

// ── Commit panel: 3 sliders + Launch button ──────────────────────────

function CommitPanel({
  startX,
  setStartX,
  power,
  setPower,
  angleDeg,
  setAngleDeg,
  onLaunch,
  busy,
  disabled,
  lockedHint,
  opponentHint,
}: {
  startX: number;
  setStartX: (v: number) => void;
  power: number;
  setPower: (v: number) => void;
  angleDeg: number;
  setAngleDeg: (v: number) => void;
  onLaunch: () => void;
  busy: boolean;
  disabled: boolean;
  lockedHint: string | null;
  opponentHint: string | null;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-cyan-300/30 bg-gradient-to-br from-[#001a33] to-[#000a14] p-4 shadow-[0_0_30px_rgba(0,229,255,0.1)]">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* startX slider */}
        <div>
          <div className="flex items-center justify-between text-xs text-cyan-200/80 mb-1">
            <span className="font-semibold uppercase tracking-wider">Start X</span>
            <span className="text-cyan-300 font-bold tabular-nums">
              {Math.round(startX)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={500}
            step={1}
            value={startX}
            onChange={(e) => setStartX(Number(e.target.value))}
            disabled={disabled}
            className="w-full accent-cyan-400"
            aria-label="Start X position"
          />
          <div className="flex justify-between text-[10px] text-white/40 mt-0.5">
            <span>0</span>
            <span>250</span>
            <span>500</span>
          </div>
        </div>
        {/* power slider */}
        <div>
          <div className="flex items-center justify-between text-xs text-cyan-200/80 mb-1">
            <span className="font-semibold uppercase tracking-wider">Power</span>
            <span className="text-cyan-300 font-bold tabular-nums">
              {Math.round(power)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={power}
            onChange={(e) => setPower(Number(e.target.value))}
            disabled={disabled}
            className="w-full accent-cyan-400"
            aria-label="Launch power"
          />
          <div className="flex justify-between text-[10px] text-white/40 mt-0.5">
            <span>0</span>
            <span>50</span>
            <span>100</span>
          </div>
        </div>
        {/* angleDeg slider */}
        <div>
          <div className="flex items-center justify-between text-xs text-cyan-200/80 mb-1">
            <span className="font-semibold uppercase tracking-wider">
              Angle (°)
            </span>
            <span className="text-cyan-300 font-bold tabular-nums">
              {Math.round(angleDeg)}
            </span>
          </div>
          <input
            type="range"
            min={-45}
            max={45}
            step={1}
            value={angleDeg}
            onChange={(e) => setAngleDeg(Number(e.target.value))}
            disabled={disabled}
            className="w-full accent-cyan-400"
            aria-label="Launch angle in degrees"
          />
          <div className="flex justify-between text-[10px] text-white/40 mt-0.5">
            <span>-45°</span>
            <span>0°</span>
            <span>+45°</span>
          </div>
        </div>
      </div>

      {/* Hints + Launch button */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex-1 min-w-[200px]">
          {lockedHint ? (
            <p className="text-xs text-yellow-300 inline-flex items-center gap-1">
              <CheckIcon className="w-3.5 h-3.5" /> {lockedHint}
            </p>
          ) : opponentHint ? (
            <p className="text-xs text-fuchsia-300 inline-flex items-center gap-1">
              <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />{" "}
              {opponentHint}
            </p>
          ) : (
            <p className="text-xs text-white/50">
              Set your inputs and launch before the 20s timer expires — the
              server will auto-fire a safe mid-board shot if you don&apos;t.
            </p>
          )}
        </div>
        <button
          onClick={onLaunch}
          disabled={disabled || busy}
          className={`px-6 py-2.5 rounded-xl font-bold text-sm transition shadow-[0_0_18px_rgba(0,229,255,0.45)] ${
            disabled || busy
              ? "bg-white/10 text-white/40 cursor-not-allowed"
              : "bg-gradient-to-r from-cyan-400 to-fuchsia-400 text-[#001933] hover:from-cyan-300 hover:to-fuchsia-300"
          }`}
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <LoadingDotsIcon className="w-4 h-4" /> Launching…
            </span>
          ) : (
            "Launch ball"
          )}
        </button>
      </div>
    </div>
  );
}

// ── Page component ───────────────────────────────────────────────────
//
// BUG-FIX ("both players stuck in loading mode when starting a game"):
// Next.js 15+/16 makes the dynamic `params` prop a Promise, not a plain
// object. The original page declared `params: { matchId: string }` and did
// `Number(params.matchId)`, which silently became `NaN` (Promises don't
// have a `matchId` accessor). The `fetchStatus` guard then early-returned
// *before* entering the try block, so the `finally { setLoading(false) }`
// never fired — both players were permanently pinned to the
// "Loading match…" spinner. Mirror the fix from
// src/app/casino/mines-pvp/[matchId]/page.tsx: unwrap `params` with
// React's `use()`, derive a nullable `matchId` + `isValidMatchId`
// guard, and tighten the `fetchStatus` early-return paths so every one
// of them still flips `loading=false` (route the error to the existing
// "Match not found" / "Invalid match link" panel).

export default function PlinkoPvpMatchPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  // Memoize a stable Promise wrapping the raw `params` prop so `use()`
  // is callable unconditionally on every render (React rules-of-hooks).
  // `Promise.resolve(p)` flattens when `params` is itself a thenable;
  // wraps a plain object on older Next.js so the call is safe there too.
  // The grandparent <Suspense> boundary (Next.js default for dynamic
  // segments) covers the brief suspend.
  const paramsPromise = useMemo(
    () => Promise.resolve(params),
    [params],
  );
  const resolvedParams = use(paramsPromise);
  const rawMatchId =
    resolvedParams && typeof resolvedParams === "object"
      ? resolvedParams.matchId
      : undefined;
  const numericMatchId = Number(rawMatchId);
  // `matchId` is `null` until params resolve and on malformed URLs
  // (e.g. /casino/plinko/not-a-number). `isValidMatchId` gates every
  // API call below; the render block also short-circuits to the
  // "Invalid match link" panel on null.
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;
  const isValidMatchId = matchId !== null;
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();

  // ── Core match state ─────────────────────────────────────────────
  const [match, setMatch] = useState<NormalisedMatch | null>(null);
  const [rounds, setRounds] = useState<NormalisedRound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);

  // ── Local UI state ──────────────────────────────────────────────
  // Commit panel slider state. Initialised to safe mid-board values
  // (startX=250, power=50, angle=0) so a misclick is forgiven.
  const [startX, setStartX] = useState<number>(250);
  const [power, setPower] = useState<number>(50);
  const [angleDeg, setAngleDeg] = useState<number>(0);

  // Phase state machine — drives the dual-track animator and the
  // "between rounds" / "reveal" overlays. See the `phase` type
  // comment block above for the full state diagram.
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Animated ball positions. Null = no ball on the board. The
  // dual-track animator (`animateBall`) writes to these refs'
  // mirrored state setters.
  const [p1BallPos, setP1BallPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [p2BallPos, setP2BallPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Bucket highlight for the most recent ball resolution. Null
  // when no ball has resolved yet (or after the between-rounds
  // banner dismisses).
  const [highlightBucket, setHighlightBucket] = useState<{
    index: number;
    side: "p1" | "p2";
  } | null>(null);

  // Set of ball numbers whose drop animation has already played.
  // Prevents double-animation on /status polls after a launch
  // already triggered an animation.
  const animatedBallNumbersRef = useRef<Set<number>>(new Set());

  // Refs for cancel functions so the React effect can abort an
  // in-flight animation when the component unmounts or a new
  // animation supersedes it.
  const p1AnimCancelRef = useRef<(() => void) | null>(null);
  const p2AnimCancelRef = useRef<(() => void) | null>(null);

  // Refs that mirror the latest values for the animation effect.
  // Using refs (not state) inside useEffect avoids stale-closure
  // issues when the effect re-fires on dependency changes.
  const phaseRef = useRef(phase);
  const roundsRef = useRef(rounds);
  const matchRef = useRef(match);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    roundsRef.current = rounds;
  }, [rounds]);
  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  // Guards for "fire-once" Posthog events.
  const resolvedFiredRef = useRef(false);

  // ── Status fetch ─────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    // BUG-FIX: the original guard was
    // `if (!isSignedIn || !Number.isFinite(matchId)) return;` — that
    // early `return` skipped the `finally { setLoading(false) }`, so
    // any page mount where `isSignedIn` was undefined (Clerk still
    // warming up) or `matchId` wasn't a finite number left the user
    // pinned to the "Loading match…" spinner. We now branch + flip
    // `loading=false` so the existing `if (!match)` render path
    // renders the "Invalid match link" / "Match not found" panel.
    // Clerk reports `isSignedIn` only AFTER it loads; before that the
    // value is `undefined`, which would have triggered the early
    // return below and dumped the user onto the "Match not found"
    // panel for the ~hundreds of ms Clerk takes to decide. We now
    // distinguish "loaded + signed out" (real sign-out → error) from
    // "loaded + signed in" (poll normally). While Clerk is still
    // deciding we hold `loading=true` so the spinner stays put.
    if (isSignedIn === false) {
      setLoading(false);
      setError("You must be signed in to view this match.");
      return;
    }
    if (isSignedIn !== true) {
      return;
    }
    if (!isValidMatchId) {
      setLoading(false);
      setError("Invalid match link.");
      return;
    }
    try {
      const res = await fetch(`/api/plinko-pvp/match/${matchId}`, {
        cache: "no-store",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Unable to load match");
        return;
      }
      // Defensive null-check: API contract says `data.data.match` is
      // the match row OR null; never undefined. Guard against malformed
      // frames so we always end up on a defined UI state instead of an
      // unhandled object.
      const nextMatch =
        data?.data?.match && typeof data.data.match === "object"
          ? data.data.match
          : null;
      setMatch(nextMatch);
      setRounds(Array.isArray(data?.data?.rounds) ? data.data.rounds : []);
      // A successful response always wins over any stale tick error.
      setError(nextMatch ? null : "Match not found.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, isValidMatchId, matchId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 1500);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // ── Socket subscription ──────────────────────────────────────────
  // BUG-FIX: don't try to subscribe until params resolved into a real
  // matchId — `plinkoPvpMatchRoom(null)` would emit junk into the
  // "plinko-pvp:match:null" room and pollute other clients.
  useEffect(() => {
    if (!socket) return;
    if (!isValidMatchId) return;
    const refresh = () => fetchStatus();
    const roomId = plinkoPvpMatchRoom(matchId);
    socket.emit("join_room", { roomId });
    socket.on(PLINKO_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off(PLINKO_PVP_MATCH_UPDATED, refresh);
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

  // ── Phase reset on status transitions ────────────────────────────
  // When the server flips back to a launchable state (e.g. ball_1
  // after the ready window, or ball_N+1 after a between-rounds
  // transition), reset the local phase to 'idle' so the commit
  // panel becomes interactive again. The transition window itself
  // is owned by the between-rounds effect below.
  useEffect(() => {
    if (!match) return;
    const launchable =
      match.status === MATCH_STATUS.BALL_1 ||
      match.status === MATCH_STATUS.BALL_2 ||
      match.status === MATCH_STATUS.BALL_3;
    // Only reset to 'idle' if we're not actively animating or
    // transitioning — the launch handler owns the phase during
    // those windows.
    if (
      launchable &&
      phaseRef.current !== "animating" &&
      phaseRef.current !== "transitioning" &&
      phaseRef.current !== "launching"
    ) {
      setPhase("idle");
      // Clear the bucket highlight + ball positions from any
      // previous ball so the board resets visually.
      setHighlightBucket(null);
      setP1BallPos(null);
      setP2BallPos(null);
    }
    if (match.status === MATCH_STATUS.FINISHED && phaseRef.current !== "finished") {
      setPhase("finished");
    }
    if (match.status === MATCH_STATUS.CANCELLED && phaseRef.current !== "cancelled") {
      setPhase("cancelled");
    }
  }, [match?.status, match?.currentBall]);

  // ── Animation effect: detect newly-resolved balls on /status ───
  // The /status response includes the rounds history. Whenever a
  // new round appears (the opponent's commit triggered resolve
  // while we waited), animate BOTH players' paths on the board.
  // `animatedBallNumbersRef` prevents re-animation on subsequent
  // polls of the same round.
  useEffect(() => {
    if (rounds.length === 0) return;
    if (phaseRef.current === "animating" || phaseRef.current === "launching") {
      // The launch effect is driving the animation; defer to it.
      return;
    }
    const newRounds = rounds.filter(
      (r) => !animatedBallNumbersRef.current.has(r.ballNumber),
    );
    if (newRounds.length === 0) return;
    // Animate only the most recent new round (the older ones
    // were already played on earlier visits).
    const target = newRounds[newRounds.length - 1];
    animatedBallNumbersRef.current.add(target.ballNumber);
    startDualTrackAnimation(target.player1Result, target.player2Result, target.ballNumber);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds]);

  // Start BOTH ball animations concurrently. `p1Done` and
  // `p2Done` track per-track completion so the parent can advance
  // the phase to 'transitioning' (or 'finished') only after both
  // balls have settled.
  const startDualTrackAnimation = useCallback(
    (
      p1Result: BallResult,
      p2Result: BallResult,
      ballNumber: number,
    ) => {
      // Cancel any in-flight animation from a previous ball.
      if (p1AnimCancelRef.current) p1AnimCancelRef.current();
      if (p2AnimCancelRef.current) p2AnimCancelRef.current();
      p1AnimCancelRef.current = null;
      p2AnimCancelRef.current = null;

      // Seed the ball positions at the spawn point so the user
      // sees both balls drop from the top in lockstep (instead
      // of popping in mid-air if the spawn was scrolled off).
      if (p1Result.path.length > 0) {
        setP1BallPos({ x: p1Result.path[0].x, y: p1Result.path[0].y });
      }
      if (p2Result.path.length > 0) {
        setP2BallPos({ x: p2Result.path[0].x, y: p2Result.path[0].y });
      }
      setHighlightBucket(null);

      setPhase("animating");

      let p1Done = false;
      let p2Done = false;
      const maybeAdvancePhase = () => {
        if (p1Done && p2Done) {
          // Highlight the buckets each ball landed in. If both
          // balls land in the same bucket, prefer p2's ring so
          // it overlays p1's. Compute the final value once
          // before the setState call to avoid a 1-frame flash
          // of p1's ring before p2's overwrites it.
          if (p2Result.bucketIndex >= 0) {
            setHighlightBucket({
              index: p2Result.bucketIndex,
              side: "p2",
            });
          } else if (p1Result.bucketIndex >= 0) {
            setHighlightBucket({
              index: p1Result.bucketIndex,
              side: "p1",
            });
          } else {
            setHighlightBucket(null);
          }
          // If this was the final ball, jump to the finished
          // phase after a short delay so the bucket highlight
          // is visible. Otherwise show the between-rounds
          // banner for BETWEEN_BALLS_MS.
          if (ballNumber >= REQUIRED_BALLS) {
            setTimeout(() => setPhase("finished"), 800);
          } else {
            setPhase("transitioning");
            setTimeout(() => {
              setPhase("idle");
              setP1BallPos(null);
              setP2BallPos(null);
              setHighlightBucket(null);
              // Refresh /status so the new ball's status is
              // reflected in the UI (the server already advanced,
              // but a fresh fetch keeps the polls tight).
              fetchStatus();
            }, BETWEEN_BALLS_MS);
          }
        }
      };

      p1AnimCancelRef.current = animateBall(
        p1Result.path,
        (p) => setP1BallPos(p),
        () => {
          p1AnimCancelRef.current = null;
          p1Done = true;
          maybeAdvancePhase();
        },
      );
      p2AnimCancelRef.current = animateBall(
        p2Result.path,
        (p) => setP2BallPos(p),
        () => {
          p2AnimCancelRef.current = null;
          p2Done = true;
          maybeAdvancePhase();
        },
      );
    },
    [fetchStatus],
  );

  // ── Launch handler ──────────────────────────────────────────────
  const handleLaunch = useCallback(async () => {
    // BUG-FIX: also bail out if matchId never resolved — without this
    // guard the `/api/plinko-pvp/match/${null}/launch` URL would 404
    // and leave `loading=true` if the user is somehow mid-mount when
    // params are still resolving.
    if (busy || !match || !isValidMatchId) return;
    if (!match.viewerCanLaunch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/plinko-pvp/match/${matchId}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ startX, power, angleDeg }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Launch failed");
        return;
      }
      const myResult = data.data.myResult as BallResult | null;
      const p1Result = data.data.p1Result as BallResult | null;
      const p2Result = data.data.p2Result as BallResult | null;
      const justResolved = Boolean(data.data.justResolved);
      const raced = Boolean(data.data.raced);

      // Belt-and-braces: also fan out the broadcast via the
      // socket so the opponent's match view refetches inside
      // ~50ms instead of waiting for the 1.5s poll. The
      // server already broadcasts via broadcastMatchUpdate,
      // but re-broadcasting here keeps the local viewer's UI
      // tight (in case they're in a different process).
      socket?.emit("room_event", {
        roomId: plinkoPvpMatchRoom(matchId),
        event: PLINKO_PVP_MATCH_UPDATED,
      });
      socket?.emit("room_event", {
        roomId: PLINKO_PVP_LOBBY_ROOM,
        event: PLINKO_PVP_MATCH_UPDATED,
      });

      posthog?.capture("plinko_pvp_ball_launched", {
        match_id: match?.id ?? matchId ?? -1,
        ball_number: match.currentBall,
        seat: match.viewerSeat,
        start_x: Math.round(startX),
        power: Math.round(power),
        angle_deg: Math.round(angleDeg),
        just_resolved: justResolved,
        raced,
      });

      if (raced) {
        // Lost a race to a concurrent commit (same player,
        // different tab). Re-fetch status to see actual state.
        await fetchStatus();
        return;
      }

      // Animate the caller's own ball immediately using
      // myResult. If justResolved, also animate the opponent's
      // ball on the second track.
      if (myResult && myResult.path.length > 0) {
        if (
          justResolved &&
          p1Result &&
          p2Result &&
          // Race guard: if a /status poll already landed the
          // rounds row while our launch POST was in flight, the
          // rounds effect has already animated this ball number
          // and added it to the set. Skip the launch-time
          // animation in that case to avoid a visible stutter
          // (ball resets to spawn, drops again).
          !animatedBallNumbersRef.current.has(match.currentBall)
        ) {
          // The server has both players' cached results — use
          // them directly to dual-track the drop without
          // waiting for the /status poll to land the rounds
          // row. Mark this ball as animated so the effect
          // above doesn't double-animate when the rounds row
          // arrives on the next poll.
          animatedBallNumbersRef.current.add(match.currentBall);
          startDualTrackAnimation(p1Result, p2Result, match.currentBall);
        } else {
          // Only the caller's ball is in flight — animate just
          // that one. The opponent's animation will play when
          // the next /status poll lands the rounds row.
          setPhase("animating");
          if (p1AnimCancelRef.current) p1AnimCancelRef.current();
          p1AnimCancelRef.current = null;
          setP1BallPos({ x: myResult.path[0].x, y: myResult.path[0].y });
          const isP1 = match.viewerIsPlayer1;
          const setter = isP1 ? setP1BallPos : setP2BallPos;
          p1AnimCancelRef.current = animateBall(
            myResult.path,
            (p) => setter(p),
            () => {
              p1AnimCancelRef.current = null;
              // If the opponent hasn't committed yet, show
              // the "waiting for opponent" state. The phase
              // stays 'animating' (visually) until the
              // /status poll lands the resolve.
              setPhase("idle");
              if (myResult.bucketIndex >= 0) {
                setHighlightBucket({
                  index: myResult.bucketIndex,
                  side: isP1 ? "p1" : "p2",
                });
              }
              // Refresh to get the opponent's commit (if it
              // happened in parallel).
              fetchStatus();
            },
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    match,
    matchId,
    startX,
    power,
    angleDeg,
    socket,
    posthog,
    fetchStatus,
    startDualTrackAnimation,
  ]);

  // ── Cancel handler ──────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    // BUG-FIX: also bail out if matchId never resolved — same reason
    // as handleLaunch above.
    if (cancelling || !isValidMatchId) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/plinko-pvp/match/${matchId}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data?.error || "Cancel failed");
        return;
      }
      posthog?.capture("plinko_pvp_lobby_cancelled", {
        match_id: matchId ?? -1,
      });
      router.push("/casino/plinko");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, matchId, posthog, router]);

  // ── Cleanup on unmount ─────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (p1AnimCancelRef.current) p1AnimCancelRef.current();
      if (p2AnimCancelRef.current) p2AnimCancelRef.current();
    };
  }, []);

  // ── Posthog: match-just-resolved ───────────────────────────────
  useEffect(() => {
    if (!match || match.status !== MATCH_STATUS.FINISHED) {
      if (resolvedFiredRef.current) resolvedFiredRef.current = false;
      return;
    }
    if (resolvedFiredRef.current) return;
    resolvedFiredRef.current = true;

    const isDraw = match.result === RESULT.TIE;
    const iWon = Boolean(
      match.winnerId && user?.id && match.winnerId === user.id,
    );
    const winner = isDraw ? "draw" : iWon ? "you" : "opponent";
    posthog?.capture("plinko_pvp_match_resolved", {
      match_id: match?.id ?? matchId ?? -1,
      winner,
      result: match.result,
      stake: match.stakeAmount.toFixed(2),
      prize_paid: match.prizePaid.toFixed(2),
      house_fee: match.houseFee.toFixed(2),
      p1_score: match.p1Score,
      p2_score: match.p2Score,
    });
  }, [match, matchId, user?.id, posthog]);

  // ── Derived UI state ─────────────────────────────────────────────
  const myUserId = user?.id;
  const isParticipant = match?.viewerIsParticipant ?? false;
  const isPlayer1 = match?.viewerIsPlayer1 ?? false;
  const mySeat = isPlayer1 ? "player1" : "player2";
  const stake = match?.stakeAmount ?? 0;

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
            onClick={() => router.push("/casino/plinko")}
            className="mt-4 px-4 py-2 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold"
          >
            Back to lobby
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  if (!isParticipant) {
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
            onClick={() => router.push("/casino/plinko")}
            className="mt-4 px-4 py-2 rounded-lg bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold"
          >
            Back to lobby
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  // ── Status banner (turn indicator / ready / cancelled) ──────────
  const isFinished = match.status === MATCH_STATUS.FINISHED;
  const isCancelled = match.status === MATCH_STATUS.CANCELLED;
  const isReady = match.status === MATCH_STATUS.READY;
  const isWaiting = match.status === MATCH_STATUS.WAITING;
  const isLaunchable =
    match.status === MATCH_STATUS.BALL_1 ||
    match.status === MATCH_STATUS.BALL_2 ||
    match.status === MATCH_STATUS.BALL_3;
  const urgent = timeLeft > 0 && timeLeft <= 5;

  function renderStatusBanner() {
    if (isCancelled) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-4 py-3 text-red-200">
          <AlertIcon className="w-5 h-5 text-red-300" />
          <span className="font-semibold">This match was cancelled.</span>
        </div>
      );
    }
    if (isFinished) return null; // Reveal screen handles this.
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
            Both players joined — starting in
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/30 px-3 py-1 text-sm font-bold text-cyan-100">
            <ClockIcon className="w-4 h-4" />
            {Math.max(0, Math.ceil(timeLeft)) || 3}s
          </span>
        </div>
      );
    }
    if (isLaunchable) {
      if (match.viewerCanLaunch) {
        return (
          <div
            className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border px-4 py-3 ${
              urgent
                ? "border-red-400/60 bg-red-900/30 text-red-200 animate-pulse"
                : "border-cyan-300/40 bg-cyan-500/10 text-cyan-200"
            }`}
          >
            <span className="font-bold text-base sm:text-lg">
              Your turn — set inputs and launch
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold ${
                urgent
                  ? "bg-red-500/30 text-red-100"
                  : "bg-cyan-500/30 text-cyan-100"
              }`}
            >
              <ClockIcon className="w-4 h-4" />
              {timeLeft}s
            </span>
          </div>
        );
      }
      if (match.viewerHasCommitted) {
        return (
          <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-yellow-300/40 bg-yellow-500/10 px-4 py-3 text-yellow-200">
            <span className="font-bold text-base sm:text-lg">
              Ball locked in — waiting for opponent
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/30 px-3 py-1 text-sm font-bold text-yellow-100">
              <ClockIcon className="w-4 h-4" />
              {timeLeft}s
            </span>
          </div>
        );
      }
      return (
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-fuchsia-300/40 bg-fuchsia-500/10 px-4 py-3 text-fuchsia-200">
          <span className="font-bold text-base sm:text-lg">
            Opponent is choosing inputs…
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-fuchsia-500/30 px-3 py-1 text-sm font-bold text-fuchsia-100">
            <ClockIcon className="w-4 h-4" />
            {timeLeft}s
          </span>
        </div>
      );
    }
    return null;
  }

  // ── Scoreboard sub-component (inline so we can use the parent's
  // match state directly) ─────────────────────────────────────────
  function renderScoreboard() {
    const ballCount = REQUIRED_BALLS;
    const playedSoFar = rounds.length;
    return (
      <div className="mt-4 grid grid-cols-3 gap-3 items-stretch">
        {/* p1 */}
        <div
          className={`rounded-2xl border p-3 text-center transition-all ${
            isPlayer1
              ? "border-cyan-300/50 bg-cyan-500/10 shadow-[0_0_20px_rgba(0,229,255,0.25)]"
              : "border-cyan-300/20 bg-cyan-500/5"
          }`}
        >
          <p className="text-[10px] uppercase tracking-wider text-cyan-200/70">
            P1{isPlayer1 ? " · You" : ""}
          </p>
          <p className="mt-0.5 text-2xl sm:text-3xl font-black text-cyan-200 tabular-nums">
            {match.p1Score}
          </p>
          <div className="mt-1.5 flex justify-center gap-1">
            {Array.from({ length: ballCount }, (_, i) => {
              const ballNumber = i + 1;
              const isPlayed = rounds.some((r) => r.ballNumber === ballNumber);
              const isCurrent =
                match.currentBall === ballNumber && !isPlayed;
              return (
                <span
                  key={i}
                  className={`w-2 h-2 rounded-full ${
                    isPlayed
                      ? "bg-cyan-300 shadow-[0_0_6px_rgba(0,229,255,0.7)]"
                      : isCurrent
                        ? "bg-cyan-300/50 animate-pulse"
                        : "bg-cyan-300/20"
                  }`}
                />
              );
            })}
          </div>
        </div>
        {/* middle: ball counter */}
        <div className="flex flex-col items-center justify-center text-center">
          <p className="text-[10px] uppercase tracking-wider text-white/50">
            Ball
          </p>
          <p className="text-3xl sm:text-4xl font-black text-white tabular-nums">
            {match.currentBall}
            <span className="text-white/40 text-lg">/{ballCount}</span>
          </p>
        </div>
        {/* p2 */}
        <div
          className={`rounded-2xl border p-3 text-center transition-all ${
            !isPlayer1
              ? "border-fuchsia-300/50 bg-fuchsia-500/10 shadow-[0_0_20px_rgba(255,79,216,0.25)]"
              : "border-fuchsia-300/20 bg-fuchsia-500/5"
          }`}
        >
          <p className="text-[10px] uppercase tracking-wider text-fuchsia-200/70">
            P2{!isPlayer1 ? " · You" : ""}
          </p>
          <p className="mt-0.5 text-2xl sm:text-3xl font-black text-fuchsia-200 tabular-nums">
            {match.p2Score}
          </p>
          <div className="mt-1.5 flex justify-center gap-1">
            {Array.from({ length: ballCount }, (_, i) => {
              const ballNumber = i + 1;
              const isPlayed = rounds.some((r) => r.ballNumber === ballNumber);
              const isCurrent =
                match.currentBall === ballNumber && !isPlayed;
              return (
                <span
                  key={i}
                  className={`w-2 h-2 rounded-full ${
                    isPlayed
                      ? "bg-fuchsia-300 shadow-[0_0_6px_rgba(255,79,216,0.7)]"
                      : isCurrent
                        ? "bg-fuchsia-300/50 animate-pulse"
                        : "bg-fuchsia-300/20"
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Between-rounds banner ──────────────────────────────────────
  function renderBetweenBallsBanner() {
    if (phase !== "transitioning") return null;
    const nextBall = match.currentBall;
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="mt-4 rounded-2xl border border-cyan-300/40 bg-gradient-to-br from-cyan-500/15 to-fuchsia-500/15 p-5 text-center shadow-[0_0_40px_rgba(0,229,255,0.2)]"
      >
        <p className="text-[10px] uppercase tracking-widest text-cyan-200/70">
          Ball {nextBall - 1} resolved
        </p>
        <h3 className="mt-1 text-2xl sm:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 via-cyan-300 to-fuchsia-300">
          Ball {nextBall} incoming…
        </h3>
        <div className="mt-3 flex items-center justify-center gap-2 text-sm text-white/70">
          <LoadingDotsIcon className="w-4 h-4 animate-pulse text-cyan-300" />
          <span>Next commit window opens in a moment</span>
        </div>
      </motion.div>
    );
  }

  // ── Reveal screen ──────────────────────────────────────────────
  function renderReveal() {
    if (phase !== "finished") return null;
    const isDraw = match.result === RESULT.TIE;
    const iWon = match.winnerId && match.winnerId === myUserId;
    const iLost =
      !isDraw && match.winnerId && myUserId && match.winnerId !== myUserId;
    const headline = isDraw
      ? "Draw"
      : iWon
        ? "You won!"
        : iLost
          ? "You lost"
          : "Match complete";
    const headlineColor = isDraw
      ? "text-yellow-300"
      : iWon
        ? "text-emerald-300"
        : iLost
          ? "text-red-300"
          : "text-white";
    const headlineEmoji = isDraw ? "🤝" : iWon ? "🏆" : iLost ? "💣" : "✅";
    const headlineBg = isDraw
      ? "from-[#1a1a3a] to-[#0d0d2b] border-yellow-300/40 shadow-[0_0_60px_rgba(255,221,0,0.25)]"
      : iWon
        ? "from-[#0d2b1a] to-[#062a16] border-emerald-300/50 shadow-[0_0_60px_rgba(72,209,154,0.35)]"
        : iLost
          ? "from-[#3a1a1a] to-[#2b0d0d] border-red-500/40 shadow-[0_0_60px_rgba(239,68,68,0.3)]"
          : "from-[#0a1a3a] to-[#04102a] border-cyan-300/40";

    const houseFee = match.houseFee;
    const prizePaid = match.prizePaid;

    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className={`mt-4 rounded-3xl border-2 bg-gradient-to-b p-6 text-center ${headlineBg}`}
      >
        <motion.div
          initial={{ scale: 0, rotate: -25 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.1 }}
          className="mb-2 text-7xl"
        >
          {headlineEmoji}
        </motion.div>
        <h2
          className={`mt-3 text-3xl sm:text-4xl font-black uppercase ${headlineColor}`}
        >
          {headline}
        </h2>
        <p className="mt-1 text-sm text-white/70">
          {isDraw
            ? "Both totals equal — full refund, no house fee."
            : iWon
              ? `You took home ${prizePaid.toFixed(2)} tokens (your stake + 90% of opponent's).`
              : iLost
                ? `You lost your ${stake.toFixed(2)} stake. House kept ${houseFee.toFixed(2)}.`
                : "Result recorded."}
        </p>

        {/* Payout breakdown */}
        <div className="mt-4 grid grid-cols-3 gap-2 text-xs sm:text-sm">
          <div className="rounded-lg border border-white/10 bg-black/30 p-2">
            <p className="text-[10px] uppercase tracking-wider text-white/45">
              Stake
            </p>
            <p className="font-bold text-white">{stake.toFixed(2)}</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 p-2">
            <p className="text-[10px] uppercase tracking-wider text-white/45">
              Prize
            </p>
            <p
              className={`font-bold ${prizePaid > 0 ? "text-emerald-300" : "text-white/50"}`}
            >
              {prizePaid.toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 p-2">
            <p className="text-[10px] uppercase tracking-wider text-white/45">
              House
            </p>
            <p
              className={`font-bold ${houseFee > 0 ? "text-fuchsia-300" : "text-white/50"}`}
            >
              {houseFee.toFixed(2)}
            </p>
          </div>
        </div>

        {/* Per-ball audit */}
        {rounds.length > 0 && (
          <div className="mt-4 text-left">
            <p className="text-[10px] uppercase tracking-widest text-white/45 mb-2">
              Per-ball audit
            </p>
            <div className="space-y-1.5">
              {rounds.map((r) => {
                const p1Bucket = BUCKETS[r.player1Result.bucketIndex] ?? null;
                const p2Bucket = BUCKETS[r.player2Result.bucketIndex] ?? null;
                const p1Won = r.ballOutcome === "p1";
                const p2Won = r.ballOutcome === "p2";
                const tied = r.ballOutcome === "tie";
                return (
                  <div
                    key={r.id}
                    className="rounded-lg border border-white/10 bg-black/30 p-2 text-xs"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-white/80">
                        Ball {r.ballNumber}
                      </span>
                      <span
                        className={`font-semibold ${
                          p1Won
                            ? "text-cyan-300"
                            : p2Won
                              ? "text-fuchsia-300"
                              : "text-yellow-300"
                        }`}
                      >
                        {p1Won
                          ? "P1 won"
                          : p2Won
                            ? "P2 won"
                            : "Tied"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-cyan-300" />
                        <span className="text-cyan-200 tabular-nums">
                          P1: {r.ballPointsPlayer1} pts
                        </span>
                        <span className="text-white/40">
                          (
                          {p1Bucket
                            ? p1Bucket.label.replace(/_/g, " ")
                            : r.player1Result.fellOut
                              ? "fell out"
                              : "—"}
                          )
                        </span>
                        {r.player1AutoLaunched && (
                          <span className="rounded bg-yellow-300/20 px-1.5 py-0.5 text-[9px] font-bold text-yellow-200">
                            AFK
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-fuchsia-300" />
                        <span className="text-fuchsia-200 tabular-nums">
                          P2: {r.ballPointsPlayer2} pts
                        </span>
                        <span className="text-white/40">
                          (
                          {p2Bucket
                            ? p2Bucket.label.replace(/_/g, " ")
                            : r.player2Result.fellOut
                              ? "fell out"
                              : "—"}
                          )
                        </span>
                        {r.player2AutoLaunched && (
                          <span className="rounded bg-yellow-300/20 px-1.5 py-0.5 text-[9px] font-bold text-yellow-200">
                            AFK
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => router.push("/casino/plinko")}
            className="px-5 py-2.5 rounded-xl bg-cyan-400 text-[#001933] hover:bg-cyan-300 text-sm font-bold shadow-[0_0_18px_rgba(0,229,255,0.5)] transition"
          >
            Back to lobby
          </button>
          <button
            onClick={() => router.push("/casino")}
            className="px-5 py-2.5 rounded-xl border border-cyan-300/40 bg-transparent text-cyan-200 hover:bg-cyan-300/10 text-sm font-bold transition"
          >
            All games
          </button>
        </div>
      </motion.div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────
  const canCancel = match.viewerCanCancel && !cancelling;
  const showCommitPanel =
    isLaunchable &&
    phase === "idle" &&
    !isFinished;
  const commitDisabled =
    !match.viewerCanLaunch ||
    busy ||
    phase === "animating" ||
    phase === "transitioning" ||
    phase === "launching";
  const lockedHint = match.viewerHasCommitted
    ? `Ball ${match.currentBall} locked in — waiting for opponent`
    : null;
  const opponentHint = !match.viewerHasCommitted && match.opponentHasCommitted
    ? `Opponent launched for ball ${match.currentBall} — your turn`
    : null;

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-4 max-w-3xl sm:mt-8">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="flex items-center justify-center gap-3 text-center text-2xl sm:text-3xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 via-cyan-300 to-fuchsia-300 drop-shadow-[0_0_18px_rgba(0,229,255,0.55)]">
            <PlinkoIcon className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
            <span>Plinko Duel · Match #{matchId ?? "?"}</span>
          </h1>
        </motion.div>

        {/* Match info strip */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-white/60">
          <span className="inline-flex items-center gap-1">
            Stake:
            <span className="text-yellow-300 font-semibold inline-flex items-center gap-1">
              {stake.toLocaleString()}
              <CoinIcon className="w-3.5 h-3.5 text-yellow-300" />
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            Format:
            <span className="text-cyan-200 font-semibold">
              3 balls · best total
            </span>
          </span>
          <span>
            Seat:{" "}
            <span className="text-cyan-200 font-semibold">{mySeat}</span>
          </span>
        </div>

        {/* Turn indicator / status banner */}
        <div className="mt-4">{renderStatusBanner()}</div>

        {/* Error banner */}
        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            <AlertIcon className="w-4 h-4 text-red-300" />
            <span>{error}</span>
          </div>
        )}

        {/* Scoreboard */}
        {renderScoreboard()}

        {/* Board */}
        <div className="mt-4">
          <PlinkoBoard
            p1BallPos={p1BallPos}
            p2BallPos={p2BallPos}
            highlightBucket={highlightBucket}
          />
        </div>

        {/* Commit panel (only when interactive) */}
        {showCommitPanel && (
          <CommitPanel
            startX={startX}
            setStartX={setStartX}
            power={power}
            setPower={setPower}
            angleDeg={angleDeg}
            setAngleDeg={setAngleDeg}
            onLaunch={handleLaunch}
            busy={busy}
            disabled={commitDisabled}
            lockedHint={lockedHint}
            opponentHint={opponentHint}
          />
        )}

        {/* Between-rounds banner */}
        {renderBetweenBallsBanner()}

        {/* Host-only cancel button while still in waiting */}
        {canCancel && (
          <div className="mt-4 flex justify-center">
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25 text-sm font-bold transition disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Cancel lobby (refund stake)"}
            </button>
          </div>
        )}

        {/* Post-match reveal screen */}
        {renderReveal()}

        <Footer />
      </div>
    </div>
  );
}
