"use client";

// src/app/casino/plinko/[matchId]/page.tsx
//
// MATCH view for the Plinko Duel PvP system. Both players commit
// per-ball inputs (startX / power / angleDeg) and click "Ready" on a
// shared 500x540 plinko board; the server runs the deterministic
// physics simulator with elastic ball-on-ball collision when both
// seats are ready, caches the path, and resolves the ball as soon
// as both seats have readied. The client animates BOTH players'
// balls concurrently on the same board when a ball resolves.
//
// NEW LAYOUT (per spec):
//
//   ┌─ Title: Plinko Duel · Match #N ──────────────────────────────┐
//   ├─ Status banner: ready / waiting / finished announcement ───┤
//   ├─ 3-column grid (mobile: stacked vertically) ───────────────┤
//   │   ┌─ P1 panel ──┐  ┌─ Center board ┐  ┌─ P2 panel ──┐       │
//   │   │ name        │  │ ball counter  │  │ name          │      │
//   │   │ TOTAL pts   │  │ SVG board     │  │ TOTAL pts     │     │
//   │   │ ready chip  │  │ + dual balls  │  │ ready chip    │     │
//   │   │ startX ᐳ    │  │               │  │ startX ᐳ      │     │
//   │   │ power  ᐳ    │  │               │  │ power  ᐳ      │     │
//   │   │ angle  ᐳ    │  │               │  │ angle  ᐳ      │     │
//   │   │ [Ready] btn │  │               │  │ [Ready] btn   │     │
//   │   └─────────────┘  └───────────────┘  └───────────────┘     │
//   ├─ Between-rounds banner (3s "Ball N incoming…") ─────────────┤
//   ├─ Cancel button (host-only while waiting) ───────────────────┤
//   ├─ Reveal screen (when status='finished') ────────────────────┤
//   └─ Footer ─────────────────────────────────────────────────────┘
//

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
  PLINKO_PVP_READY,
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

const BALL_ANIMATION_MS = 2500;
const BETWEEN_BALLS_MS = 3000;

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

type PlayerHead = {
  id: string;
  displayName: string;
  profileImageUrl: string | null;
  missing?: boolean;
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
  p1Ready: boolean;
  p2Ready: boolean;
  roundDeadline: string | null;
  roundTimer: number;
  winnerId: string | null;
  result: string | null;
  prizePaid: number;
  houseFee: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  // Player heads from the users join — populated server-side via
  // enrichMatchesWithUsers. Replaces the old "show clerkId truncation"
  // behaviour that the user flagged as a bug.
  players: { p1: PlayerHead | null; p2: PlayerHead | null } | null;
  viewerUserId: string;
  viewerIsParticipant: boolean;
  viewerSeat: "player1" | "player2" | null;
  viewerIsPlayer1: boolean;
  viewerCanLaunch: boolean;
  viewerHasCommitted: boolean;
  opponentHasCommitted: boolean;
  viewerCanCancel: boolean;
};

// Configuration: what is the render opacity of a ball whose last
// recorded position went off-board (fall-out). Animated via
// framer-motion's CSS transitions on the SVG circle. Keeping the
// transition length in JSX lets us reuse it both for the live
// animated ball AND for the post-animation final position so the
// fall-out fade is consistent.
const FALL_OUT_FADE_MS = 350;

type NormalisedRound = {
  id: number;
  ballNumber: number;
  player1Inputs: { startX: number; power; number; angleDeg: number };
  player2Inputs: { startX; number; power: number; angleDeg: number };
  player1Result: BallResult;
  player2Result: BallResult;
  player1AutoLaunched: boolean;
  player2AutoLaunched: boolean;
  ballPointsPlayer1: number;
  ballPointsPlayer2: number;
  ballOutcome: "p1" | "p2" | "tie";
};

type Phase =
  | "idle"
  | "launching"
  | "animating"
  | "transitioning"
  | "finished"
  | "cancelled";

// ── Peg grid (mirror of the physics module's buildPegs) ───────────────

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
}const PEGS = buildPegs();

// ── Inline SVG icons ─────────────────────────────────────────────────

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

// ── Board sub-component ──────────────────────────────────────────────
//
// Per user feedback, the board now renders a launch "visor" at the top
// — two preview balls (one per seat) at the committed `startX`
// positions with a short translucent trajectory line indicating the
// initial angle/power — and the live balls fade out instead of
// sticking to the side wall when they fall out.

