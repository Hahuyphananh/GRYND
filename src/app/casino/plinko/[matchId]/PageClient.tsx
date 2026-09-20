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

import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import { motion, useReducedMotion } from "framer-motion";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import ReportModal from "../../../../components/ReportModal";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import FrameAvatar from "../../../../components/FrameAvatar";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the match actually begins,
// auto-stops when it ends or the user quits. No gameplay logic touched.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorModeShell,
  CreatorView,
  ShellHeader,
  ShellMain,
  ShellAside,
} from "../../../../components/creator-mode/CreatorModeLayout";
import { IconLock, IconFlag } from "@tabler/icons-react";
import { useSocket } from "../../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import { playVictory, playDefeat, playTick } from "../../../../lib/gameAudio";
import { withReducedMotion } from "../../../../lib/animations";
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

// Short launch window at the START of every ball animation. The ball visibly
// leaves the launch visor at the player's chosen startX and drops into the
// board before the server trajectory takes over. Kept inside the 150–300ms
// band so the launch reads as immediate, and skipped entirely when the user
// prefers reduced motion. It never changes the trajectory — it only delays
// the trajectory's t = 0 to the moment the launch envelope ends.
const LAUNCH_MS = 220;
// Y the launch drop starts from. Matches the launch visor's preview row
// (VISOR_Y) so the preview ball and the live launching ball are continuous.
const LAUNCH_FROM_Y = 12;

// Duration of the brief peg-impact pop. Within the 60–140ms band so it reads
// as an impact tap, not a persistent effect. Purely a display cue derived
// from the authoritative trajectory — it never affects gameplay.
const PEG_HIT_MS = 110;

// Landing feedback timings (the ball settle itself is 140ms, defined in the
// CSS keyframe). The ball holds at the bucket while the bucket pop and
// multiplier reveal play, then the round popup takes over. Reduced motion
// collapses the hold to 0 so results still appear immediately.
// The strongest landing cue is the precision multiplier reveal at 340ms (see
// globals.css). The landing state and the hold must both outlast it, otherwise
// the cue is stripped mid-animation and the multiplier snaps back early.
const MULTIPLIER_MS = 360; // bucket + multiplier reveal lifetime
const LANDING_HOLD_MS = 360; // pause before the round popup is shown

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

// Animated pose of a live ball. x/y are SVG coordinates; scaleX/scaleY carry
// the brief launch squash/stretch and are both 1 during the server trajectory.
type BallPose = {
  x: number;
  y: number;
  scaleX?: number;
  scaleY?: number;
};

type PlayerHead = {
  id: string;
  displayName: string;
  iconKey: string | null;
  profileFrame?: unknown;
  nameColor?: string | null;
  missing?: boolean;
};

type NormalisedMatch = {
  id: number;
  player1Id: string;
  player2Id: string | null;
  isAi: boolean;
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
  pegHits,
  bucketLandings,
  ballSettle,
}: {
  p1BallPos: BallPose | null;
  p2BallPos: BallPose | null;
  highlightBucket: { index: number; side: "p1" | "p2" } | null;
  p1FellOut?: boolean;
  p2FellOut?: boolean;
  p1Preview?: { startX: number; power: number; angleDeg: number } | null;
  p2Preview?: { startX: number; power: number; angleDeg: number } | null;
  showVisor?: boolean;
  // peg index -> hit token. A changed token remounts the circle so the CSS
  // pop restarts; the entry is removed a moment later by the match view.
  pegHits?: Record<number, number>;
  // Landing events for the current resolved ball (server bucket index/points).
  bucketLandings?: Array<{
    index: number;
    side: "p1" | "p2";
    points: number;
    token: number;
  }>;
  // Non-zero token triggers the ball's one-shot settle bounce; 0 clears it.
  ballSettle?: number;
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

        {PEGS.map((peg, i) => {
          const hitToken = pegHits?.[i];
          const isHit = hitToken !== undefined;
          return (
            <circle
              key={isHit ? `${i}-${hitToken}` : i}
              cx={peg.x}
              cy={peg.y}
              r={PEG_RADIUS}
              fill={isHit ? "#eafcff" : "#a8e8ff"}
              opacity={isHit ? 1 : 0.85}
              className={isHit ? "plinko-peg-hit" : undefined}
            />
          );
        })}

        {BUCKETS.map((b) => {
          const isHighlighted =
            highlightBucket && highlightBucket.index === b.index;
          // Landing feedback for this bucket (from the server's result). The
          // high-value precision buckets get the slightly stronger variant.
          const landing = bucketLandings?.find((l) => l.index === b.index);
          const landToken = landing?.token;
          const strong = (landing?.points ?? 0) >= 140;
          const rectClass = landing
            ? `plinko-bucket-land${strong ? " plinko-bucket-land-strong" : ""}`
            : undefined;
          const pointsClass = landing
            ? `plinko-bucket-points-reveal${strong ? " plinko-bucket-points-reveal-strong" : ""}`
            : undefined;
          return (
            <g key={b.index}>
              <rect
                key={landing ? `rect-${b.index}-${landToken}` : `rect-${b.index}`}
                className={rectClass}
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
                key={landing ? `pts-${b.index}-${landToken}` : `pts-${b.index}`}
                className={pointsClass}
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
          <g
            style={{ transition: `opacity ${FALL_OUT_FADE_MS}ms ease-out`, opacity: p2FellOut ? 0 : 1 }}
            transform={`translate(${p2BallPos.x} ${p2BallPos.y}) scale(${p2BallPos.scaleX ?? 1} ${p2BallPos.scaleY ?? 1})`}
          >
            <g
              key={ballSettle ? `settle-p2-${ballSettle}` : "settle-p2"}
              className={ballSettle ? "plinko-ball-settle" : undefined}
            >
              <circle
                cx={0}
                cy={0}
                r={BALL_RADIUS + 2}
                fill="#ff4fd8"
                opacity="0.25"
              />
              <circle
                cx={0}
                cy={0}
                r={BALL_RADIUS}
                fill="url(#ballMagenta)"
                stroke="#fff"
                strokeWidth="1.5"
              />
            </g>
          </g>
        )}

        {p1BallPos && (
          <g
            style={{ transition: `opacity ${FALL_OUT_FADE_MS}ms ease-out`, opacity: p1FellOut ? 0 : 1 }}
            transform={`translate(${p1BallPos.x} ${p1BallPos.y}) scale(${p1BallPos.scaleX ?? 1} ${p1BallPos.scaleY ?? 1})`}
          >
            <g
              key={ballSettle ? `settle-p1-${ballSettle}` : "settle-p1"}
              className={ballSettle ? "plinko-ball-settle" : undefined}
            >
              <circle
                cx={0}
                cy={0}
                r={BALL_RADIUS + 2}
                fill="#00e5ff"
                opacity="0.25"
              />
              <circle
                cx={0}
                cy={0}
                r={BALL_RADIUS}
                fill="url(#ballCyan)"
                stroke="#fff"
                strokeWidth="1.5"
              />
            </g>
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
  // Shared reduced-motion helper: with motion off the panel is simply there
  // (no scale-in), so the countdown/inputs stay immediately usable.
  const shouldReduce = useReducedMotion();
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
      {...withReducedMotion(shouldReduce, {
        initial: { opacity: 0, scale: 0.9 },
        animate: { opacity: 1, scale: 1 },
      })}
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
            Both balls went out of bounds. Better luck next time!
          </p>
        )}

        {/* Single fell out message */}
        {((p1FellOut && !p2FellOut) || (!p1FellOut && p2FellOut)) && (
          <p className="text-center text-[12px] text-yellow-300/80 mt-4">
            {p1FellOut ? p1Name : p2Name}&apos;s ball fell out. 0 points!
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
  // isOpponent=true: blur the panel + render a " Opponent
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
              Lock &quot;Ready&quot;. When both players are ready, both balls launch at once.
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
            Sits above the blurred content with a clear
            "Opponent choosing…" hint so the viewer knows the
            sliders are intentionally hidden, not broken. */}
        {isOpponent && (
          <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[#000a14]/55 backdrop-blur-[1px] pointer-events-none">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[12px] font-semibold ${
              theme === "cyan"
                ? "bg-cyan-500/15 border-cyan-300/40 text-cyan-100"
                : "bg-fuchsia-500/15 border-fuchsia-300/40 text-fuchsia-100"
            }`}>
              <IconLock size={14} />
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
  avatarKey,
  profileFrame,
  nameColor,
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
  emoteBubble,
  onSendEmote,
}: {
  seat: "player1" | "player2";
  displayName: string;
  avatarKey?: string | null;
  profileFrame?: unknown;
  nameColor?: string | null;
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
  emoteBubble?: { value: string; kind?: string } | null;
  onSendEmote?: (emote: { value: string; kind?: string }) => void;
}) {
  const shouldReduce = useReducedMotion();
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
    lockedHint = `You're ready. Waiting for opponent`;
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
            className={`relative flex items-center gap-1.5 text-sm font-bold ${headerColour} truncate`}
            title={displayName}
          >
            {/* Official Grynd icon — previously passed as `avatarKey` but
                never rendered. Falls back to a letter circle when the key
                is missing/invalid. */}
            <FrameAvatar frame={profileFrame} iconKey={avatarKey} name={displayName} size="h-5 w-5" />
            <span
              className="truncate"
              style={nameColor ? { color: nameColor } : undefined}
            >
              {displayName}
            </span>
            <EmoteBubble emote={emoteBubble} side={isViewer ? "mine" : "incoming"} />
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
        {...withReducedMotion(shouldReduce, {
          initial: { scale: 0.82, opacity: 0.55 },
          animate: { scale: 1, opacity: 1 },
          transition: { type: "spring", stiffness: 380, damping: 26 },
        })}
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

      {/* Emotes — picker only on the viewer&apos;s own panel, near the
          action controls. The bubble itself is anchored to the name. */}
      {isViewer && onSendEmote && (
        <div className="mt-1 flex justify-center">
          <EmotePicker compact hideBubbles onSend={onSendEmote} />
        </div>
      )}
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
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: matchId ? `plinko:emote:${matchId}` : null,
    eventName: "plinko:emote",
    selfId: user?.id,
  });

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
  const [forfeiting, setForfeiting] = useState(false);
  // Report modal — flags the human opponent for moderation.
  const [showReportModal, setShowReportModal] = useState(false);

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
    p1: BallPose | null;
    p2: BallPose | null;
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
  // Fire-and-forget ball-drop audio ticks. Tracked so a tick scheduled just
  // before the view unmounts can't fire into a torn-down component.
  const tickTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
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

  // prefers-reduced-motion is read through a ref so the animation callback
  // (created once per ball) doesn't need it in its dependency list.
  const prefersReducedMotion = useReducedMotion();
  const reduceMotionRef = useRef(false);
  useEffect(() => {
    reduceMotionRef.current = Boolean(prefersReducedMotion);
  }, [prefersReducedMotion]);

  // ── Peg-impact feedback ──────────────────────────────────────────
  // `pegHits` maps a peg index to a hit token; the match view fires it only
  // for genuine contacts derived from the authoritative trajectory (see
  // buildSampling). One timer per peg index is kept — a re-hit clears the
  // previous timer — so rapid, consecutive collisions can't accumulate stale
  // timers or leave a peg stuck lit. Skipped under reduced motion.
  const [pegHits, setPegHits] = useState<Record<number, number>>({});
  const pegHitTimersRef = useRef<
    Map<number, ReturnType<typeof setTimeout>>
  >(new Map());
  const pegHitTokenRef = useRef(0);

  const firePegHit = useCallback((index: number) => {
    if (reduceMotionRef.current) return;
    const timers = pegHitTimersRef.current;
    const existing = timers.get(index);
    if (existing) clearTimeout(existing);
    pegHitTokenRef.current += 1;
    const token = pegHitTokenRef.current;
    setPegHits((prev) => ({ ...prev, [index]: token }));
    const timer = setTimeout(() => {
      timers.delete(index);
      setPegHits((prev) => {
        // Only clear the hit this timer started; a newer hit owns the peg.
        if (prev[index] !== token) return prev;
        const next = { ...prev };
        delete next[index];
        return next;
      });
    }, PEG_HIT_MS);
    timers.set(index, timer);
  }, []);

  const clearPegHits = useCallback(() => {
    for (const t of pegHitTimersRef.current.values()) clearTimeout(t);
    pegHitTimersRef.current.clear();
    setPegHits({});
  }, []);

  // ── Bucket landing feedback ──────────────────────────────────────
  // Fired once when a ball's animation reaches t = 1, using ONLY the server's
  // bucketIndex/points. `bucketLandings` drives the bucket pop + multiplier
  // reveal; `ballSettleToken` triggers the ball's settle bounce. Both are
  // transient and reset at the start of every ball, so a new ball can never
  // inherit the previous ball's landing animation. Skipped under reduced
  // motion (the CSS is also disabled by a media query).
  const [bucketLandings, setBucketLandings] = useState<
    Array<{ index: number; side: "p1" | "p2"; points: number; token: number }>
  >([]);
  const [ballSettleToken, setBallSettleToken] = useState(0);
  const bucketLandingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const landingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const landingTokenRef = useRef(0);

  const showBucketLanding = useCallback(
    (events: Array<{ index: number; side: "p1" | "p2"; points: number }>) => {
      if (reduceMotionRef.current || events.length === 0) return;
      landingTokenRef.current += 1;
      const token = landingTokenRef.current;
      setBucketLandings(events.map((e) => ({ ...e, token })));
      if (bucketLandingTimerRef.current)
        clearTimeout(bucketLandingTimerRef.current);
      bucketLandingTimerRef.current = setTimeout(() => {
        bucketLandingTimerRef.current = null;
        setBucketLandings([]);
      }, MULTIPLIER_MS);
    },
    [],
  );

  const clearLandingState = useCallback(() => {
    if (bucketLandingTimerRef.current) {
      clearTimeout(bucketLandingTimerRef.current);
      bucketLandingTimerRef.current = null;
    }
    if (landingTimerRef.current) {
      clearTimeout(landingTimerRef.current);
      landingTimerRef.current = null;
    }
    setBucketLandings([]);
    setBallSettleToken(0);
  }, []);

  // Never leave peg or landing timers running after the view goes away.
  useEffect(
    () => () => {
      for (const t of pegHitTimersRef.current.values()) clearTimeout(t);
      pegHitTimersRef.current.clear();
      if (bucketLandingTimerRef.current)
        clearTimeout(bucketLandingTimerRef.current);
      if (landingTimerRef.current) clearTimeout(landingTimerRef.current);
    },
    [],
  );

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
    // The per-match socket room (PLINKO_PVP_MATCH_UPDATED) pushes
    // opponent commits / round resolutions / match-end instantly, so
    // this HTTP poll is now a reconnect/consistency safety net, not the
    // primary sync path. Held at 5s (was 800ms before the socket path)
    // to keep match-time DB reads minimal — the launch window is driven
    // by the server's round deadline + local clock, not the poll rate.
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // ── AI launch recovery ───────────────────────────────────────────
  // The human remains fully interactive while the bot submits through
  // the same /launch transaction. A retry counter handles transient
  // network/server failures without making the AI client-authoritative.
  const [aiRetry, setAiRetry] = useState(0);
  const aiTurnKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const launchable =
      match?.status === MATCH_STATUS.BALL_1 ||
      match?.status === MATCH_STATUS.BALL_2 ||
      match?.status === MATCH_STATUS.BALL_3 ||
      match?.status === MATCH_STATUS.BALL_4;
    if (!match?.isAi || !matchId || !launchable || match.p2CurrentInputs) {
      if (!launchable || match?.status === MATCH_STATUS.FINISHED || match?.status === MATCH_STATUS.CANCELLED) {
        aiTurnKeyRef.current = null;
      }
      return;
    }

    const key = `${matchId}:${match.currentBall}`;
    if (aiTurnKeyRef.current === key) return;
    const timer = setTimeout(async () => {
      if (aiTurnKeyRef.current === key) return;
      aiTurnKeyRef.current = key;
      try {
        const response = await fetch(`/api/plinko-pvp/match/${matchId}/ai-turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        const json = await response.json().catch(() => ({}));
        if (response.ok && json?.success) {
          socket?.emit("room_event", {
            roomId: plinkoPvpMatchRoom(matchId),
            event: PLINKO_PVP_MATCH_UPDATED,
          });
          await fetchStatus();
        } else if (response.status >= 500 || response.status === 0) {
          aiTurnKeyRef.current = null;
          setAiRetry((value) => value + 1);
        } else {
          // A 409/400 normally means the human or another request moved
          // the locked row; polling reconciles the authoritative state.
          await fetchStatus();
        }
      } catch {
        aiTurnKeyRef.current = null;
        setAiRetry((value) => value + 1);
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [
    aiRetry,
    fetchStatus,
    match?.currentBall,
    match?.isAi,
    match?.p2CurrentInputs,
    match?.status,
    matchId,
    socket,
  ]);

  // ── Socket subscription ──────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    if (!isValidMatchId) return;
    const refresh = () => fetchStatus();
    const roomId = plinkoPvpMatchRoom(matchId);
    // Re-join on EVERY socket (re)connection — Socket.IO doesn't re-join
    // rooms automatically, and the realtime server's disconnect grace
    // timer is only cancelled by a re-join (otherwise a refresh or
    // network blip would forfeit the match once the grace window expires).
    const join = () => socket.emit("join_room", { roomId });
    join();
    socket.on("connect", join);
    socket.on(PLINKO_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.off("connect", join);
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
      // Match result — one shot on the finished transition.
      const isDraw = match.result === RESULT.TIE;
      const iWon = Boolean(
        match.winnerId && user?.id && match.winnerId === user.id,
      );
      if (isDraw) playTick();
      else if (iWon) playVictory();
      else playDefeat();
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
    // Ball-drop tick sequence — three quick ticks as the balls drop.
    // The two delayed ticks are tracked (and re-tracked per ball) so they are
    // always cleared together instead of outliving the animation.
    playTick();
    for (const t of tickTimersRef.current) clearTimeout(t);
    tickTimersRef.current = [
      setTimeout(() => playTick(), 130),
      setTimeout(() => playTick(), 260),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds]);

  // Build the animation's sampling data from the authoritative server path.
  //
  // The server path is a discrete polyline (a point every couple of physics
  // substeps, deduped to >= 1px). Sampling it by linearly hopping between
  // those sparse points gives hard direction changes at every vertex and,
  // because the points are unevenly spaced, an uneven, stuttery visual speed.
  // To fix that WITHOUT touching the physics we:
  //   1. resample the polyline through a Cardinal spline (tension 0.5) so the
  //      ball curves through corners instead of snapping between them;
  //   2. force the exact server start AND end points into the curve, so the
  //      displayed endpoint is always the server's endpoint — never inferred;
  //   3. build an arc-length table over the dense curve, so progress `t` maps
  //      to even spatial travel and the ball never pauses at a simulation
  //      point.
  // No randomness, no physics change — a smoother read of the same path.
  function buildSampling(path: Path) {
    if (path.length <= 1) {
      return { points: path, cumStarts: [0], totalLen: 0, events: [] };
    }

    // Cardinal spline resampling. It passes through every server point and,
    // with tension 0.5 (tangents halved), stays close to the polyline — it
    // rounds bounce corners without overshooting the board.
    const CR_SAMPLES = 4;
    const dense: { x: number; y: number }[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p0 = path[i - 1] ?? path[i];
      const p1 = path[i];
      const p2 = path[i + 1];
      const p3 = path[i + 2] ?? path[i + 1];
      for (let s = 0; s < CR_SAMPLES; s++) {
        dense.push(cardinalPoint(p0, p1, p2, p3, s / CR_SAMPLES));
      }
    }
    // Exact server endpoint (the loop above stops just short of it).
    const end = path[path.length - 1];
    dense.push({ x: end.x, y: end.y });

    // Arc-length table over the dense curve.
    const cumStarts: number[] = [0];
    let totalLen = 0;
    for (let i = 1; i < dense.length; i++) {
      const dx = dense[i].x - dense[i - 1].x;
      const dy = dense[i].y - dense[i - 1].y;
      totalLen += Math.sqrt(dx * dx + dy * dy);
      cumStarts.push(totalLen);
    }

    // Derive the peg-contact moments from the rendered curve. A contact is a
    // dense sample within (ball radius + peg radius) of a peg — exactly the
    // physics collision distance — so this reads the authoritative trajectory
    // rather than running a second simulation. Consecutive samples on the same
    // peg collapse into one event; `t` is the arc-length position the animator
    // already uses, so no extra timing state is needed.
    const events: Array<{ index: number; t: number }> = [];
    const contactSq = (BALL_RADIUS + PEG_RADIUS + 0.75) ** 2;
    let lastPeg = -1;
    for (let i = 0; i < dense.length; i++) {
      const pt = dense[i];
      let contact = -1;
      for (let p = 0; p < PEGS.length; p++) {
        const dx = pt.x - PEGS[p].x;
        const dy = pt.y - PEGS[p].y;
        if (dx * dx + dy * dy <= contactSq) {
          contact = p;
          break;
        }
      }
      if (contact >= 0 && contact !== lastPeg && totalLen > 0) {
        events.push({ index: contact, t: cumStarts[i] / totalLen });
      }
      lastPeg = contact;
    }

    return { points: dense, cumStarts, totalLen, events };
  }

  // Cardinal spline (Hermite form) through p1..p2 with p0/p3 as tangent
  // neighbours. tension 0 = Catmull-Rom, 1 = straight line; 0.5 keeps the
  // path smooth while staying close to the server polyline.
  function cardinalPoint(
    p0: { x: number; y: number },
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
    t: number,
    tension = 0.5,
  ) {
    const t2 = t * t;
    const t3 = t2 * t;
    const k = (1 - tension) / 2;
    const m1x = k * (p2.x - p0.x);
    const m1y = k * (p2.y - p0.y);
    const m2x = k * (p3.x - p1.x);
    const m2y = k * (p3.y - p1.y);
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return {
      x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
      y: h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y,
    };
  }

  // Sample the dense, arc-length-parameterised curve at progress `t` in
  // [0, 1]. Interpolation here is between DENSE (sub-pixel) samples, so the
  // motion reads as continuous rather than hopping between the server's
  // sparse points. `t` never rewinds, so the ball never jumps backward.
  function samplePath(
    sampling: {
      points: Array<{ x: number; y: number }>;
      cumStarts: number[];
      totalLen: number;
    },
    t: number,
  ): { x: number; y: number } {
    const points = sampling.points;
    if (points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1 || sampling.totalLen === 0) {
      const last = points[points.length - 1];
      return { x: last.x, y: last.y };
    }
    const clampedT = Math.max(0, Math.min(1, t));
    const targetDist = clampedT * sampling.totalLen;
    let segIdx = 0;
    for (let i = 0; i < points.length - 1; i++) {
      if (sampling.cumStarts[i + 1] >= targetDist) {
        segIdx = i;
        break;
      }
      segIdx = i;
    }
    const segStartDist = sampling.cumStarts[segIdx];
    const segLen = sampling.cumStarts[segIdx + 1] - segStartDist;
    const localT = segLen === 0 ? 0 : (targetDist - segStartDist) / segLen;
    const p0 = points[segIdx];
    const p1 = points[segIdx + 1];
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
      // Drop any peg/landing feedback left over from the previous ball so a
      // new animation can't inherit stale highlights or timers.
      clearPegHits();
      clearLandingState();

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
      const p1Sampling = buildSampling(p1Path);
      const p2Sampling = buildSampling(p2Path);

      // Launch window for this ball (0 when reduced motion is preferred).
      // Resolved once, up front, so the initial pose and the rAF loop agree.
      const launchMs = reduceMotionRef.current ? 0 : LAUNCH_MS;

      // Initial pose: at the launch chute (same row the visor preview sat on)
      // so the ball is visible immediately and drops into the board — unless
      // reduced motion is on, in which case it starts on the trajectory.
      const launchStartY = launchMs > 0 ? LAUNCH_FROM_Y : null;
      const initial: {
        p1: BallPose | null;
        p2: BallPose | null;
      } = { p1: null, p2: null };
      if (p1Path.length > 0) {
        initial.p1 = {
          x: p1Path[0].x,
          y: launchStartY ?? p1Path[0].y,
          scaleX: 1,
          scaleY: 1,
        };
      }
      if (p2Path.length > 0) {
        initial.p2 = {
          x: p2Path[0].x,
          y: launchStartY ?? p2Path[0].y,
          scaleX: 1,
          scaleY: 1,
        };
      }
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
      // Forward-only cursors into each ball's contact list. Because `t` only
      // increases, every event fires exactly once per ball and nothing replays
      // on a re-render.
      let p1PegCursor = 0;
      let p2PegCursor = 0;

      const tick = (now: number) => {
        if (cancelled) return;
        const elapsed = Math.max(0, now - startTime);

        // ── Launch envelope ──────────────────────────────────────────
        // The ball drops from the launch chute at the player's chosen
        // startX into the trajectory's first frame. Gravity-style ease-in
        // plus a subtle squash/stretch makes it read like an arcade drop
        // rather than a generic UI fade. x stays at path[0].x throughout,
        // so the player's selected launch position stays visually clear.
        if (elapsed < launchMs) {
          const lt = elapsed / launchMs; // 0 → 1 across the launch window
          const eased = lt * lt; // accelerate like gravity
          const squash = Math.sin(Math.PI * lt); // 0 → 1 → 0
          const scaleX = 1 - 0.16 * squash;
          const scaleY = 1 + 0.24 * squash;
          const launchPose: {
            p1: BallPose | null;
            p2: BallPose | null;
          } = { p1: null, p2: null };
          if (p1Path.length > 0) {
            const p0 = p1Path[0];
            launchPose.p1 = {
              x: p0.x,
              y: LAUNCH_FROM_Y + (p0.y - LAUNCH_FROM_Y) * eased,
              scaleX,
              scaleY,
            };
          }
          if (p2Path.length > 0) {
            const p0 = p2Path[0];
            launchPose.p2 = {
              x: p0.x,
              y: LAUNCH_FROM_Y + (p0.y - LAUNCH_FROM_Y) * eased,
              scaleX,
              scaleY,
            };
          }
          setBallPositions(launchPose);
          rafId = requestAnimationFrame(tick);
          return;
        }

        // ── Server trajectory ────────────────────────────────────────
        // Offset by launchMs so progress 0 lands exactly on the path's first
        // point the moment the launch envelope ends — a clean hand-off with
        // no jump. The progress is then biased for a physical arcade read:
        // a non-zero start speed that blends with the launch and accelerates
        // toward the bucket (downward momentum). Endpoints are exact
        // (raw 0→0, raw 1→1), so the ball still finishes precisely on the
        // server's final point. Monotonic, so the ball never moves backward.
        const raw = Math.min(1, (elapsed - launchMs) / BALL_ANIMATION_MS);
        const t = raw * (0.35 + 0.65 * raw);

        // Sample both paths from the SAME `t` value in the same RAF
        // callback. Update BOTH positions via a single setBallPositions
        // call so both go through one React render and never get
        // scheduled a frame apart (the original bug: two independent
        // setStates inside a RAF can render separately).
        const next: {
          p1: BallPose | null;
          p2: BallPose | null;
        } = {
          p1:
            p1Path.length > 0
              ? { ...samplePath(p1Sampling, t), scaleX: 1, scaleY: 1 }
              : null,
          p2:
            p2Path.length > 0
              ? { ...samplePath(p2Sampling, t), scaleX: 1, scaleY: 1 }
              : null,
        };
        setBallPositions(next);

        // Fire peg impacts the ball has now passed. Purely a visual cue.
        while (
          p1PegCursor < p1Sampling.events.length &&
          t >= p1Sampling.events[p1PegCursor].t
        ) {
          firePegHit(p1Sampling.events[p1PegCursor].index);
          p1PegCursor += 1;
        }
        while (
          p2PegCursor < p2Sampling.events.length &&
          t >= p2Sampling.events[p2PegCursor].t
        ) {
          firePegHit(p2Sampling.events[p2PegCursor].index);
          p2PegCursor += 1;
        }

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

          // Landing feedback — all values come straight from the server's
          // bucketIndex/points. No payout or bucket is computed here.
          const landingEvents: Array<{
            index: number;
            side: "p1" | "p2";
            points: number;
          }> = [];
          if (p1Result.bucketIndex >= 0) {
            landingEvents.push({
              index: p1Result.bucketIndex,
              side: "p1",
              points: p1Result.points,
            });
          }
          if (p2Result.bucketIndex >= 0) {
            landingEvents.push({
              index: p2Result.bucketIndex,
              side: "p2",
              points: p2Result.points,
            });
          }
          showBucketLanding(landingEvents);
          setBallSettleToken((v) => v + 1);

          // Show the per-ball result popup for NORMAL rounds only.
          // Overtime (the 4th tiebreaker ball) deliberately skips
          // this popup — the match-over screen (tie / win / lose
          // + Back to Lobby) is the only modal the player sees
          // there, so no intermediate "Ball 4 Results" popup pops
          // up before/on top of the final result.
          if (ballNumber <= REQUIRED_BALLS) {
            // Delay the popup (and the ball clear) by the landing hold so the
            // arrival at the bucket is actually visible before the modal
            // dims the board. Reduced motion skips the hold.
            const showRoundPopup = () => {
              setRoundPopup({
                p1Points: p1Result.points,
                p2Points: p2Result.points,
                p1FellOut: p1Result.fellOut,
                p2FellOut: p2Result.fellOut,
                ballNumber,
              });
              // Clear the balls when the popup appears (not when it is
              // dismissed) so both players see the same board state.
              setBallPositions({ p1: null, p2: null });
            };
            if (reduceMotionRef.current) {
              showRoundPopup();
            } else {
              if (landingTimerRef.current)
                clearTimeout(landingTimerRef.current);
              landingTimerRef.current = setTimeout(
                showRoundPopup,
                LANDING_HOLD_MS,
              );
            }
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
    [fetchStatus, firePegHit, clearPegHits, showBucketLanding, clearLandingState],
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
        // Use the /launch response paths (collision-aware from
        // simulateDualBalls) for immediate visual feedback.
        const p1Res = data.data.p1Result;
        const p2Res = data.data.p2Result;
        const myRes = data.data.myResult;
        // Register the ball as already-animated ONLY when an animation really
        // starts, so the pending fetchStatus / rounds-effect can't animate it
        // twice. If the response carries no paths at all, leaving it
        // unregistered lets the rounds-effect animate the ball from the rounds
        // row instead of it silently never moving.
        if (p1Res && p2Res) {
          animatedBallNumbersRef.current.add(resolvedBallNumber);
          startDualTrackAnimation(p1Res, p2Res, resolvedBallNumber);
        } else if (myRes) {
          // Fallback: half-dual animation with the viewer's own
          // result. Both paths being null when justResolved=true
          // means the server response shape changed — still animate
          // what we have so the ball doesn't disappear.
          animatedBallNumbersRef.current.add(resolvedBallNumber);
          const viewerIsP1 = match?.viewerIsPlayer1;
          startDualTrackAnimation(
            viewerIsP1 ? myRes : null,
            viewerIsP1 ? null : myRes,
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
  // ── Forfeit the match (surrender) ─────────────────────────────────
  const handleForfeit = useCallback(async () => {
    if (forfeiting) return;
    if (
      !window.confirm(
        "Forfeit this match? Your stake is forfeited and your opponent wins.",
      )
    )
      return;
    setForfeiting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/plinko-pvp/match/${matchId}/forfeit`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Forfeit failed");
        return;
      }
      posthog?.capture("plinko_pvp_forfeited", { match_id: matchId });
      socket?.emit("room_event", {
        roomId: plinkoPvpMatchRoom(matchId),
        event: PLINKO_PVP_MATCH_UPDATED,
      });
      await fetchStatus();
    } catch {
      setError("Network error while forfeiting");
    } finally {
      setForfeiting(false);
    }
  }, [matchId, socket, posthog, forfeiting, fetchStatus]);

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
      for (const t of tickTimersRef.current) clearTimeout(t);
      tickTimersRef.current = [];
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
  const reduceMotion = prefersReducedMotion === true;
  const isTiebreakerBall = match.status === MATCH_STATUS.BALL_4;

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
  const p2Name = match.isAi
    ? "Plinko AI"
    : match.players?.p2?.displayName ?? shortId(match.player2Id);
  const p1IconKey = match.players?.p1?.iconKey ?? null;
  const p2IconKey = match.players?.p2?.iconKey ?? null;
  const p1ProfileFrame = match.players?.p1?.profileFrame ?? null;
  const p2ProfileFrame = match.players?.p2?.profileFrame ?? null;
  // Report target: the opponent is whoever occupies the seat we don't
  // hold. Real Clerk id comes from the enriched player head; fall back
  // to the raw player1Id/player2Id fields.
  const opponentClerkId = isViewerP1
    ? (match.players?.p2?.id ?? match.player2Id ?? null)
    : (match.players?.p1?.id ?? match.player1Id ?? null);
  const opponentName = isViewerP1 ? p2Name : p1Name;
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
  // The banner is keyed by a coarse STAGE token so a short enter animation
  // plays when the match advances stage (waiting → ready → ball N → tiebreaker
  // → finished). It is keyed by stage — not by the 250ms countdown tick or
  // by match state churn — so polling/socket refreshes never replay it, and
  // the enter uses transform/opacity only, so the board below never reflows.
  function renderStatusBanner() {
    const bothReady = isLaunchable && match.p1Ready && match.p2Ready;
    const urgentMatch = isLaunchable && match.viewerCanLaunch && urgent;

    const stage = isCancelled
      ? "cancelled"
      : isFinished || (!isWaiting && !isReady && !isLaunchable)
        ? "none"
        : isWaiting
          ? "waiting"
          : isReady
            ? "ready"
            : bothReady
              ? isTiebreakerBall
                ? "both-ready-tb"
                : "both-ready"
              : isTiebreakerBall
                ? "tiebreaker"
                : "launchable";

    if (stage === "none") return null;

    let content: ReactNode = null;
    if (stage === "cancelled") {
      content = (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-900/30 px-4 py-3 text-red-200">
          <AlertIcon className="w-5 h-5 text-red-300" />
          <span className="font-semibold">This match was cancelled.</span>
        </div>
      );
    } else if (stage === "waiting") {
      content = (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3 text-cyan-200">
          <LoadingDotsIcon className="w-5 h-5 text-cyan-200 animate-pulse" />
          <span className="font-semibold">
            Waiting for an opponent to join… (your stake is escrowed)
          </span>
        </div>
      );
    } else if (stage === "ready") {
      content = (
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-cyan-300/40 bg-cyan-500/10 px-4 py-3 text-cyan-200">
          <span className="font-bold text-base sm:text-lg">
            Both players joined. Starting in
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/30 px-3 py-1 text-sm font-bold text-cyan-100">
            <ClockIcon className="w-4 h-4" />
            {Math.max(0, Math.ceil(timeLeft)) || 3}s
          </span>
        </div>
      );
    } else if (stage === "both-ready" || stage === "both-ready-tb") {
      content = (
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-3 text-emerald-200 animate-pulse">
          <span className="font-bold text-base sm:text-lg">
            {stage === "both-ready-tb"
              ? "Both ready. Tiebreaker launching!"
              : "Both ready. Launching both balls!"}
          </span>
        </div>
      );
    } else {
      // launchable / tiebreaker (tiebreaker = the server's 4th ball)
      content = (
        <div
          className={`flex flex-wrap items-center justify-center gap-3 rounded-xl border px-4 py-3 ${
            urgentMatch
              ? "border-red-400/60 bg-red-900/30 text-red-200 animate-pulse"
              : stage === "tiebreaker"
                ? "border-amber-300/50 bg-amber-500/10 text-amber-100"
                : "border-cyan-300/40 bg-cyan-500/10 text-cyan-200"
          }`}
        >
          {stage === "tiebreaker" && (
            <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-200">
              Tiebreaker
            </span>
          )}
          <span className="font-bold text-base sm:text-lg">
            {stage === "tiebreaker"
              ? "One more ball each — winner takes it"
              : match.viewerCanLaunch
                ? "Adjust your inputs and click Ready"
                : match.viewerHasCommitted
                  ? "You're ready. Waiting for opponent"
                  : "Opponent is choosing inputs…"}
          </span>
          {/* Free vs-AI matches are untimed — no countdown chip. */}
          {!match.isAi && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold ${
                urgentMatch
                  ? "bg-red-500/30 text-red-100"
                  : stage === "tiebreaker"
                    ? "bg-amber-500/30 text-amber-100"
                    : "bg-cyan-500/30 text-cyan-100"
              }`}
            >
              <ClockIcon className="w-4 h-4" />
              {timeLeft}s
            </span>
          )}
        </div>
      );
    }

    return (
      <motion.div
        key={stage}
        initial={reduceMotion ? false : { opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          reduceMotion ? { duration: 0 } : { duration: 0.14, ease: "easeOut" }
        }
      >
        {content}
      </motion.div>
    );
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
      <motion.div
        key={`between-${nextBall}`}
        initial={reduceMotion ? false : { opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          reduceMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }
        }
        className="flex items-center justify-center gap-2 rounded-xl border border-yellow-300/40 bg-yellow-500/10 px-4 py-3 text-yellow-200"
      >
        <LoadingDotsIcon className="w-5 h-5 text-yellow-200 animate-pulse" />
        <span className="font-semibold">
          Ball {nextBall} incoming — both players launch
        </span>
      </motion.div>
    );
  }

  // ── Winner popup (shown when match finishes) ────────────────────
  // ── Result screen — shared PvpResultScreen (UX plan P3-3) ──────
  // Rendered when the match finishes. Every value comes from the real
  // match row (winnerId / p1Score–p2Score / prizePaid / houseFee /
  // startedAt→endedAt) — nothing is invented, and the old bespoke
  // "Match Over / You Win / It's a Draw" popup is gone. Winner/payout
  // logic is untouched.
  function renderWinnerPopup() {
    if (!isFinished) return null;
    const isDraw = match.result === RESULT.TIE;
    const iWon = Boolean(
      match.winnerId && user?.id && match.winnerId === user.id,
    );
    const isAi = Boolean(match.isAi);
    const pointDiff = Math.abs((match.p1Score || 0) - (match.p2Score || 0));

    // Stake was escrowed at matchmaking; at settle the winner is
    // credited `prizePaid` (= stake + 90% of the loser's stake). The
    // net token change from the viewer's pocket:
    //   win  → +prizePaid − stake = +0.9 × stake
    //   loss → −stake
    //   draw → full refund = 0, or −(houseFee/2) for a 5%-fee
    //          overtime tie (houseFee = 10% of one stake total)
    // AI practice matches never move tokens.
    const stake = Number(match.stakeAmount) || 0;
    const prizePaid = Number(match.prizePaid) || 0;
    const houseFee = Number(match.houseFee) || 0;
    const tokenDelta = isAi
      ? null
      : isDraw
        ? houseFee > 0
          ? -(houseFee / 2)
          : 0
        : iWon
          ? prizePaid - stake
          : -stake;

    // Duration from the existing timestamps (omitted when unavailable).
    let durationSeconds: number | null = null;
    if (match.startedAt && match.endedAt) {
      const start = new Date(match.startedAt).getTime();
      const end = new Date(match.endedAt).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        durationSeconds = Math.round((end - start) / 1000);
      }
    }

    const winnerName = isDraw
      ? null
      : match.result === RESULT.PLAYER1
        ? p1Name
        : p2Name;
    const outcome = isDraw ? "draw" : iWon ? "win" : "loss";
    const oppHead = isViewerP1
      ? (match?.players?.p2 ?? null)
      : (match?.players?.p1 ?? null);
    const oppName = oppHead?.displayName || (isViewerP1 ? p2Name : p1Name);

    const headline = isDraw
      ? "Evenly matched — both players refunded"
      : iWon
        ? `You out-scored ${oppName} by ${pointDiff} point${pointDiff !== 1 ? "s" : ""}`
        : `${winnerName} won by ${pointDiff} point${pointDiff !== 1 ? "s" : ""}`;

    const subline = isAi
      ? "Free practice match — no tokens were staked or paid out."
      : isDraw && houseFee > 0
        ? `Each player refunded ${(stake * 0.95).toFixed(2)} tokens (5% platform fee).`
        : undefined;

    const decidedRound = match.currentBall > REQUIRED_BALLS
      ? `Overtime · Round ${match.currentBall}`
      : `Round ${match.currentBall || REQUIRED_BALLS}`;

    return (
      <PvpResultScreen
        open
        outcome={outcome}
        headline={headline}
        subline={subline}
        gameName="Plinko Duel"
        // Winner's final score is emphasised; the other side stays visible but
        // muted. Values are the server's p1Score/p2Score and result — nothing
        // computed here beyond which side the server named as winner.
        sides={[
          {
            name: p1Name,
            score: match.p1Score,
            highlight: match.result === RESULT.PLAYER1,
          },
          {
            name: p2Name,
            score: match.p2Score,
            highlight: match.result === RESULT.PLAYER2,
          },
        ]}
        opponent={{
          name: oppName,
          iconKey: oppHead?.iconKey || null,
          isAi,
        }}
        tokenDelta={tokenDelta}
        durationSeconds={durationSeconds}
        summary={[
          { label: "Result", value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw" },
          { label: "Score", value: `${match.p1Score} – ${match.p2Score}` },
          { label: "Decided", value: decidedRound },
        ]}
        details={[
          { label: "Match ID", value: String(match.id) },
          ...(isAi || isDraw
            ? []
            : [
                { label: "Stake", value: `${stake.toFixed(2)} tokens` },
                { label: "Prize paid", value: `${prizePaid.toFixed(2)} tokens` },
                ...(houseFee > 0
                  ? [{ label: "Platform fee", value: `${houseFee.toFixed(2)} tokens` }]
                  : []),
              ]),
          { label: "Winner", value: isDraw ? "Draw" : iWon ? "You" : winnerName || "Opponent" },
        ]}
        detailsContent={
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-xl border border-cyan-300/30 bg-cyan-500/10 p-3 text-center">
              <p className="truncate text-[10px] uppercase tracking-wider text-cyan-200/70">{p1Name}</p>
              <p className="mt-1 text-2xl font-black text-cyan-100 tabular-nums">
                {match.p1Score} pts
              </p>
            </div>
            <div className="rounded-xl border border-fuchsia-300/30 bg-fuchsia-500/10 p-3 text-center">
              <p className="truncate text-[10px] uppercase tracking-wider text-fuchsia-200/70">{p2Name}</p>
              <p className="mt-1 text-2xl font-black text-fuchsia-100 tabular-nums">
                {match.p2Score} pts
              </p>
            </div>
          </div>
        }
        playAgain={{ onClick: () => router.push("/casino/plinko") }}
        onReturnToLobby={() => router.push("/casino")}
      />
    );
  }

  // ── Main layout ──────────────────────────────────────────────────
  // Only the actual game content (title, status, board, panels, result
  // overlays) sits inside the shared CreatorModeHost recording viewport
  // — the nav bar, footer, and modals stay outside so recordings capture
  // just the game.
  //
  // Creator Mode lifecycle (driven by the game's REAL match state, never
  // page load): recording starts when the match leaves the waiting room
  // (ready/launchable). When it finishes or is cancelled, recording keeps
  // running for a short grace period so the result/winner animation is
  // captured, then stops. Leaving the page stops immediately. The overlay
  // then shows the download UI.
  //
  // Creator Mode shared visual layout (see
  // src/components/creator-mode/CreatorModeLayout.jsx): the SAME
  // gameplay components below are only REARRANGED to fit the selected
  // recording aspect ratio — game logic, controls, and rules are
  // untouched. Portrait 9:16 prioritises the board, keeps branding + info
  // in a compact header, and pins the controls below. Landscape / square
  // reuse the standard grid. Normal mode (creator off) renders `pageBody`
  // exactly as before.

  const boardNode = (
    <PlinkoBoard
      p1BallPos={p1BallPos}
      p2BallPos={p2BallPos}
      highlightBucket={highlightBucket}
      p1FellOut={latestP1FellOut}
      p2FellOut={latestP2FellOut}
      p1Preview={showVisor ? p1Preview : null}
      p2Preview={showVisor ? p2Preview : null}
      showVisor={showVisor}
      pegHits={pegHits}
      bucketLandings={bucketLandings}
      ballSettle={ballSettleToken}
    />
  );

  const centerChrome = (
    <>
      <div className="mt-3">{renderBetweenBallsBanner()}</div>
      {match.viewerCanCancel && (
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => handleCancel()}
            disabled={cancelling}
            className={`px-4 py-3 rounded-xl text-sm font-bold min-h-[44px] min-w-[120px] ${
              cancelling
                ? "bg-white/10 text-white/40 cursor-not-allowed"
                : "bg-red-500/20 text-red-200 border border-red-400/40 hover:bg-red-500/30"
            }`}
          >
            {cancelling ? "Cancelling…" : "Cancel lobby"}
          </button>
        </div>
      )}
      {!isFinished && !isCancelled && (
        <div className="mt-3 flex justify-center">
          <button
            onClick={handleForfeit}
            disabled={forfeiting}
            className="px-4 py-3 rounded-xl text-sm font-bold border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/25 disabled:opacity-50 min-h-[44px] min-w-[120px]"
          >
            {forfeiting ? "Forfeiting…" : "Forfeit match"}
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
    </>
  );

  const p1Node = (
    <PlayerSidePanel
      seat="player1"
      displayName={p1Name}
      avatarKey={p1IconKey}
      profileFrame={p1ProfileFrame}
      nameColor={match.players?.p1?.nameColor || null}
      totalScore={match.p1Score}
      lastBallDelta={p1Delta}
      emoteBubble={isViewerP1 ? myEmote : incomingEmote}
      onSendEmote={isViewerP1 ? sendEmote : undefined}
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
  );

  const p2Node = (
    <PlayerSidePanel
      seat="player2"
      displayName={p2Name}
      avatarKey={p2IconKey}
      profileFrame={p2ProfileFrame}
      nameColor={match.players?.p2?.nameColor || null}
      totalScore={match.p2Score}
      lastBallDelta={p2Delta}
      emoteBubble={isViewerP1 ? incomingEmote : myEmote}
      onSendEmote={isViewerP1 ? undefined : sendEmote}
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
  );

  // Branding + status chrome (shared across all layouts).
  const chromeHeader = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PlinkoIcon className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-300 drop-shadow-[0_0_12px_rgba(0,229,255,0.65)] flex-shrink-0" />
          <h1 className="text-lg sm:text-xl font-black tracking-tight">
            Plinko Duel · Match #{matchId ?? "?"}
          </h1>
        </div>
        <div className="text-[11px] sm:text-xs text-white/60 flex items-center gap-3">
          <span className="font-mono">{match.isAi ? "Free AI practice" : `$${stake.toFixed(2)} stake`}</span>
          <span className="font-mono">Best-score-of-3</span>
          <span className="font-mono">{viewerSeat === "player1" ? "P1" : "P2"} seat</span>
          {opponentClerkId && (
            <button
              onClick={() => setShowReportModal(true)}
              className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 font-bold text-red-400 transition-all hover:bg-red-500/20 hover:shadow-[0_0_10px_rgba(239,68,68,0.3)]"
            >
              <IconFlag size={12} /> Report
            </button>
          )}
        </div>
      </div>
      <div className="mt-3">{renderStatusBanner()}</div>
      {/* Round counter — the number pops when the ball advances so the change
          is legible; the label switches to Tiebreaker for the server's 4th
          (overtime) ball. Keyed by ball number, so it never replays on polls. */}
      <div className="mt-2 flex justify-center">
        <div className="inline-flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-xs uppercase tracking-wider text-white/70">
          <span className={isTiebreakerBall ? "text-amber-200" : undefined}>
            {isTiebreakerBall ? "Tiebreaker" : "Round"}
          </span>
          <motion.span
            key={isTiebreakerBall ? "tb" : `ball-${displayBall}`}
            initial={reduceMotion ? false : { scale: 0.7, opacity: 0.4 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }
            }
            className="font-black text-white text-base tabular-nums"
          >
            {isTiebreakerBall ? (
              "OT"
            ) : (
              <>
                {displayBall}
                <span className="text-white/40 text-sm">/{REQUIRED_BALLS}</span>
              </>
            )}
          </motion.span>
        </div>
      </div>
    </>
  );

  const overlaysNode = (
    <>
      {renderWinnerPopup()}
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
          isLastBall={roundPopup.ballNumber >= REQUIRED_BALLS && match?.p1Score !== match?.p2Score}
        />
      )}
    </>
  );

  // Standard 3-column grid (mobile stacks, board first).
  const gameGrid = (
    <div className="mt-4 grid gap-4 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_300px]">
      <div className="order-2 lg:order-1">{p1Node}</div>
      <div className="order-1 lg:order-2 min-w-0">{boardNode}{centerChrome}</div>
      <div className="order-3">{p2Node}</div>
    </div>
  );

  // Normal mode / landscape / square game body (unchanged from before).
  const pageBody = (
    <div className="mx-auto mt-3 sm:mt-4 max-w-[1400px]">
      {chromeHeader}
      {gameGrid}
      {overlaysNode}
    </div>
  );

  // Portrait 9:16 creator arrangement — gameplay (board) on top and
  // filling most of the height, branding + status + totals in a compact
  // header, controls pinned at the bottom.
  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellHeader className="flex flex-col items-stretch gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <PlinkoIcon className="w-6 h-6 shrink-0 text-cyan-300 drop-shadow-[0_0_10px_rgba(0,229,255,0.6)]" />
            <h1 className="truncate text-base font-black tracking-tight">
              Plinko Duel · #{matchId ?? "?"}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] font-bold tabular-nums">
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-white/70">
              {isTiebreakerBall ? "Tiebreaker" : `R ${displayBall}/${REQUIRED_BALLS}`}
            </span>
            <span className="text-cyan-300">{match.p1Score}</span>
            <span className="text-fuchsia-300">{match.p2Score}</span>
          </div>
        </div>
        <div>{renderStatusBanner()}</div>
      </ShellHeader>

      <ShellMain className="flex-col min-h-0 overflow-hidden">
        <div className="flex-1 w-full min-h-0 overflow-hidden px-3 py-2">
          {boardNode}
        </div>
        <div className="shrink-0 px-3 py-2 space-y-2">
          {centerChrome}
        </div>
      </ShellMain>

      <ShellAside>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>{p1Node}</div>
          <div>{p2Node}</div>
        </div>
      </ShellAside>

      {overlaysNode}
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) creator arrangement — reuse the
  // standard layout inside the frame shell so it adapts responsively.
  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="items-start justify-start overflow-y-auto">
        {pageBody}
      </ShellMain>
    </CreatorModeShell>
  );

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <CreatorModeHost
        autoStart={isReady || isLaunchable}
        autoStop={isFinished || isCancelled}
        gameLabel="plinko-duel"
        backToLobbyHref="/casino/plinko"
      >
        <CreatorView
          // Normal mode: the desktop game renders completely unchanged.
          normal={pageBody}
          // Creator Mode on: arrange the SAME gameplay components inside
          // the shared recording-frame shell, optimised for the selected
          // aspect ratio (portrait 9:16 / landscape / square).
          portrait={portraitContent}
          landscape={landscapeContent}
        />
      </CreatorModeHost>

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
              gameType: "plinko-pvp",
              gameId: String(matchId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={opponentName || "Opponent"}
        gameType="Plinko Duel"
      />

      <Footer />
    </div>
  );
}