function PlinkoBoard({
  p1BallPos,
  p2BallPos,
  highlightBucket,
  p1FellOut = false,
  p2FellOut = false,
  p1Preview,
  p2Preview,
  showVisor = false,
}: {
  p1BallPos: { x: number; y: number } | null;
  p2BallPos: { x: number; y: number } | null;
  highlightBucket: { index: number; side: "p1" | "p2" } | null;
  p1FellOut?: boolean;
  p2FellOut?: boolean;
  p1Preview?: { startX: number; power: number; angleDeg: number } | null;
  p2Preview?: { startX: number; power: number; angleDeg: number } | null;
  showVisor?: boolean;
}) {
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
  // Visor helper: turn (startX, power, angleDeg) into a short sec
  // line that draws the initial trajectory. The line ends just
  // before the first peg row so we don't visually intersect with
  // the static pegs.
  const VISOR_Y = 12;
  const VISOR_LINE_PX = Math.min(38, Math.max(14, 6 + (Math.abs(p1Preview?.power ?? 50) / 100) * 32));
  function visorEnd(preview: { startX: number; power: number; angleDeg: number } | null | undefined, fallbackX: number) {
    if (!preview) return { x: fallbackX, y: VISOR_Y + VISOR_LINE_PX };
    const ang = (preview.angleDeg * Math.PI) / 180;
    // Same velocity math the simulator uses, just for a short
    // visual hint (does NOT affect physics).
    const px = preview.startX + Math.sin(ang) * VISOR_LINE_PX * 0.9;
    const py = VISOR_Y + Math.cos(ang) * VISOR_LINE_PX;
    return { x: Math.max(2, Math.min(498, px)), y: Math.max(VISOR_Y, Math.min(48, py)) };
  }
  // Offset logic: when both preview balls are at the same or
  // overlapping startX, nudge them apart so they sit side-by-side.
  // The physics module's simulateDualBalls already handles this
  // server-side — the visor just mirrors the visual positioning.
  const overlapOffset =
    p1Preview && p2Preview &&
    Math.abs(p1Preview.startX - p2Preview.startX) < BALL_RADIUS * 3
      ? BALL_RADIUS * 1.8
      : 0;
  const p1VisorX = p1Preview ? Math.max(BALL_RADIUS, Math.min(BOARD.width - BALL_RADIUS, p1Preview.startX - overlapOffset)) : 0;
  const p2VisorX = p2Preview ? Math.max(BALL_RADIUS, Math.min(BOARD.width - BALL_RADIUS, p2Preview.startX + overlapOffset)) : 0;
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
          <linearGradient id="visorCyan" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#00e5ff" stopOpacity="0.05" />
          </linearGradient>
          <linearGradient id="visorMagenta" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff4fd8" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ff4fd8" stopOpacity="0.05" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="500" height="540" fill="url(#boardBg)" />
        <rect x="0" y="0" width="2" height="540" fill="#00e5ff" opacity="0.25" />
        <rect x="498" y="0" width="2" height="540" fill="#ff4fd8" opacity="0.25" />

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

        <line
          x1="0"
          y1={BOARD.bucketY}
          x2="500"
          y2={BOARD.bucketY}
          stroke="#00e5ff"
          strokeWidth="1"
          opacity="0.3"
        />

        {/* Visor — both preview balls + trajectory line at top.
            Renders only while a ball hasn't fully animated yet
            (no live ball pos OR both ready was just triggered). */}
        {showVisor && (
          <g pointerEvents="none">
            {/* Soft visor band so users can read the trajectory hint */}
            <rect
              x="0"
              y="0"
              width="500"
              height={BOARD.topY - 4}
              fill="#00111f"
              opacity="0.55"
            />
            <line
              x1="0"
              y1={BOARD.topY - 4}
              x2="500"
              y2={BOARD.topY - 4}
              stroke="#00e5ff"
              strokeWidth="1"
              opacity="0.35"
              strokeDasharray="4 4"
            />

            {p1Preview && (
              <g>
                <line
                  x1={p1VisorX}
                  y1={VISOR_Y}
                  x2={visorEnd({ ...p1Preview, startX: p1VisorX }, p1VisorX).x}
                  y2={visorEnd({ ...p1Preview, startX: p1VisorX }, p1VisorX).y}
                  stroke="url(#visorCyan)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
                <circle
                  cx={p1VisorX}
                  cy={VISOR_Y}
                  r={BALL_RADIUS}
                  fill="url(#ballCyan)"
                  stroke="#fff"
                  strokeWidth="1.25"
                />
              </g>
            )}

            {p2Preview && (
              <g>
                <line
                  x1={p2VisorX}
                  y1={VISOR_Y}
                  x2={visorEnd({ ...p2Preview, startX: p2VisorX }, p2VisorX).x}
                  y2={visorEnd({ ...p2Preview, startX: p2VisorX }, p2VisorX).y}
                  stroke="url(#visorMagenta)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
                <circle
                  cx={p2VisorX}
                  cy={VISOR_Y}
                  r={BALL_RADIUS}
                  fill="url(#ballMagenta)"
                  stroke="#fff"
                  strokeWidth="1.25"
                />
              </g>
            )}
          </g>
        )}

        {/* Live balls. Fall-out flag drives opacity so balls
            disappear cleanly off the side instead of sticking
            to the wall — user feedback ("balls get stuck in the
            walls"). */}
        {p2BallPos && (
          <g style={{ transition: `opacity ${FALL_OUT_FADE_MS}ms ease-out`, opacity: p2FellOut ? 0 : 1 }}>
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

        {p1BallPos && (
          <g style={{ transition: `opacity ${FALL_OUT_FADE_MS}ms ease-out`, opacity: p1FellOut ? 0 : 1 }}>
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

// ── Round result popup ──────────────────────────────────────────────

function RoundPopup({
  p1Points,
  p2Points,
  p1FellOut,
  p2FellOut,
  ballNumber,
  p1Name,
  p2Name,
  onNextRound,
  isLastBall = false,
}: {
  p1Points: number;
  p2Points: number;
  p1FellOut: boolean;
  p2FellOut: boolean;
  ballNumber: number;
  p1Name: string;
  p2Name: string;
  onNextRound: () => void;
  isLastBall?: boolean;
}) {
  const [timer, setTimer] = useState(5);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
    >
      <div className="rounded-2xl border border-cyan-300/40 bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] p-6 sm:p-8 max-w-md w-full shadow-[0_0_80px_rgba(0,229,255,0.25)]">
        <h3 className="text-center text-sm uppercase tracking-widest text-cyan-200/70 font-semibold mb-1">
          Round {ballNumber} Results
        </h3>

        <div className="grid grid-cols-2 gap-4 mt-4">
          {/* P1 result */}
          <div className="text-center">
            <p className="text-[11px] uppercase tracking-wider text-cyan-300/70 font-semibold truncate" title={p1Name}>
              {p1Name}
            </p>
            {p1FellOut ? (
              <div>
                <p className="text-3xl font-black text-red-400 mt-1">0</p>
                <p className="text-[10px] text-white/50 mt-1">Fell out</p>
              </div>
            ) : (
              <p className={`text-3xl font-black mt-1 tabular-nums ${p1Points >= p2Points ? "text-cyan-300" : "text-white/60"}`}>
                +{p1Points}
              </p>
            )}
          </div>

          {/* P2 result */}
          <div className="text-center">
            <p className="text-[11px] uppercase tracking-wider text-fuchsia-300/70 font-semibold truncate" title={p2Name}>
              {p2Name}
            </p>
            {p2FellOut ? (
              <div>
                <p className="text-3xl font-black text-red-400 mt-1">0</p>
                <p className="text-[10px] text-white/50 mt-1">Fell out</p>
              </div>
            ) : (
              <p className={`text-3xl font-black mt-1 tabular-nums ${p2Points >= p1Points ? "text-fuchsia-300" : "text-white/60"}`}>
                +{p2Points}
              </p>
            )}
          </div>
        </div>

        {/* Both fell out message */}
        {p1FellOut && p2FellOut && (
          <p className="text-center text-[12px] text-red-300/80 mt-4">
            Both balls went out of bounds — better luck next time!
          </p>
        )}

        {/* Single fell out message */}
        {((p1FellOut && !p2FellOut) || (!p1FellOut && p2FellOut)) && (
          <p className="text-center text-[12px] text-yellow-300/80 mt-4">
            {p1FellOut ? p1Name : p2Name}&apos;s ball fell out — 0 points!
          </p>
        )}

        {/* Outcome callout */}
        {!p1FellOut && !p2FellOut && p1Points !== p2Points && (
          <p className="text-center text-sm font-bold text-cyan-300 mt-4">
            {p1Points > p2Points ? p1Name : p2Name} wins this round!
          </p>
        )}
        {!p1FellOut && !p2FellOut && p1Points === p2Points && (
          <p className="text-center text-sm font-bold text-yellow-300 mt-4">
            It&apos;s a tie!
          </p>
        )}

        {/* Next round button with timer */}
        <button
          onClick={onNextRound}
          className="mt-6 w-full px-4 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-400 to-cyan-500 text-[#001933] hover:from-cyan-300 hover:to-cyan-400 transition shadow-[0_0_25px_rgba(0,229,255,0.4)]"
        >
          {isLastBall ? "View Final Results" : `Next Round`} ({timer}s)
        </button>
      </div>
    </motion.div>
  );
}

// ── Per-seat commit panel (used twice — once per side) ───────────────

type CommitPanelProps = {
  startX: number;
  setStartX: (v: number) => void;
  power: number;
  setPower: (v: number) => void;
  angleDeg: number;
  setAngleDeg: (v: number) => void;
  onReady: () => void;
  busy: boolean;
  disabled: boolean;
  lockedHint: string | null;
  opponentHint: string | null;
  theme: "cyan" | "fuchsia";
  // True when this panel belongs to the opponent (not the local
  // viewer). The panel is rendered with a translucent blur so
  // players can't see each other's *in-progress* adjustments
  // before they click "I'm Ready".
  isOpponent: boolean;
};

function CommitPanel({
  startX,
  setStartX,
  power,
  setPower,
  angleDeg,
  setAngleDeg,
  onReady,
  busy,
  disabled,
  lockedHint,
  opponentHint,
  theme,
  isOpponent,
}: CommitPanelProps) {
  const accent = theme === "cyan" ? "accent-cyan-400" : "accent-fuchsia-400";
  const labelColour =
    theme === "cyan" ? "text-cyan-200/80" : "text-fuchsia-200/80";
  const numberColour =
    theme === "cyan" ? "text-cyan-300" : "text-fuchsia-300";
  const borderColour =
    theme === "cyan"
      ? "border-cyan-300/30 shadow-[0_0_30px_rgba(0,229,255,0.1)]"
      : "border-fuchsia-300/30 shadow-[0_0_30px_rgba(255,79,216,0.1)]";
  // isOpponent=true: blur the panel + render a "🔒 Opponent
  // choosing" overlay so the viewer can't infer their live inputs
  // before commit. The Ready button is hidden when blurred.
  const blurClass = isOpponent ? "blur-[3px] pointer-events-none select-none" : "";
  return (
    <div
      className={`relative rounded-2xl border bg-gradient-to-br from-[#001a33] to-[#000a14] p-3 sm:p-4 ${borderColour} ${blurClass}`}
    >
      <div className="grid grid-cols-1 gap-3">
        {/* startX slider */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className={`font-semibold uppercase tracking-wider ${labelColour}`}>
              Start X
            </span>
            <span className={`font-bold tabular-nums ${numberColour}`}>
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
            className={`w-full ${accent}`}
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
          <div className="flex items-center justify-between text-xs mb-1">
            <span className={`font-semibold uppercase tracking-wider ${labelColour}`}>
              Power
            </span>
            <span className={`font-bold tabular-nums ${numberColour}`}>
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
            className={`w-full ${accent}`}
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
          <div className="flex items-center justify-between text-xs mb-1">
            <span className={`font-semibold uppercase tracking-wider ${labelColour}`}>
              Angle (°)
            </span>
            <span className={`font-bold tabular-nums ${numberColour}`}>
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
            className={`w-full ${accent}`}
            aria-label="Launch angle in degrees"
          />
          <div className="flex justify-between text-[10px] text-white/40 mt-0.5">
            <span>-45°</span>
            <span>0°</span>
            <span>+45°</span>
          </div>
        </div>
      </div>

      {/* Hints + Ready button */}
      <div className="mt-3 flex flex-col gap-2">
        <div className="min-h-[1.5rem]">
          {lockedHint ? (
            <p className="text-[11px] text-yellow-300 inline-flex items-center gap-1">
              <CheckIcon className="w-3.5 h-3.5" /> {lockedHint}
            </p>
          ) : opponentHint ? (
            <p className={`text-[11px] inline-flex items-center gap-1 ${theme === "cyan" ? "text-cyan-300" : "text-fuchsia-300"}`}>
              <LoadingDotsIcon className="w-3.5 h-3.5 animate-pulse" />
              {opponentHint}
            </p>
          ) : (
            <p className="text-[11px] text-white/50">
              Lock &quot;Ready&quot; — when both players are ready, both balls launch at once.
            </p>
          )}
        </div>
        <button
          onClick={onReady}
          disabled={disabled || busy}
          className={`w-full px-4 py-2.5 rounded-xl font-bold text-sm transition shadow-[0_0_18px_rgba(0,229,255,0.45)] ${
            disabled || busy
              ? "bg-white/10 text-white/40 cursor-not-allowed"
              : theme === "cyan"
                ? "bg-gradient-to-r from-cyan-400 to-cyan-500 text-[#001933] hover:from-cyan-300 hover:to-cyan-400"
                : "bg-gradient-to-r from-fuchsia-400 to-fuchsia-500 text-[#001933] hover:from-fuchsia-300 hover:to-fuchsia-400"
          }`}
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <LoadingDotsIcon className="w-4 h-4" /> Locking…
            </span>
          ) : (
            "I'm Ready"
          )}
        </button>

        {/* Overlay shown when this panel belongs to the opponent.
            Sits above the blurred content with a clear "🔒
            Opponent choosing…" hint so the viewer knows the
            sliders are intentionally hidden, not broken. */}
        {isOpponent && (
          <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[#000a14]/55 backdrop-blur-[1px] pointer-events-none">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[12px] font-semibold ${
              theme === "cyan"
                ? "bg-cyan-500/15 border-cyan-300/40 text-cyan-100"
                : "bg-fuchsia-500/15 border-fuchsia-300/40 text-fuchsia-100"
            }`}>
              <span>🔒</span>
              <span>Opponent choosing…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Player side panel ────────────────────────────────────────────────
//
// Shows seat name, the cumulative TOTAL points for this player
// (per spec: "add the total amount of points on the top of each
// player name, the player that has more after 3 rounds wins the
// wager"), ready chip, the 3 sliders, and the Ready button.

function PlayerSidePanel({
  seat,
  displayName,
  avatarUrl,
  totalScore,
  isViewer,
  ready,
  isCurrent,
  isFinished,
  startedX,
  power,
  angleDeg,
  setStartX,
  setPower,
  setAngleDeg,
  onReady,
  busy,
  inputsLocked,
}: {
  seat: "player1" | "player2";
  displayName: string;
  avatarUrl?: string | null;
  totalScore: number;
  lastBallDelta?: number | null;
  isViewer: boolean;
  ready: boolean;
  isCurrent: boolean;
  isFinished: boolean;
  startedX: number;
  power: number;
  angleDeg: number;
  setStartX: (v: number) => void;
  setPower: (v: number) => void;
  setAngleDeg: (v: number) => void;
  onReady: () => void;
  busy: boolean;
  inputsLocked: boolean;
}) {
  const isCyan = seat === "player1";
  const headerColour = isCyan ? "text-cyan-200" : "text-fuchsia-200";
  const scoreColour = isCyan ? "text-cyan-100" : "text-fuchsia-100";
  const ringColour = isCyan
    ? "border-cyan-300/40 shadow-[0_0_18px_rgba(0,229,255,0.18)]"
    : "border-fuchsia-300/40 shadow-[0_0_18px_rgba(255,79,216,0.18)]";

  // Determine hint strings (mirrors existing CommitPanel conventions).
  let lockedHint: string | null = null;
  let opponentHint: string | null = null;
  if (!isCurrent) {
    lockedHint = null;
    opponentHint = null;
  } else if (isFinished) {
    lockedHint = "Match finished";
  } else if (ready && isViewer) {
    lockedHint = `You're ready — waiting for opponent`;
  } else if (ready && !isViewer) {
    opponentHint = `Opponent ready`;
  } else if (!isViewer) {
    opponentHint = `Opponent choosing…`;
  }
  // NOTE: the previous `} else if (inputsLocked && !ready) {`
  // branch was removed. With the optimistic localReady flag above
  // the chip and hint can now briefly disagree (chip says READY
  // from localReady, hint says "Lock "Ready"…" because match.p{N}Ready
  // is still false before polling lands). That branch painted a
  // misleading "Ready" hint while the chip showed NOT READY — dead
  // code in normal flow that contradicted the user-visible state.

  return (
    <div
      className={`rounded-2xl border ${ringColour} bg-gradient-to-br from-[#001a33] via-[#00111f] to-[#000814] p-3 sm:p-4 flex flex-col gap-3 h-full`}
    >
      {/* Header: seat + name + total points (matches the spec:
          "add the total amount of points on the top of each player name"). */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p
            className={`text-[10px] uppercase tracking-wider ${headerColour}/70 font-semibold`}
          >
            {(isCyan ? "Player 1" : "Player 2") + (isViewer ? " · You" : "")}
          </p>
          <p
            className={`text-sm font-bold ${headerColour} truncate`}
            title={displayName}
          >
            {displayName}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[10px] uppercase tracking-wider ${headerColour}/70`}>
            Total
          </p>
          <p
            className={`text-2xl sm:text-3xl font-black tabular-nums ${scoreColour}`}
          >
            {totalScore}
          </p>
        </div>
      </div>

      {/* Ready chip — wrapped in motion.div keyed on the boolean so
          a NOT READY → READY (or vice-versa) flip replays the spring
          scale-in animation, giving the user punchy feedback when
          their click registers / the server resolves the ball. */}
      <motion.div
        key={ready ? "ready" : "not-ready"}
        initial={{ scale: 0.82, opacity: 0.55 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 26 }}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold tracking-wide ${
          ready
            ? isCyan
              ? "bg-cyan-500/20 text-cyan-100 border border-cyan-300/40 shadow-[0_0_14px_rgba(0,229,255,0.25)]"
              : "bg-fuchsia-500/20 text-fuchsia-100 border border-fuchsia-300/40 shadow-[0_0_14px_rgba(255,79,216,0.25)]"
            : "bg-white/5 text-white/50 border border-white/10"
        }`}
        aria-live="polite"
      >
        {ready ? (
          <>
            <CheckIcon className="w-3.5 h-3.5" />
            READY
          </>
        ) : (
          <>
            <CrossIcon className="w-3 h-3 opacity-60" />
            NOT READY
          </>
        )}
      </motion.div>

      {/* Sliders + Ready button (interactive only for the viewer&apos;s
          own seat and only while waiting on /launchable state). */}
      <CommitPanel
        startX={startedX}
        setStartX={setStartX}
        power={power}
        setPower={setPower}
        angleDeg={angleDeg}
        setAngleDeg={setAngleDeg}
        onReady={onReady}
        busy={busy}
        disabled={inputsLocked || !isViewer || !isCurrent || isFinished}
        lockedHint={lockedHint}
        opponentHint={opponentHint}
        theme={isCyan ? "cyan" : "fuchsia"}
        isOpponent={!isViewer}
      />
    </div>
  );
}

// ── Page component ───────────────────────────────────────────────────

export default function PlinkoPvpMatchPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
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
  // Set when the launch API returns `code: "MIGRATION_INCOMPLETE"` —
  // i.e. p1_ready / p2_ready columns are missing on the live DB.
  // Renders a targeted banner above the board instead of a generic
  // toast so the user can fix it themselves (run npm run db:migrate
  // or apply migration 0053 manually on Neon).
  const [migrationIncomplete, setMigrationIncomplete] = useState<boolean>(false);
  const [timeLeft, setTimeLeft] = useState<number>(0);

  // Optimistic local "I'm Ready" flag for the viewer.
  //
  // Why this exists: the server's `launchBall` runs the entire
  // commit + bothReady + simulateDualBalls + resolveBall sequence in
  // ONE transaction. The server briefly holds `p{N}Ready=true` for
  // perhaps <1ms before `resolveBall` wipes `p{N}Ready=false`
  // (alongside `p{N}CurrentInputs`) as part of advancing the match
  // to the next ball. By the time the second player's
  // `fetchStatus()` lands, only the post-resolve state is visible
  // — `match.p{N}Ready=false` — so that player's own chip NEVER
  // visually toggles to READY, even though their POST succeeded and
  // advanced the round.
  //
  // Fix: OR-merge this flag with `match.{viewerSeat}Ready` for the
  // local viewer's panel + hint so the UI reflects the click
  // immediately. The flag is reset on a `match.currentBall` change
  // (new round opens) or terminal status (finished / cancelled) so
  // it never leaks across rounds. The OPPONENT's chip still uses
  // raw server state — we don't fake the opponent.
  const [localReady, setLocalReady] = useState(false);

  // ── Local UI state (viewer&apos;s sliders) ─────────────────────────
  const [startX, setStartX] = useState<number>(250);
  const [power, setPower] = useState<number>(50);
  const [angleDeg, setAngleDeg] = useState<number>(0);

  // Opponent seed values: only mutated when a new /launch response
  // lands the opponent&apos;s committed inputs as a fallback. We use
  // these for read-only display under the opponent&apos;s side panel.
  const [opponentStartX, setOpponentStartX] = useState<number>(250);
  const [opponentPower, setOpponentPower] = useState<number>(50);
  const [opponentAngle, setOpponentAngle] = useState<number>(0);

  // Phase + busy
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // ── Round result popup state ─────────────────────────────────────
  const [roundPopup, setRoundPopup] = useState<{
    p1Points: number;
    p2Points: number;
    p1FellOut: boolean;
    p2FellOut: boolean;
    ballNumber: number;
  } | null>(null);

  // Client-side round counter for display purposes. Only advances
  // when the popup is dismissed (onNextRound), NOT when the server
  // advances match.currentBall (which happens instantaneously in
  // resolveBall). This keeps the "Ball X of 3" label and the
  // between-rounds banner in sync with what the player actually
  // sees, rather than jumping ahead while the popup is still visible.
  // Initialised from match.currentBall on first load so refreshes
  // don't replay the popup.
  const [displayBall, setDisplayBall] = useState<number>(1);
  useEffect(() => {
    if (match) {
      setDisplayBall(match.currentBall);
    }
  }, [match?.id]); // only on match identity change, not every currentBall advance

  // Animated ball positions. Stored in a SINGLE shape so the dual-track
  // animator can update both balls with one setState per frame — React 18
  // doesn&apos;t reliably batch independent setState calls inside
  // requestAnimationFrame callbacks, so the previous build could render
  // the two balls a frame apart. Using a single object guarantees both
  // positions are committed in the same render.
  const [ballPositions, setBallPositions] = useState<{
    p1: { x: number; y: number } | null;
    p2: { x: number; y: number } | null;
  }>({ p1: null, p2: null });
  // Backwards-compatible derivations for every existing consumer
  // (board render, fellOut fade, between-balls reset, etc.).
  const p1BallPos = ballPositions.p1;
  const p2BallPos = ballPositions.p2;
  const [highlightBucket, setHighlightBucket] = useState<{
    index: number;
    side: "p1" | "p2";
  } | null>(null);

  // Track which ball numbers have been animated so we don&apos;t
  // double-animate on subsequent /status polls.
  const animatedBallNumbersRef = useRef<Set<number>>(new Set());
  // Single shared cancel handle for the dual-track animator. The
  // previous build kept two separate cancel refs (one per ball) and
  // started two separate RAF loops with their own startTimes — that
  // made the two balls drift out of sync. One ref + one RAF + one
  // shared startTime keeps both balls perfectly aligned.
  const dualAnimCancelRef = useRef<(() => void) | null>(null);
  // Tracks the 3-second "Ball X incoming" setTimeout scheduled inside
  // startDualTrackAnimation (and the 800ms "finished" timer). Without
  // this, the timer could fire after the component unmounts (causing a
  // React setState-on-unmounted warning) or race a new dual-track
  // start that supersedes it.
  const dualAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // In-flight guard for fetchStatus — prevents overlapping /match
  // requests from the 800ms poll, onNextRound, socket events, and
  // handleReady all firing within the same ~100ms window.
  const fetchStatusPendingRef = useRef(false);

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

  const resolvedFiredRef = useRef(false);

  // ── Status fetch ─────────────────────────────────────────────────
  // BUG-FIX: returns the freshly-parsed `match` so callers awaiting
  // `fetchStatus()` from inside another async handler (notably
  // `handleReady`'s defensive refresh) don't have to fall back to
  // the stale `matchRef.current` read — which has NOT been updated
  // yet because `matchRef.current = match` lives in a `useEffect`
  // that runs only AFTER the next React commit cycle. Returning
  // the value directly lets the caller observe the same fresh payload
  // that `setMatch` is about to commit.
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
    // In-flight guard: skip if a fetchStatus call is already pending.
    // Previously overlapping calls from the 800ms poll + onNextRound +
    // socket events + handleReady could pile up 3-4 concurrent requests,
    // triggering "too many requests" on Render free plan. A single
    // in-flight promise is sufficient — the next scheduled poll
    // (800ms) will pick up any missed updates.
    if (fetchStatusPendingRef.current) return null;
    fetchStatusPendingRef.current = true;
    try {
      const res = await fetch(`/api/plinko-pvp/match/${matchId}`, {
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
      setMatch(nextMatch);
      setRounds(Array.isArray(data?.data?.rounds) ? data.data.rounds : []);

      // If /match returns an error, surface it inside the state but
      // don't blow away the existing match (so the page doesn't
      // // visually reset). Previously a transient 500 would set
      // match=null and bounce the user to the error screen.
      if (!res.ok && nextMatch === null) {
        setError(data?.error || "Unable to load match");
      }

      // Sync opponent&apos;s committed inputs (read-only display).
      if (nextMatch) {
        const viewerIsP1 = nextMatch.viewerIsPlayer1;
        const opp = viewerIsP1
          ? nextMatch.p2CurrentInputs
          : nextMatch.p1CurrentInputs;
        if (opp) {
          if (typeof opp.startX === "number") setOpponentStartX(opp.startX);
          if (typeof opp.power === "number") setOpponentPower(opp.power);
          if (typeof opp.angleDeg === "number") setOpponentAngle(opp.angleDeg);
        }
      }
      setError(nextMatch ? null : "Match not found.");
      return nextMatch as NormalisedMatch | null;
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
    // Faster polling cadence (800 ms instead of 1500 ms) so users
    // see opponent commits / round resolutions / match-end almost
    // in real time. Was previously flagged as "buggy sync".
    const interval = setInterval(fetchStatus, 800);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // ── Socket subscription ──────────────────────────────────────────
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

  // ── Optimistic ready reset on ball advance / terminal status ─────
  //
  // Resets the local "I'm Ready" optimistic flag once the current
  // round is no longer in flight. Triggers on:
  //   • `match.currentBall` advancing (server cleared the round's
  //     ready flags + currentInputs and moved to ball_(N+1))
  //   • Status moving to FINISHED or CANCELLED (match over)
  // Picking up only these two deps avoids spurious resets during
  // inter-poll render flicker. The flag is allowed to remain true
  // for the entire visible window of a single ball, so the chip
  // stays on READY from "I'm Ready" click through ball launch and
  // animation into the transition phase.
  useEffect(() => {
    if (!match) return;
    if (
      match.status === MATCH_STATUS.FINISHED ||
      match.status === MATCH_STATUS.CANCELLED
    ) {
      setLocalReady(false);
      return;
    }
  }, [match?.status]);
  useEffect(() => {
    setLocalReady(false);
  }, [match?.currentBall]);

  // ── Phase reset on status transitions ────────────────────────────
  useEffect(() => {
    if (!match) return;
    const launchable =
      match.status === MATCH_STATUS.BALL_1 ||
      match.status === MATCH_STATUS.BALL_2 ||
      match.status === MATCH_STATUS.BALL_3 ||
      match.status === MATCH_STATUS.BALL_4;
    if (
      launchable &&
      phaseRef.current !== "animating" &&
      phaseRef.current !== "transitioning" &&
      phaseRef.current !== "launching"
    ) {
      setPhase("idle");
      setHighlightBucket(null);
      setBallPositions({ p1: null, p2: null });
    }
    if (match.status === MATCH_STATUS.FINISHED && phaseRef.current !== "finished") {
      setPhase("finished");
    }
    if (match.status === MATCH_STATUS.CANCELLED && phaseRef.current !== "cancelled") {
      setPhase("cancelled");
    }
  }, [match?.status, match?.currentBall]);

  // ── Animation effect: detect newly-resolved balls on /status ───
  //
  // BUG-FIX: the previous code animated half-staged paths from cached
  // p1Result/p2Result, which could leave the opponent&apos;s ball
  // "stuck in the side". The new code uses the canonical rounds
  // history as the SINGLE source of truth: whenever a new round
  // appears, both paths are derived from the rounds row and animated
  // concurrently. The launch handler never animates alone.
  useEffect(() => {
    if (rounds.length === 0) return;
    // Allow animation to proceed even during "launching" phase
    // (the second committer's handleReady sets "launching" before
    // calling fetchStatus which updates rounds — without this the
    // triggering player never sees their own ball animation).
    // "animating" / "transitioning" / "finished" still gate to
    // avoid cancelling an in-progress animation with a new one.
    if (
      phaseRef.current === "animating" ||
      phaseRef.current === "transitioning" ||
      phaseRef.current === "finished"
    ) {
      return;
    }
    const newRounds = rounds.filter(
      (r) => !animatedBallNumbersRef.current.has(r.ballNumber),
    );
    if (newRounds.length === 0) {
      // No new rounds to animate — if handleReady set "launching"
      // but the round hasn't resolved yet (opponent hasn't readied),
      // clear the phase so the UI returns to idle.
      if (phaseRef.current === "launching") {
        setPhase("idle");
      }
      return;
    }
    // Process the OLDEST unplayed round first (chronological order).
    // The previous code picked newRounds[newRounds.length - 1] (newest
    // first), which caused out-of-order animation when multiple rounds
    // accumulated between poll ticks. Older rounds would then be
    // animated behind the popup in the "transitioning" phase and
    // subsequently killed by the user clicking "Next Round".
    const target = newRounds[0];
    animatedBallNumbersRef.current.add(target.ballNumber);
    startDualTrackAnimation(
      target.player1Result,
      target.player2Result,
      target.ballNumber,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds]);

  // Pre-compute the segment-lengths + cumulative-starts + total length
  // for a Bézier-style path. Sampling then becomes a log-time lookup
  // over the same `[0, totalLen]` axis as the animation timer. Used
  // by `startDualTrackAnimation` so both balls advance at exactly the
  // same rate against the same `t` value.
  function precomputePathSampling(path: Path) {
    const segLens: number[] = [];
    const cumStarts: number[] = [0];
    let totalLen = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dy = path[i].y - path[i - 1].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      segLens.push(len);
      totalLen += len;
      cumStarts.push(totalLen);
    }
    return { segLens, cumStarts, totalLen };
  }

  // Sample an (x, y) point along `path` at progress `t` in [0, 1]. O(n)
  // is fine here because we precompute the cumulative lengths once and
  // the path is short (~120 substeps).
  function samplePath(
    path: Path,
    sampling: { segLens: number[]; cumStarts: number[]; totalLen: number },
    t: number,
  ): { x: number; y: number } {
    if (path.length === 0) return { x: 0, y: 0 };
    if (path.length === 1) return { x: path[0].x, y: path[0].y };
    if (sampling.totalLen === 0) {
      const last = path[path.length - 1];
      return { x: last.x, y: last.y };
    }
    const clampedT = Math.max(0, Math.min(1, t));
    const targetDist = clampedT * sampling.totalLen;
    let segIdx = 0;
    for (let i = 0; i < sampling.segLens.length; i++) {
      if (sampling.cumStarts[i + 1] >= targetDist) {
        segIdx = i;
        break;
      }
      segIdx = i;
    }
    const segStartDist = sampling.cumStarts[segIdx];
    const segLen = sampling.segLens[segIdx];
    const localT = segLen === 0 ? 0 : (targetDist - segStartDist) / segLen;
    const p0 = path[segIdx];
    const p1 = path[segIdx + 1];
    return {
      x: p0.x + (p1.x - p0.x) * localT,
      y: p0.y + (p1.y - p0.y) * localT,
    };
  }

  const startDualTrackAnimation = useCallback(
    (p1Result: BallResult, p2Result: BallResult, ballNumber: number) => {
      // Cancel any in-flight dual-track animation first. Single handle
      // so there's only ever one RAF loop, never two racing ones.
      if (dualAnimCancelRef.current) {
        dualAnimCancelRef.current();
        dualAnimCancelRef.current = null;
      }

      const p1Path = p1Result?.path?.length ? p1Result.path : [];
      const p2Path = p2Result?.path?.length ? p2Result.path : [];

      // Only skip animation entirely when BOTH balls have empty
      // paths. If just one is missing, animate the available ball
      // so users see at least something instead of both balls
      // silently disappearing. The missing-path case is logged
      // so we can diagnose server-side issues.
      if (p1Path.length === 0 && p2Path.length === 0) return;
      if (p1Path.length === 0) {
        console.warn(
          "[plinko-pvp] p1Result has an empty path — animating p2 only. ballNumber:",
          ballNumber,
        );
      }
      if (p2Path.length === 0) {
        console.warn(
          "[plinko-pvp] p2Result has an empty path — animating p1 only. ballNumber:",
          ballNumber,
        );
      }
      const p1Sampling = precomputePathSampling(p1Path);
      const p2Sampling = precomputePathSampling(p2Path);

      // Initial positions at t = 0. Single setState updates both balls in
      // one React render so they&apos;re committed together.
      const initial: {
        p1: { x: number; y: number } | null;
        p2: { x: number; y: number } | null;
      } = { p1: null, p2: null };
      if (p1Path.length > 0) initial.p1 = { x: p1Path[0].x, y: p1Path[0].y };
      if (p2Path.length > 0) initial.p2 = { x: p2Path[0].x, y: p2Path[0].y };
      setBallPositions(initial);
      setHighlightBucket(null);
      setPhase("animating");

      // ONE shared startTime, captured once at the very moment animation
      // begins. The previous build used two SEPARATE performance.now()
      // reads inside two SEPARATE animateBall calls — the microsecond
      // drift compounded over 2.5s and produced visually desynced balls.
      // With one startTime both balls read the same baseline and tick
      // against the same `t` per frame, so they fall together.
      const startTime = performance.now();
      let cancelled = false;
      let rafId = 0;

      const tick = (now: number) => {
        if (cancelled) return;
        const elapsed = Math.max(0, now - startTime);
        const t = Math.min(1, elapsed / BALL_ANIMATION_MS);

        // Sample both paths from the SAME `t` value in the same RAF
        // callback. Update BOTH positions via a single setBallPositions
        // call so both go through one React render and never get
        // scheduled a frame apart (the original bug: two independent
        // setStates inside a RAF can render separately).
        const next: {
          p1: { x: number; y: number } | null;
          p2: { x: number; y: number } | null;
        } = {
          p1:
            p1Path.length > 0 ? samplePath(p1Path, p1Sampling, t) : null,
          p2:
            p2Path.length > 0 ? samplePath(p2Path, p2Sampling, t) : null,
        };
        setBallPositions(next);

        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          // Lock final positions so the ball doesn't overshoot when
          // rounding errors accumulate over 2.5s of interpolation. Both
          // balls locked in a single setState call.
          const finalPose: {
            p1: { x: number; y: number } | null;
            p2: { x: number; y: number } | null;
          } = { p1: null, p2: null };
          if (p1Path.length > 0) {
            const lastP1 = p1Path[p1Path.length - 1];
            finalPose.p1 = { x: lastP1.x, y: lastP1.y };
          }
          if (p2Path.length > 0) {
            const lastP2 = p2Path[p2Path.length - 1];
            finalPose.p2 = { x: lastP2.x, y: lastP2.y };
          }
          setBallPositions(finalPose);

          // Highlight bucket + advance phase
          if (p2Result.bucketIndex >= 0) {
            setHighlightBucket({ index: p2Result.bucketIndex, side: "p2" });
          } else if (p1Result.bucketIndex >= 0) {
            setHighlightBucket({ index: p1Result.bucketIndex, side: "p1" });
          } else {
            setHighlightBucket(null);
          }

          // Show the per-ball result popup for NORMAL rounds only.
          // Overtime (the 4th tiebreaker ball) deliberately skips
          // this popup — the match-over screen (tie / win / lose
          // + Back to Lobby) is the only modal the player sees
          // there, so no intermediate "Ball 4 Results" popup pops
          // up before/on top of the final result.
          if (ballNumber <= REQUIRED_BALLS) {
            setRoundPopup({
              p1Points: p1Result.points,
              p2Points: p2Result.points,
              p1FellOut: p1Result.fellOut,
              p2FellOut: p2Result.fellOut,
              ballNumber,
            });
            // BUG-FIX: clear balls from the board immediately when
            // the popup appears, not when the popup is dismissed.
            // Previously balls stayed at their final positions
            // until onNextRound fired, which meant Player A and
            // Player B saw different board states depending on who
            // dismissed the popup first — causing the user-reported
            // "balls don't reset to original positions" sync issue.
            setBallPositions({ p1: null, p2: null });
          }

          if (ballNumber >= REQUIRED_BALLS) {
            if (dualAnimTimerRef.current) clearTimeout(dualAnimTimerRef.current);
            dualAnimTimerRef.current = setTimeout(
              () => setPhase("finished"),
              800,
            );
          } else {
            setPhase("transitioning");
            // Don't auto-advance — wait for popup "Next Round" click
          }
        }
      };

      rafId = requestAnimationFrame(tick);
      dualAnimCancelRef.current = () => {
        cancelled = true;
        if (rafId) cancelAnimationFrame(rafId);
        if (dualAnimTimerRef.current) {
          clearTimeout(dualAnimTimerRef.current);
          dualAnimTimerRef.current = null;
        }
      };
    },
    [fetchStatus],
  );

  // ── Ready handler (replaces old Launch handler) ──────────────────
  //
  // Per spec: both players click Ready; when both are ready, server
  // runs simulateDualBalls so both balls can knock each other off
  // course. Until then, the server caches each seat&apos;s inputs
  // and flips p{N}Ready = true. The 20s AFK timer still exists as a
  // fallback so a player who never clicks Ready doesn&apos;t hang the
  // round — fireBallAdvance auto-readies the missing seat with
  // auto-tuned inputs.
  const handleReady = useCallback(async () => {
    if (busy || !isValidMatchId) return;
    // Lock the button immediately so a double-click during the awaits
    // below cannot fire a parallel fetchStatus / POST. Doing this BEFORE
    // the defensive refresh also keeps the user's local `busy` state
    // consistent with the server flip of p2Ready.
    setBusy(true);
    setError(null);
    // Optimistic UI: flip the *local* "I'm Ready" chip immediately
    // so the click feels responsive. This is the user-visible fix
    // for the "only the first to click Ready works" bug — without
    // this, the second player's chip would never toggle because
    // the server-side launchBall transaction wipes p{N}Ready=false
    // (via resolveBall) before their own fetchStatus() returns.
    // The matching reset lives in the effect above (currentBall
    // change / terminal status). We NEVER clear `localReady`
    // inside try/catch — a failed launch should leave the chip
    // alone so a retry still feels like "I clicked it".
    setLocalReady(true);
    // Read the LATEST match state via matchRef rather than the closure&apos;s
    // `match`. The closure value can be stale when the user clicks within
    // ~50ms of an opponent commit (the polling cadence is 800ms so there&apos;s
    // a real race window where the local cache hasn&apos;t caught up yet).
    // Falling back to the prop keeps the path stable during the rare
    // initial-render moment before matchRef has been populated.
    const liveMatch = matchRef.current ?? match;
    if (!liveMatch) {
      // Reset optimistic ready — we have no match context, the chip
      // would otherwise say READY even though we never even tried.
      setLocalReady(false);
      setBusy(false);
      return;
    }

    // DEFENSIVE: if the local cache thinks I can&apos;t launch yet (e.g. the
    // opponent&apos;s commit hasn&apos;t propagated through polling), poll once
    // before bailing so a stale "disabled" state can&apos;t strand the second
    // player on the ready button. This is the user-reported "only the first
    // to click ready works" bug: a stale viewerCanLaunch=false would silently
    // drop the second player&apos;s POST. The refresh is bounded by a 1500ms
    // timeout so a hung network doesn&apos;t hang busy=true indefinitely.
    //
    // BUG-FIX: previously this branch read `matchRef.current ?? liveMatch`
    // AFTER awaiting `fetchStatus()`. That returned STALE data because
    // `matchRef.current = match` only runs in a `useEffect` AFTER React
    // commits — so within the same async handler, the ref was still
    // pointing at the pre-refresh snapshot. The handler would then
    // bail with "Ready isn&apos;t available right now" silently. The fix is
    // to use the freshly-fetched match returned by `fetchStatus()` directly;
    // we keep the original `timedOut` flag so we can still distinguish a
    // hung-network (timeout wins) from a legitimate null fetch result
    // (fetch resolves with null but the match cache was already valid).
    if (!liveMatch.viewerCanLaunch) {
      let timedOut = false;
      const refreshedFromFetch = await Promise.race<
        NormalisedMatch | null
      >([
        fetchStatus(),
        new Promise<NormalisedMatch | null>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, 1500);
        }),
      ]);
      // Prefer the freshest match available: returned-from-fetch
      // (which set the React state too) > just-updated ref > original
      // closure snapshot. When the timeout won, `refreshedFromFetch`
      // is null and we fall back through the chain — and the
      // `timedOut` branch below surfaces a clear error so the user
      // isn&apos;t stranded thinking their click did nothing.
      const refreshed =
        refreshedFromFetch ?? matchRef.current ?? liveMatch;
      if (timedOut) {
        setError("Couldn&apos;t reach the server to confirm your ready status. Try again in a moment.");
        // We never even reached a decision on `viewerCanLaunch`,
        // so the optimistic chip would be lying. Reset it.
        setLocalReady(false);
        setBusy(false);
        return;
      }
      if (!refreshed.viewerCanLaunch) {
        if (refreshed.viewerHasCommitted) {
          setError("You&apos;ve already locked this ball in.");
        } else if (refreshed.status === MATCH_STATUS.READY) {
          setError("Waiting for the ball to start\u2026");
        } else if (refreshed.status === MATCH_STATUS.FINISHED) {
          setError("Match finished.");
        } else if (refreshed.status === MATCH_STATUS.CANCELLED) {
          setError("Match cancelled.");
        } else {
          setError("Ready isn&apos;t available right now. Try again in a moment.");
        }
        // Defensive refresh said we can&apos;t launch — never made it
        // to the POST. Reset optimistic ready so the chip doesn&apos;t
        // lie about a click that never registered on the server.
        setLocalReady(false);
        setBusy(false);
        return;
      }
    }
    try {
      const res = await fetch(`/api/plinko-pvp/match/${matchId}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ startX, power, angleDeg }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (data?.code === "MIGRATION_INCOMPLETE") {
          // Don't reuse the generic `error` toast — surface a
          // dedicated banner with the exact remediation so the
          // player isn't told to "try again" when the real fix
          // is to run migrations on the backend.
          setMigrationIncomplete(true);
          setError(
            data?.error ||
              "Plinko Duel schema is outdated. Run npm run db:migrate.",
          );
        } else {
          setMigrationIncomplete(false);
          setError(data?.error || "Ready failed");
        }
        // Server explicitly rejected the click — flip the optimistic
        // chip back so READY doesn't linger after a permanent failure
        // (e.g. migration-incomplete, match finished, network error).
        // Otherwise users will think the click took effect and wonder
        // why nothing happens.
        setLocalReady(false);
        return;
      }
      // Successful launch — clear the migration banner (in case it
      // was sticky from an earlier session in this match).
      setMigrationIncomplete(false);

      // Push a dedicated plinko:ready event through the realtime
      // server so the opponent's client gets an immediate refresh
      // (the realtime server validates participation and relays
      // PLINKO_PVP_MATCH_UPDATED to the match room).
      // Also broadcast to the lobby room so the lobby list updates.
      socket?.emit(PLINKO_PVP_READY, { matchId });
      socket?.emit("room_event", {
        roomId: PLINKO_PVP_LOBBY_ROOM,
        event: PLINKO_PVP_MATCH_UPDATED,
      });

      posthog?.capture("plinko_pvp_player_ready", {
        match_id: match?.id ?? matchId ?? -1,
        ball_number: match.currentBall,
        seat: match.viewerSeat,
        start_x: Math.round(startX),
        power: Math.round(power),
        angle_deg: Math.round(angleDeg),
      });

      if (data.data.raced) {
        await fetchStatus();
        return;
      }

      // When this POST was the commit that filled the last gap and
      // triggered server-side ball resolution, the response includes
      // the collision-aware dual-simulation paths. Use them to
      // animate IMMEDIATELY — don't wait for the 800ms poll or the
      // rounds-effect. This is the fix for "ball disappears / only
      // one ball falls": the second committer now sees the animation
      // instantly, and the opponent picks it up on their next poll.
      //
      // We still await fetchStatus() afterwards so the rest of the
      // state (match, scores, etc.) is fresh for the next round,
      // but we pre-register the ball number so the rounds-effect
      // doesn't double-animate.
      const justResolved = Boolean(data.data.justResolved);
      if (justResolved) {
        // Use the pre-click currentBall (the closure captures the
        // match state at the time the user clicked "I'm Ready").
        // After the server resolves the ball, the response's
        // match.currentBall has already been advanced to ball_(N+1)
        // (or frozen at 3 for the final ball) — using that would
        // compute the wrong ball number for the final ball.
        const resolvedBallNumber = match?.currentBall ?? 1;
        // Pre-register so the pending fetchStatus / rounds-effect
        // won't try to animate this ball a second time.
        animatedBallNumbersRef.current.add(resolvedBallNumber);
        // Use the /launch response paths (collision-aware from
        // simulateDualBalls) for immediate visual feedback.
        const p1Res = data.data.p1Result;
        const p2Res = data.data.p2Result;
        if (p1Res && p2Res) {
          startDualTrackAnimation(p1Res, p2Res, resolvedBallNumber);
        } else if (data.data.myResult) {
          // Fallback: half-dual animation with the viewer's own
          // result. Both paths being null when justResolved=true
          // means the server response shape changed — still animate
          // what we have so the ball doesn't disappear.
          const viewerIsP1 = match?.viewerIsPlayer1;
          startDualTrackAnimation(
            viewerIsP1 ? data.data.myResult : null,
            viewerIsP1 ? null : data.data.myResult,
            resolvedBallNumber,
          );
        }
      }

      // Always force-refresh immediately after the launch POST so the
      // client doesn't have to wait for the next 800ms poll. This
      // makes the "I'm Ready" → "ball resolved → next ball" loop
      // feel snappier and avoids leaving the user stranded on the
      // last-second slide if /launch took its time on the round-trip.
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ready failed");
      // Network failure → server never confirmed. Drop the
      // optimistic chip so the user knows their click didn&apos;t
      // go through and they can retry.
      setLocalReady(false);
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
  ]);

  // ── Cancel handler ──────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
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

  // ── Next round handler (dismisses round popup) ─────────────────
  const onNextRound = useCallback(() => {
    // Advance the UI round counter — this is the ONLY place
    // displayBall increments, so it stays in sync with the
    // user&apos;s visual timeline (popup dismissed → round advances).
    // Cap at REQUIRED_BALLS so the final dismissal doesn't
    // announce a nonexistent ball 4.
    setDisplayBall((prev) => Math.min(prev + 1, REQUIRED_BALLS));
    setRoundPopup(null);
    // Only reset to idle if we aren't already animating a newer round.
    // When a round's animation was started during the "transitioning"
    // phase (popup from a previous round still visible), the user
    // clicking "Next Round" should not nuke the in-progress animation.
    if (phaseRef.current !== "animating") {
      setPhase("idle");
      // Ball positions already cleared when popup appeared — no
      // need to clear again, but belt-and-suspenders won't hurt.
      setBallPositions({ p1: null, p2: null });
      setHighlightBucket(null);
    }
    setBusy(false);
    fetchStatus();
  }, [fetchStatus]);

  // ── Cleanup on unmount ─────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (dualAnimCancelRef.current) dualAnimCancelRef.current();
      if (dualAnimTimerRef.current) {
        clearTimeout(dualAnimTimerRef.current);
        dualAnimTimerRef.current = null;
      }
    };
  }, []);

  // ── Busy safety-net ───────────────────────────────────────────
  // BUG-FIX: `busy` should ONLY be `true` while the launch POST is
  // actually in-flight (≤ a few seconds). If `setBusy(false)` in the
  // POST's `finally` block is somehow skipped — e.g. because an
  // unhandled rejection froze the handler — the Ready button would
  // stay stuck on "Locking…" forever and the player could never
  // retry. Set a watchdog that unconditionally clears `busy` after
  // 8 s. The normal success path resets it well before this fires.
  useEffect(() => {
    if (!busy) return;
    const watchdog = setTimeout(() => {
      setBusy(false);
    }, 8000);
    return () => clearTimeout(watchdog);
  }, [busy]);

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

  // ── Derived state ─────────────────────────────────────────────
  const isFinished = match.status === MATCH_STATUS.FINISHED;
  const isCancelled = match.status === MATCH_STATUS.CANCELLED;
  const isReady = match.status === MATCH_STATUS.READY;
  const isWaiting = match.status === MATCH_STATUS.WAITING;
  const isLaunchable =
    match.status === MATCH_STATUS.BALL_1 ||
    match.status === MATCH_STATUS.BALL_2 ||
    match.status === MATCH_STATUS.BALL_3 ||
    match.status === MATCH_STATUS.BALL_4;
  const urgent = timeLeft > 0 && timeLeft <= 5;

  const isViewerP1 = match.viewerIsPlayer1;
  const viewerSeat = isViewerP1 ? "player1" : "player2";

  const stake = match.stakeAmount;

  // Display names: fall back to a deterministic public id hash so
  // the panels never show a literal &quot;Player 1/2&quot; label.
  function shortId(id: string | null | undefined) {
    if (!id) return "Opponent";
    return id.length <= 7 ? id : id.slice(0, 6) + "…";
  }
  const p1Name = match.players?.p1?.displayName ?? shortId(match.player1Id);
  const p2Name = match.players?.p2?.displayName ?? shortId(match.player2Id);
  const p1Avatar = match.players?.p1?.profileImageUrl ?? null;
  const p2Avatar = match.players?.p2?.profileImageUrl ?? null;
  // Per-ball +N delta for the side-panel chip (user-flagged
  // "points should work when ball hits them"). Computed from the
  // cumulative sum of rounds so a clean delta surfaces on top of
  // the total each time a ball resolves. Also drove the latest
  // fellOut flag — used to fade the ball out cleanly off the wall.
  const sortedRounds = rounds ? [...rounds].sort((a, b) => a.ballNumber - b.ballNumber) : [];
  const latestRound = sortedRounds.length > 0 ? sortedRounds[sortedRounds.length - 1] : null;
  function deltaFor(seat: "p1" | "p2"): number | null {
    if (!latestRound) return null;
    const fromRound = seat === "p1" ? latestRound.ballPointsPlayer1 : latestRound.ballPointsPlayer2;
    if (typeof fromRound !== "number") return null;
    const totals = sortedRounds.slice(0, -1).reduce(
      (acc, r) => acc + (seat === "p1" ? r.ballPointsPlayer1 : r.ballPointsPlayer2),
      0,
    );
    return fromRound - totals;
  }
  const p1Delta = deltaFor("p1");
  const p2Delta = deltaFor("p2");
  // Visor-on-top + preview balls + trajectory line at the top of the
  // board so players can see what trajectory the ball will go with
  // their current inputs (user-flagged feature request).
  const showVisor =
    !p1BallPos && !p2BallPos &&
    (match.status === MATCH_STATUS.BALL_1 || match.status === MATCH_STATUS.BALL_2 || match.status === MATCH_STATUS.BALL_3 || match.status === MATCH_STATUS.BALL_4) &&
    phase !== "animating" && phase !== "transitioning";
  const p1Comm = match.p1CurrentInputs;
  const p2Comm = match.p2CurrentInputs;
  const p1Preview = isViewerP1
    ? { startX, power, angleDeg }
    : p1Comm
    ? { startX: p1Comm.startX, power: p1Comm.power, angleDeg: p1Comm.angleDeg }
    : { startX: 250, power: 50, angleDeg: 0 };
  const p2Preview = isViewerP1
    ? p2Comm
      ? { startX: p2Comm.startX, power: p2Comm.power, angleDeg: p2Comm.angleDeg }
      : { startX: 250, power: 50, angleDeg: 0 }
    : { startX, power, angleDeg };
  // Latest fellOut flags (user-flagged "balls stick in the walls"
  // bug). Drives the opacity-0 fade-out animation in <PlinkoBoard/>.
  const latestP1FellOut = Boolean(latestRound?.player1Result?.fellOut);
  const latestP2FellOut = Boolean(latestRound?.player2Result?.fellOut);

  // Effective "ready" values for the side-panel chips. The local
  // viewer's own seat uses the optimistic `localReady` OR the
  // server's `p{N}Ready` so that the second player to click Ready
  // sees their chip toggle immediately (the server resolves both-
  // ready state in one transaction — see localReady useEffect for
  // the matching auto-reset on the next ball). The OPPONENT's
  // panel always uses raw server state because we have no signal
  // to fake the opponent with — the polling cadence still surfaces
  // their commits within ~800ms.
  const p1PanelReady = isViewerP1
    ? (localReady || match.p1Ready)
    : match.p1Ready;
  const p2PanelReady = !isViewerP1
    ? (localReady || match.p2Ready)
    : match.p2Ready;

  // ── Status banner sub-component ────────────────────────────────
  function renderStatusBanner() {
    if (isCancelled) {
      return (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-4 py-3 text-red-200">
          <AlertIcon className="w-5 h-5 text-red-300" />
          <span className="font-semibold">This match was cancelled.</span>
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
      const bothReady = match.p1Ready && match.p2Ready;
      if (bothReady) {
        return (
          <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-3 text-emerald-200 animate-pulse">
            <span className="font-bold text-base sm:text-lg">
              Both ready — launching both balls!
            </span>
          </div>
        );
      }
      const urgentMatch = match.viewerCanLaunch && urgent;
      return (
        <div
          className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border px-4 py-3 ${
            urgentMatch
              ? "border-red-400/60 bg-red-900/30 text-red-200 animate-pulse"
              : "border-cyan-300/40 bg-cyan-500/10 text-cyan-200"
          }`}
        >
          <span className="font-bold text-base sm:text-lg">
            {match.viewerCanLaunch
              ? "Adjust your inputs and click Ready"
              : match.viewerHasCommitted
                ? "You're ready — waiting for opponent"
                : "Opponent is choosing inputs…"}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold ${
              urgentMatch
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
    return null;
  }

  // ── Between-rounds banner ─────────────────────────────────────
  function renderBetweenBallsBanner() {
    if (phase === "finished" || roundPopup) return null;
    if (phase !== "transitioning") return null;
    // Use displayBall (which lags behind server currentBall until
    // popup is dismissed) to derive the next ball number. When
    // transitioning after ball 1, displayBall is still 1, so next
    // is 2. Only show if there IS a next ball.
    const nextBall = displayBall + 1;
    if (nextBall > REQUIRED_BALLS) return null;
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-yellow-300/40 bg-yellow-500/10 px-4 py-3 text-yellow-200">
        <LoadingDotsIcon className="w-5 h-5 text-yellow-200 animate-pulse" />
        <span className="font-semibold">
          Round {nextBall} incoming…
        </span>
      </div>
    );
  }

  // ── Winner popup (shown when match finishes) ────────────────────
  function renderWinnerPopup() {
    if (!isFinished) return null;
    const isDraw = match.result === RESULT.TIE;
    const iWon = Boolean(
      match.winnerId && user?.id && match.winnerId === user.id,
    );
    const p1Name = match?.players?.p1?.displayName || "Player 1";
    const p2Name = match?.players?.p2?.displayName || "Player 2";
    const pointDiff = Math.abs((match.p1Score || 0) - (match.p2Score || 0));
    const winnerName = isDraw
      ? null
      : match.result === RESULT.PLAYER1
        ? p1Name
        : p2Name;
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

          {/* Result callout */}
          <p
            className={`text-center text-3xl font-black mt-2 ${
              isDraw
                ? "text-yellow-300"
                : iWon
                  ? "text-emerald-300"
                  : "text-red-300"
            }`}
          >
            {isDraw ? "It's a Draw!" : iWon ? "You Win!" : "You Lose"}
          </p>

          {/* Winner detail */}
          {!isDraw && winnerName && (
            <p className="text-center text-sm text-white/70 mt-2">
              <span className="font-bold text-white">{winnerName}</span> won
              by <span className="font-bold text-white">{pointDiff} point{pointDiff !== 1 ? "s" : ""}</span>
            </p>
          )}

          {/* Round indicator — signals which round the match was decided in */}
          <p className="text-center text-[11px] uppercase tracking-wider text-cyan-200/60 font-semibold mt-3">
            {match.currentBall > REQUIRED_BALLS
              ? `Overtime · Round ${match.currentBall}`
              : `Decided in Round ${match.currentBall || REQUIRED_BALLS}`}
          </p>

          {/* Score summary */}
          <div className="grid grid-cols-2 gap-4 mt-5">
            <div className="rounded-xl border border-cyan-300/30 bg-cyan-500/10 p-3 text-center">
              <p className="text-[10px] uppercase tracking-wider text-cyan-200/70 truncate">{p1Name}</p>
              <p className="mt-1 text-2xl font-black text-cyan-100 tabular-nums">
                {match.p1Score} pts
              </p>
            </div>
            <div className="rounded-xl border border-fuchsia-300/30 bg-fuchsia-500/10 p-3 text-center">
              <p className="text-[10px] uppercase tracking-wider text-fuchsia-200/70 truncate">{p2Name}</p>
              <p className="mt-1 text-2xl font-black text-fuchsia-100 tabular-nums">
                {match.p2Score} pts
              </p>
            </div>
          </div>

          {/* Prize info */}
          {!isDraw && (
            <p className="text-center text-xs text-white/60 mt-4">
              Prize paid:{" "}
              <span className="text-white font-bold">
                ${(match.prizePaid || 0).toFixed(2)}
              </span>
            </p>
          )}
          {isDraw && (
            <p className="text-center text-xs text-white/60 mt-4">
              {match.houseFee > 0
                ? `Each player refunded $${(Number(match.stakeAmount) * 0.95).toFixed(2)} (5% house fee)`
                : "Both players refunded — no house fee"}
            </p>
          )}

          {/* Back to lobby button */}
          <button
            onClick={() => router.push("/casino/plinko")}
            className="mt-6 w-full px-4 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-400 to-cyan-500 text-[#001933] hover:from-cyan-300 hover:to-cyan-400 transition shadow-[0_0_25px_rgba(0,229,255,0.4)]"
          >
            Back to Lobby
          </button>
        </div>
      </motion.div>
    );
  }

  // ── Main layout: grid on desktop, vertical stack on mobile ─────
  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto mt-3 sm:mt-4 max-w-[1400px]">
        {/* Title + status banners */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PlinkoIcon className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
            <h1 className="text-lg sm:text-xl font-black tracking-tight">
              Plinko Duel · Match #{matchId ?? "?"}
            </h1>
          </div>
          <div className="text-[11px] sm:text-xs text-white/60 flex items-center gap-3">
            <span className="font-mono">${stake.toFixed(2)} stake</span>
            <span className="font-mono">Best-score-of-3</span>
            <span className="font-mono">{viewerSeat === "player1" ? "P1" : "P2"} seat</span>
          </div>
        </div>

        <div className="mt-3">{renderStatusBanner()}</div>

        {/* Ball counter (mobile only — on desktop the side panels have
            a "Total" indicator we keep, plus the counter lives next to
            the board). */}
        <div className="mt-2 flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-xs uppercase tracking-wider text-white/70">
            <span>Round</span>
            <span className="font-black text-white text-base tabular-nums">
              {displayBall}
              <span className="text-white/40 text-sm">/{REQUIRED_BALLS}</span>
            </span>
          </div>
        </div>

        {/* 3-column layout (mobile: stacked) */}
        <div className="mt-4 grid gap-4 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_300px]">
          {/* Player 1 panel (left) */}
          <div className="order-2 lg:order-1">
            <PlayerSidePanel
              seat="player1"
              displayName={p1Name}
              avatarUrl={p1Avatar}
              totalScore={match.p1Score}
              lastBallDelta={p1Delta}
              isViewer={isViewerP1}
              ready={p1PanelReady}
              isCurrent={isLaunchable && !isFinished && !isCancelled}
              isFinished={isFinished}
              startedX={isViewerP1 ? startX : opponentStartX}
              power={isViewerP1 ? power : opponentPower}
              angleDeg={isViewerP1 ? angleDeg : opponentAngle}
              setStartX={isViewerP1 ? setStartX : () => {}}
              setPower={isViewerP1 ? setPower : () => {}}
              setAngleDeg={isViewerP1 ? setAngleDeg : () => {}}
              onReady={() => handleReady()}
              busy={busy}
              inputsLocked={Boolean(match.p1CurrentInputs)}
            />
          </div>

          {/* Center: board */}
          <div className="order-1 lg:order-2 min-w-0">
            <PlinkoBoard
              p1BallPos={p1BallPos}
              p2BallPos={p2BallPos}
              highlightBucket={highlightBucket}
              p1FellOut={latestP1FellOut}
              p2FellOut={latestP2FellOut}
              p1Preview={showVisor ? p1Preview : null}
              p2Preview={showVisor ? p2Preview : null}
              showVisor={showVisor}
            />
            <div className="mt-3">{renderBetweenBallsBanner()}</div>
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
            {migrationIncomplete && (
              <div className="mt-3 mx-auto max-w-md rounded-xl border border-amber-400/40 bg-amber-900/30 p-3 text-sm text-amber-100 flex items-start gap-2">
                <AlertIcon className="w-4 h-4 shrink-0 text-amber-300 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold">
                    Plinko Duel schema is out of date on this server.
                  </p>
                  <p className="mt-1 text-amber-200/80">
                    Run <code className="px-1 rounded bg-black/40 text-amber-100">npm run db:migrate</code>{" "}
                    (or paste migration{" "}
                    <code className="px-1 rounded bg-black/40 text-amber-100">0053_plinko_pvp_schema_safety_net.sql</code>{" "}
                    into the Neon SQL console) to add the{" "}
                    <code className="px-1 rounded bg-black/40 text-amber-100">p1_ready</code> /{" "}
                    <code className="px-1 rounded bg-black/40 text-amber-100">p2_ready</code>{" "}
                    columns, then refresh this page.
                  </p>
                </div>
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
            <PlayerSidePanel
              seat="player2"
              displayName={p2Name}
              avatarUrl={p2Avatar}
              totalScore={match.p2Score}
              lastBallDelta={p2Delta}
              isViewer={!isViewerP1}
              ready={p2PanelReady}
              isCurrent={isLaunchable && !isFinished && !isCancelled}
              isFinished={isFinished}
              startedX={!isViewerP1 ? startX : opponentStartX}
              power={!isViewerP1 ? power : opponentPower}
              angleDeg={!isViewerP1 ? angleDeg : opponentAngle}
              setStartX={!isViewerP1 ? setStartX : () => {}}
              setPower={!isViewerP1 ? setPower : () => {}}
              setAngleDeg={!isViewerP1 ? setAngleDeg : () => {}}
              onReady={() => handleReady()}
              busy={busy}
              inputsLocked={Boolean(match.p2CurrentInputs)}
            />
          </div>
        </div>

        {renderWinnerPopup()}

        {/* Round result popup */}
        {roundPopup && (
          <RoundPopup
            p1Points={roundPopup.p1Points}
            p2Points={roundPopup.p2Points}
            p1FellOut={roundPopup.p1FellOut}
            p2FellOut={roundPopup.p2FellOut}
            ballNumber={roundPopup.ballNumber}
            p1Name={match?.players?.p1?.displayName || "Player 1"}
            p2Name={match?.players?.p2?.displayName || "Player 2"}
            onNextRound={onNextRound}
            isLastBall={
              // The popup only ever renders for balls 1-3 (overtime
              // ball 4 skips it), so "View Final Results" applies
              // exactly when this was the last normal ball AND the
              // match is not going to a 4th tiebreaker round.
              roundPopup.ballNumber >= REQUIRED_BALLS &&
              match?.p1Score !== match?.p2Score
            }
          />
        )}
      </div>

      <Footer />
    </div>
  );
}
