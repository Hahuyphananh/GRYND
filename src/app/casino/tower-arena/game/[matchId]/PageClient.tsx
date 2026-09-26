"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  motion,
  AnimatePresence,
  useAnimationControls,
  useReducedMotion,
} from "framer-motion";
import { usePostHog } from "posthog-js/react";
// Page-level session host: records "recently played" and beats
// active-player presence, driven by the game's REAL lifecycle
// (autoStart/autoStop) — never by page load.
import GameSessionHost from "../../../../../components/GameSessionHost";

import NavigationBar from "../../../../../components/navigation-bar";
import Footer from "../../../../../components/Footer";
import FrameAvatar from "../../../../../components/FrameAvatar";
import { useSocket } from "../../../../../context/SocketProvider";
import { CoinIcon } from "../../../../../components/lobby/PvpLobby";
import PvpResultScreen from "../../../../../components/result/PvpResultScreen";
import {
  IconBuildingSkyscraper,
  IconX,
  IconRotate,
  IconArrowsLeftRight,
  IconHandStop,
  IconTrophy,
  IconPlayerPause,
  IconPlayerPlay,
} from "@tabler/icons-react";
import {
  playTurnSwitch,
  playCrash,
  playTick,
  playVictory,
  playDefeat,
} from "../../../../../lib/gameAudio";
import {
  blockCells,
  blockWidth,
  centerXFor,
  dropRangeFor,
  CEILING_HEIGHT,
  simulatePlacement,
  findSafeDrop,
  BLOCK_SHAPES,
  GRID_WIDTH,
  type BlockShape,
} from "../../../../../lib/tower-arena/engine";

// ── Game meta ──────────────────────────────────────────────────────────

// Client-side mirror of the server's BOT_THINK_MS: how long we wait before
// asking the server to resolve a bot's turn. Must be a hair longer than the
// server window so the /ai-turn request lands after the bot's deadline (the
// server's poll backstop resolves it if this ever fires late).
const BOT_PLAN_DELAY_MS = 1_000;

// Socket room_event name used to preview a human opponent's live aim. The
// realtime server relays it to the match room, stamping the sender's
// authenticated userId (so only the real turn holder's aim can be shown).
const AIM_UPDATE_EVENT = "tower_arena_aim_update";
// How long a received aim preview stays valid without a fresh heartbeat.
const AIM_TTL_MS = 5_000;

const SHAPE_NAME: Record<BlockShape, string> = {
  I: "Beam",
  L: "Spire",
  T: "Post",
  square: "Square",
  short: "Short",
  long: "Long Beam",
  big: "Big Block",
};

// Per-shape color identity (fill + bright edge). Each shape family keeps one
// hue so players can read the piece type at a glance; the cell renderer adds
// a top gloss + bottom bevel on top of these.
const SHAPE_COLORS: Record<BlockShape, { fill: string; edge: string }> = {
  short: { fill: "#a5f3fc", edge: "#e0fcff" },   // ice
  square: { fill: "#f5ff3b", edge: "#ffffd1" },  // neon
  I: { fill: "#00e5ff", edge: "#9df6ff" },       // cyan beam
  L: { fill: "#ff5c8a", edge: "#ffb8cd" },       // rose spire
  T: { fill: "#a78bfa", edge: "#d9ccff" },       // violet post
  long: { fill: "#7cf29c", edge: "#c9ffe1" },    // mint slab
  big: { fill: "#ff9f43", edge: "#ffdcb0" },     // amber block
};

/**
 * One cell of a block, drawn in the shared block visual language (rounded
 * slab, bright top gloss, grounded bottom bevel, crisp edge in the shape's
 * accent color). Used by the MINI BLOCK ICONS in the chooser AND by the
 * real blocks in the tower — a block looks exactly like its icon, so the
 * picker never misrepresents what lands. Coordinates are in the caller's
 * own space; `size` is the cell edge length.
 */
function BlockCell({
  x,
  y,
  fill,
  edge,
  size = 0.96,
  rx = 0.1,
  opacity = 1,
}: {
  x: number;
  y: number;
  fill: string;
  edge: string;
  size?: number;
  rx?: number;
  opacity?: number;
}) {
  return (
    <g opacity={opacity}>
      {/* Base slab in the shape color with a crisp edge. */}
      <rect
        x={x}
        y={y}
        width={size}
        height={size}
        rx={rx}
        fill={fill}
        stroke={edge}
        strokeWidth={Math.max(0.03, size * 0.05)}
      />
      {/* Top gloss — light catching the upper face. */}
      <rect
        x={x + size * 0.1}
        y={y + size * 0.09}
        width={size * 0.8}
        height={size * 0.22}
        rx={Math.max(0.02, size * 0.08)}
        fill="#ffffff"
        opacity={0.32}
      />
      {/* Bottom bevel — grounds the cell. */}
      <rect
        x={x + size * 0.1}
        y={y + size * 0.8}
        width={size * 0.8}
        height={size * 0.13}
        rx={Math.max(0.02, size * 0.05)}
        fill="#000000"
        opacity={0.2}
      />
    </g>
  );
}

// ── Types (mirror the get-match projection) ───────────────────────────

type Match = {
  id: string;
  status: string;
  phase: string;
  wager: number;
  maxPlayers: number;
  isAi: boolean;
  hostUserId: string;
  winnerId: string | null;
  prizePool: number;
  houseFee: number;
  pot: number;
  resourceCycle: number;
  turnNumber: number;
  currentTurnPlayerId: string | null;
  turnDeadline: string | null;
  paused: boolean;
  resourcePool: { id: string; shape: BlockShape }[];
  towerState: any[];
  placements: any[];
  finalRankings: any[];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};type Player = {
  userId: string;
  seat: number;
  status: string;
  placement: number | null;
  isAi: boolean;
  ready: boolean;
  name: string;
  iconKey: string;
  profileFrame?: unknown;
  prestigeBadge?: string | null;
};

// ── Countdown hook ─────────────────────────────────────────────────────

function useServerCountdown(deadline: string | null, tickMs = 100) {
  const [left, setLeft] = useState(60);
  useEffect(() => {
    if (!deadline) return;
    const dl = new Date(deadline).getTime();
    const tick = () => {
      const remain = Math.max(0, (dl - Date.now()) / 1000);
      setLeft(remain);
      if (remain > 0) requestAnimationFrameSchedule(tick);
    };
    requestAnimationFrameSchedule(tick);
    return () => cancelAnimationFrameScheduler();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline]);
  void tickMs;
  return left;
}

let rafHandle: number | null = null;
function requestAnimationFrameSchedule(fn: () => void) {
  cancelAnimationFrameScheduler();
  rafHandle = requestAnimationFrame(fn);
}
function cancelAnimationFrameScheduler() {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

// ── 2D side-view tower renderer ────────────────────────────────────────
//
// The board is a wider floor with a visible hard ceiling. Blocks fall from
// the top, land on the highest support below their footprint, and remain fixed.
// The existing stage, responsive layout, and visual branding are preserved.

// Sky band reserved above the tower top (world cells) — blocks drop from up
// here every turn.
const SKY_CELLS = 5;

// ── Falling-block motion trail ─────────────────────────────────────────
// Three ghost copies of the falling block, each one a frame BEHIND it on the
// very same fall path: identical cells, identical distance, identical easing —
// just started a few tens of milliseconds later. Because the drop is `easeIn`,
// that lag is invisible at the start of the fall and only turns into a visible
// gap once the block is moving fast, so the trail reads as speed and weight
// instead of as a particle effect. Delays are absolute seconds (not a fraction
// of the fall): a short drop is inherently faster, and gets a tighter trail.
const TRAIL_FRAMES: Array<{ delay: number; opacity: number }> = [
  { delay: 0.03, opacity: 0.48 }, // trail 1 — closest to the block
  { delay: 0.06, opacity: 0.28 }, // trail 2
  { delay: 0.09, opacity: 0.12 }, // trail 3 — faintest
];

// ── Impact rumble ──────────────────────────────────────────────────────
// One hit, ~110ms: straight out to peak displacement, then five decaying,
// out-of-phase steps back home. The signs alternate and the amplitude shrinks
// on every step, so it reads as a single heavy landing rather than a vibration.
// The LAST keyframe is always exactly 0 and every keyframe is bounded, so the
// stage can never be left sitting at an offset — however many impacts arrive
// back to back, the scene always returns to its exact original position.
// Impact strength scales with how far the block actually fell. The drop is
// spawned FALL_REFERENCE_CELLS above its landing (see dropSpawnZ below), so a
// fall of that height is a full-strength hit; a landing near the top of the
// stage — where the spawn height gets clamped — travels far less and hits
// proportionally softer. The floor keeps even a one-cell nudge visible, and the
// ceiling keeps an absurd shake impossible. Purely visual.
const FALL_REFERENCE_CELLS = 10; // the spawn height used for a full-height drop
const MIN_FALL_CELLS = 3.5; // the shortest fall the stage produces (a ceiling landing)
const SHAKE_MIN_AMPLITUDE = 3; // ≈ 3.5px vector — a barely-there nudge
const SHAKE_MAX_AMPLITUDE = 12; // ≈ 13.8px vector — a full-height slam
const SHAKE_DURATION = 0.11; // seconds — fast and punchy (well inside 80–140ms)
// Step 0 is the rest position, step 1 is THE PUNCH (~11ms in), then every step
// decays toward home. The steps rotate direction irregularly — steps 3 and 4
// are the only ones that pull with the same sign on both axes — so it reads as
// one heavy jolt rather than a straight diagonal slide. Each step is ~0.7× the
// previous, which keeps the decay monotonic even at the extremes of the jitter
// band below, and the last step is exactly 0.
const SHAKE_TIMES = [0, 0.1, 0.26, 0.44, 0.62, 0.8, 1];
const SHAKE_X = [0, 0.87, -0.66, 0.42, -0.26, 0.07, 0];
const SHAKE_Y = [0, -0.5, 0.24, 0.16, -0.1, -0.12, 0];
// Jitter band for the per-impact variation (single factor per step, so the
// direction of each step is preserved and the decay stays monotonic).
const SHAKE_JITTER_MIN = 0.85;
const SHAKE_JITTER_MAX = 1.15;

/**
 * Punch amplitude (px) for a fall of `dropDz` cells: normalized to 0–1 against
 * the reference fall height, clamped at both ends, then mapped onto the
 * amplitude band. A 1-cell nudge shakes barely at all; a full-height drop slams.
 */
function impactAmplitude(dropDz: number) {
  const fall = Number.isFinite(dropDz) ? Math.max(0, dropDz) : 0;
  const strength = Math.min(
    1,
    Math.max(0, (fall - MIN_FALL_CELLS) / (FALL_REFERENCE_CELLS - MIN_FALL_CELLS)),
  );
  return SHAKE_MIN_AMPLITUDE + (SHAKE_MAX_AMPLITUDE - SHAKE_MIN_AMPLITUDE) * strength;
}

/**
 * Keyframes for one impact. The variation comes from the impact token itself —
 * never `Math.random()` — so consecutive hits look different instead of
 * mechanical, while staying identical across re-renders and reproducible for
 * qa/ta-rumble-check.mjs. `amplitude` is the only thing that varies with the
 * fall; the envelope (shape, steps, timing) is identical for every hit, and it
 * is expressed purely in seconds, so the rumble is frame-rate independent.
 */
function impactShake(seed: number, amplitude: number) {
  let state = (Math.abs(Math.trunc(seed)) * 9301 + 49297) % 233280 || 1;
  const nextRandom = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280; // 0..1
  };
  // Sometimes the jolt kicks off to the left, sometimes to the right.
  const direction = nextRandom() > 0.5 ? 1 : -1;
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < SHAKE_X.length; i += 1) {
    const isRest = i === 0 || i === SHAKE_X.length - 1;
    const jitter = isRest
      ? 1
      : SHAKE_JITTER_MIN + nextRandom() * (SHAKE_JITTER_MAX - SHAKE_JITTER_MIN);
    x.push(+(SHAKE_X[i] * amplitude * jitter * direction).toFixed(2));
    y.push(+(SHAKE_Y[i] * amplitude * jitter * direction).toFixed(2));
  }
  x[x.length - 1] = 0; // always exactly home
  y[y.length - 1] = 0;
  return {
    x,
    y,
    transition: {
      duration: SHAKE_DURATION,
      times: SHAKE_TIMES,
      ease: "linear" as const,
    },
  };
}

// Faint dust drifting in the sky — deterministic fixed offsets so SSR +
// client renders never differ. Positions are computed relative to the tower
// top so they stay in the sky band as the scene scales.
const SKY_DUST: Array<[number, number, number]> = [
  [0.3, 0.25, 0.35],
  [1.7, 0.55, 0.22],
  [3.1, 0.3, 0.3],
  [4.4, 0.6, 0.2],
  [0.9, 0.8, 0.16],
  [2.6, 0.72, 0.18],
  [5.2, 0.4, 0.14],
  [-0.6, 0.5, 0.12],
  [6.2, 0.65, 0.1],
  [4.0, 0.9, 0.12],
];

// Exported so the drop animation (fall + trail) and the impact rumble can be
// mounted and measured on their own in qa/ta-trail-check.mjs and
// qa/ta-rumble-check.mjs. No behaviour change.
export function TowerScene({
  tower,
  ghost,
  falling,
  cursor,
  impact,
  remoteAiming,
  onStageClick,
  onAimMove,
  onDropLanded,
}: {
  tower: any[];
  ghost?: { cells: any[]; willFall: boolean; remote?: boolean; label?: string } | null;
  falling?: { cells: any[]; extra: any[]; willFall: boolean; slideDx: number; key: number; shape: BlockShape | null } | null;
  cursor?: { shape: BlockShape; x: number; rotation: number; danger: boolean } | null;
  impact?: number;
  remoteAiming?: string | null;
  onStageClick?: () => void;
  /** The falling block reached the tower — reported at the exact moment the
   *  drop animation lands (see the landing timer below), so the impact token
   *  can be bumped when the block TOUCHES DOWN rather than when the page
   *  later tears the animation down. */
  onDropLanded?: (key: number) => void;
  /** Pointer moved over the stage while aiming: reports the world X under
   *  the pointer so the page can re-position the drop column (mouse aim). */
  onAimMove?: (worldX: number) => void;
}) {
  // The stage grows with the tower: floor at the bottom, SKY_CELLS of open
  // sky above the highest block (blocks spawn from the top of that band).
  // Falling/shed cells are included so the animation band covers them too.
  const allCells = [
    ...(tower || []).flatMap((b: any) => b.cells || []),
    ...(falling?.cells || []),
    ...(falling?.extra || []),
  ];
  const maxZ = allCells.reduce((m, c: any) => Math.max(m, c.z), 0);
  const viewH = Math.max(CEILING_HEIGHT + SKY_CELLS, maxZ + SKY_CELLS);
  const yFor = (z: number) => viewH - z; // z=0 → bottom edge, taller z → up
  const cellY = (z: number) => yFor(z + 1);
  const ceilingY = yFor(CEILING_HEIGHT + 1);

  // The floating platform reads LONGER than the 16 playable columns: it
  // overhangs past each end into the void (purely visual — drop columns
  // stay 0..GRID_WIDTH-1, only the art extends). The stage is framed a
  // little wider than the platform so the longer floor is fully visible.
  const FLOOR_OVERHANG = 2.4;
  const X_MIN = -(FLOOR_OVERHANG + 0.9);
  const X_MAX = GRID_WIDTH + FLOOR_OVERHANG + 0.9;
  const floorMinX = -FLOOR_OVERHANG;
  const floorMaxX = GRID_WIDTH + FLOOR_OVERHANG;

  const sortedBlocks = (tower || [])
    .slice()
    .sort((a, b) => (a.turnNumber || 0) - (b.turnNumber || 0));

  // Ghost bounds (for the danger label)
  let ghostMinX = Infinity;
  let ghostMaxX = -Infinity;
  let ghostMaxZ = 0;
  for (const c of ghost?.cells || []) {
    ghostMinX = Math.min(ghostMinX, c.x);
    ghostMaxX = Math.max(ghostMaxX, c.x);
    ghostMaxZ = Math.max(ghostMaxZ, c.z);
  }

  // Aim cursor: the selected block hovering at the top of the stage, ready
  // to drop (fruit-merge style). Positioned in the sky band above the tower.
  const cursorCells =
    cursor && cursor.shape
      ? blockCells(cursor.shape, cursor.rotation).map(([rx, rz]) => ({
          x: cursor.x + rx,
          depth: 0,
          z: Math.max(2, maxZ + SKY_CELLS - 2) + rz,
        }))
      : [];
  const cursorZ0 = cursorCells.reduce((m: number, c: any) => Math.min(m, c.z), Infinity);
  const cursorCenterX =
    cursorCells.length > 0
      ? (Math.min(...cursorCells.map((c: any) => c.x)) + Math.max(...cursorCells.map((c: any) => c.x)) + 1) / 2
      : 0;
  const guideBottomZ = Math.max(2, ghostMaxZ + 1);

  // Drop-animation metrics: a placed block (player OR bot) starts HIGH in
  // the sky and visibly FALLS to its landing spot. The block's cells are
  // final; the group is translated up by `dropDz` (and horizontally by
  // `slideDx` — the aim→resolved slip) and animated back to its real
  // position. The block spawns ~10 cells above its landing (or just under
  // the top of the stage when the tower is nearly at the ceiling), so the
  // fall is always clearly visible — never a 1-2 cell nudge.
  const fallingCells = falling?.cells || [];
  const fallingMinZ = fallingCells.reduce((m: number, c: any) => Math.min(m, c.z), Infinity);
  const dropSpawnZ = Number.isFinite(fallingMinZ)
    ? Math.min(viewH - 1.5, fallingMinZ + 10)
    : 0;
  const dropDz = Number.isFinite(fallingMinZ)
    ? Math.max(0, dropSpawnZ - fallingMinZ)
    : 0;
  // Fall duration grows with the drop height so long falls stay watchable
  // and short ones stay snappy (capped at ~0.9s).
  const fallSeconds = Math.min(0.9, 0.32 + dropDz * 0.035);

  // The fall distance of the drop in flight, remembered for the rumble: the
  // page clears `falling` and bumps the impact token in the SAME tick, so by
  // the time the shake effect runs there is no falling block left to measure.
  // Written during render because it is purely derived from props (idempotent,
  // no allocation, and never reset by an unrelated re-render).
  const lastDropDz = useRef(0);
  if (falling && Number.isFinite(dropDz)) lastDropDz.current = dropDz;

  // Landing signal. The block's own y transition finishes exactly `fallSeconds`
  // after the drop mounts (no delay, no easing on the timing), so that IS the
  // moment of contact — and it is reused here rather than re-derived, so the
  // signal can never drift from the animation. The page needs it because it
  // only tears the falling block down once the drop has been on screen for a
  // beat (1200ms / 1650ms), which is up to ~0.8s AFTER contact: bumping the
  // impact token on that teardown put the thud visibly late. The callback is
  // held in a ref so a page re-render (poll, socket push) can never restart
  // the timer and push the landing later.
  const onDropLandedRef = useRef(onDropLanded);
  onDropLandedRef.current = onDropLanded;
  useEffect(() => {
    if (!falling?.key) return;
    const key = falling.key;
    const timer = window.setTimeout(() => onDropLandedRef.current?.(key), fallSeconds * 1000);
    // A drop replaced mid-air (or cleared, or the scene unmounting) cancels the
    // landing: no thud for a fall that never reached the tower, and no timer
    // left running behind a match that has moved on.
    return () => window.clearTimeout(timer);
  }, [falling?.key, fallSeconds]);

  // The falling block's own look, resolved once: the trail ghosts render in
  // exactly these two colors, so a ghost can only ever be a faded copy of the
  // block it trails (never a different shade, and never a different shape —
  // both walk the same `falling.cells`).
  const fallingFill = falling?.willFall
    ? "#ff4d6d"
    : SHAPE_COLORS[falling?.shape as BlockShape]?.fill ?? "#a7f3d0";
  const fallingEdge = falling?.willFall
    ? "#ff8fa3"
    : SHAPE_COLORS[falling?.shape as BlockShape]?.edge ?? "#ffffff";

  // Decorative motion only — reduced-motion viewers get the drop without the
  // trail (the block itself still falls, so no gameplay feedback is lost).
  const reduceMotion = useReducedMotion();

  // Impact rumble. `impact` is a monotonic token bumped once per landed drop,
  // so a new value means "play it again". It is driven imperatively because an
  // identical keyframe target on the `animate` prop is a no-op after the first
  // hit — the token would be ignored and the scene would only ever shake once.
  // Starting a new shake also interrupts one still in flight, and since every
  // shake ends at exactly 0, repeated hits can never leave the stage offset.
  const shake = useAnimationControls();
  const shakenFor = useRef(0);
  useEffect(() => {
    if (!impact || impact === shakenFor.current) return;
    shakenFor.current = impact;
    if (reduceMotion) return; // preference honoured: no rumble at all
    // Sized by the fall that just finished: a block that dropped the full sky
    // band slams, one that barely cleared the tower gives a small thud.
    void shake.start(impactShake(impact, impactAmplitude(lastDropDz.current)));
  }, [impact, reduceMotion, shake]);

  // y is bottom-aligned: the floor line always sits on the bottom edge of
  // the stage, no matter how the container's aspect ratio differs.
  return (
    <motion.div
      data-testid="ta-scene-shake"
      className="h-full w-full"
      // The rumble is applied to the whole scene wrapper (never to individual
      // blocks), and the SVG's own coordinates are untouched: this transform
      // is transient and always resolves back to the identity position.
      animate={shake}
    >
      <svg
        viewBox={`${X_MIN} 0 ${X_MAX - X_MIN} ${viewH}`}
        className={
          onStageClick || onAimMove
            ? "h-full w-full cursor-pointer select-none touch-none"
            : "h-full w-full select-none"
        }
        preserveAspectRatio="xMidYMax meet"
        onClick={onStageClick}
        onPointerMove={(e) => {
          if (!onAimMove) return;
          const ctm = e.currentTarget.getScreenCTM?.();
          if (!ctm) return;
          // Convert the pointer's screen position into the SVG's world
          // coordinates (handles the preserveAspectRatio letterboxing).
          const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
          onAimMove(pt.x);
        }}
      >
      <defs>
        <linearGradient id="ta-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0a0f24" />
          <stop offset="60%" stopColor="#070a18" />
          <stop offset="100%" stopColor="#04060f" />
        </linearGradient>
        <linearGradient id="ta-platform" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2dd4bf" />
          <stop offset="35%" stopColor="#0e7490" />
          <stop offset="100%" stopColor="#134e4a" />
        </linearGradient>
        <radialGradient id="ta-glow" cx="0.5" cy="0.97" r="0.55">
          <stop offset="0%" stopColor="rgba(45,212,191,0.12)" />
          <stop offset="100%" stopColor="rgba(45,212,191,0)" />
        </radialGradient>
      </defs>

      {/* Open sky filling the stage (the floor line sits at the very bottom) */}
      <rect x={X_MIN} y={0} width={X_MAX - X_MIN} height={viewH} fill="url(#ta-sky)" />
      <rect x={X_MIN} y={viewH - 3.2} width={X_MAX - X_MIN} height={3.2} fill="url(#ta-glow)" />
      {SKY_DUST.map(([fx, fy, o], i) => (
        <circle
          key={i}
          cx={X_MIN + 0.3 + fx * 0.8}
          cy={yFor(maxZ + 0.6 + fy * (SKY_CELLS - 1.2))}
          r={0.05}
          fill="#5eead4"
          opacity={o}
        />
      ))}

      {/* Hard ceiling: a placement whose top crosses this line eliminates
          the player, while every block below it remains fixed. Drawn as one
          clear, bright line spanning the whole stage — no label clutter,
          just a wide soft glow with a solid amber core so it always reads
          against the sky. The game is decided at this line. */}
      <line
        x1={X_MIN + 0.2}
        y1={ceilingY}
        x2={X_MAX - 0.2}
        y2={ceilingY}
        stroke="rgba(255,207,90,0.16)"
        strokeWidth={0.7}
      />
      <line
        x1={X_MIN + 0.2}
        y1={ceilingY}
        x2={X_MAX - 0.2}
        y2={ceilingY}
        stroke="rgba(255,207,90,0.45)"
        strokeWidth={0.26}
      />
      <line
        x1={X_MIN + 0.2}
        y1={ceilingY}
        x2={X_MAX - 0.2}
        y2={ceilingY}
        stroke="#ffd873"
        strokeWidth={0.12}
      />

      {/* Column guide lines over the floor span */}
      {Array.from({ length: GRID_WIDTH + 1 }, (_, i) => (
        <line
          key={`g${i}`}
          x1={i}
          y1={yFor(1)}
          x2={i}
          y2={yFor(Math.min(viewH - 0.4, Math.max(3, maxZ + 2.5)))}
          stroke="rgba(45,212,191,0.10)"
          strokeWidth={0.02}
        />
      ))}

      {/* The floor — a long floating platform pinned to the bottom of the
          stage. It deliberately overhangs past the playable columns on
          both sides (floorMinX..floorMaxX is wider than 0..GRID_WIDTH) so
          the board reads LONGER horizontally; the bright top edge is THE
          LINE blocks stand on. Landing columns are unchanged. */}
      <rect
        x={floorMinX}
        y={yFor(1)}
        width={floorMaxX - floorMinX}
        height={1}
        fill="url(#ta-platform)"
        stroke="rgba(94,234,212,0.85)"
        strokeWidth={0.07}
        rx={0.12}
      />
      {/* Bright top edge running the full platform length */}
      <line
        x1={floorMinX}
        y1={yFor(1)}
        x2={floorMaxX}
        y2={yFor(1)}
        stroke="#9dfff0"
        strokeWidth={0.13}
        opacity={0.98}
      />
      {/* Subtle top gloss strip along the platform */}
      <line
        x1={floorMinX + 0.12}
        y1={yFor(1.06)}
        x2={floorMaxX - 0.12}
        y2={yFor(1.06)}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth={0.05}
      />
      {/* Tile separators over the playable span only (0..GRID_WIDTH) */}
      {Array.from({ length: GRID_WIDTH - 1 }, (_, i) => (
        <line
          key={`t${i}`}
          x1={i + 1}
          y1={yFor(1.05)}
          x2={i + 1}
          y2={yFor(0.95)}
          stroke="rgba(1,22,30,0.7)"
          strokeWidth={0.05}
        />
      ))}
      {/* Cliff edge glow where the platform overhangs the void below */}
      <line x1={floorMinX} y1={yFor(1.05)} x2={floorMinX} y2={yFor(1.9)} stroke="rgba(94,234,212,0.22)" strokeWidth={0.06} />
      <line x1={floorMaxX} y1={yFor(1.05)} x2={floorMaxX} y2={yFor(1.9)} stroke="rgba(94,234,212,0.22)" strokeWidth={0.06} />

      {/* Tower blocks (oldest first so newer blocks paint above) — every
          cell drawn with the shared BlockCell look so each landed block
          matches its chooser icon exactly. */}
      {sortedBlocks.map((b) => {
        const style = SHAPE_COLORS[b.shape as BlockShape] ?? SHAPE_COLORS.short;
        return (b.cells || []).map((c: any) => (
          <BlockCell
            key={`${b.id}-${c.x}:${c.z}`}
            x={c.x + 0.02}
            y={cellY(c.z) + 0.02}
            size={0.96}
            fill={style.fill}
            edge={style.edge}
          />
        ));
      })}

      {/* Ghost preview of the selected block — red when the drop would fall.
          Remote ghosts (a bot's planned placement, shown on every viewer's
          board) render in cyan with the bot's name above. */}
      {ghost &&
        (ghost.cells || []).map((c: any, i: number) => (
          <rect
            key={`g${i}`}
            x={c.x + 0.03}
            y={cellY(c.z) + 0.03}
            width={0.94}
            height={0.94}
            fill={ghost.willFall ? "#ff4d6d" : ghost.remote ? "#67e8f9" : "#ffffff"}
            opacity={ghost.willFall ? 0.4 : ghost.remote ? 0.4 : 0.2}
            stroke={ghost.willFall ? "#ff8fa3" : ghost.remote ? "#a5f3fc" : "#ffffff"}
            strokeWidth={ghost.remote ? 0.06 : 0.045}
            strokeDasharray={ghost.remote ? "0.12 0.09" : undefined}
            rx={0.06}
          />
        ))}
      {ghost?.label && ghost.cells.length > 0 && (
        <text
          x={(ghostMinX + ghostMaxX + 1) / 2}
          y={yFor(ghostMaxZ + 1.9)}
          textAnchor="middle"
          fontSize={0.46}
          fill="#a5f3fc"
          stroke="#04222e"
          strokeWidth={0.03}
          fontWeight={900}
          letterSpacing={0.04}
        >
          {ghost.label}
        </text>
      )}
      {ghost?.willFall && !ghost.remote && ghost.cells.length > 0 && (
        <text
          x={(ghostMinX + ghostMaxX + 1) / 2}
          y={yFor(ghostMaxZ + 1.9)}
          textAnchor="middle"
          fontSize={0.52}
          fill="#ff8fa3"
          stroke="#3b0312"
          strokeWidth={0.03}
          fontWeight={900}
          letterSpacing={0.04}
        >
          WILL FALL
        </text>
      )}

      {/* Generic drop indicator — a human opponent holds the turn but their
          live aim preview isn't here yet (they haven't picked a block). A
          pulsing outline in the sky band + their name reads as "about to
          drop". */}
      {remoteAiming && !ghost && (
        <g>
          <motion.rect
            x={GRID_WIDTH / 2 - 0.75}
            y={yFor(Math.max(2, maxZ + SKY_CELLS - 1.5))}
            width={1.5}
            height={1.5}
            fill="rgba(103,232,249,0.08)"
            stroke="#67e8f9"
            strokeWidth={0.07}
            strokeDasharray="0.14 0.1"
            rx={0.12}
            initial={false}
            animate={{ opacity: [0.3, 0.85, 0.3], scale: [0.92, 1.06, 0.92] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          />
          <text
            x={GRID_WIDTH / 2}
            y={yFor(Math.max(2, maxZ + SKY_CELLS - 1.5)) - 0.5}
            textAnchor="middle"
            fontSize={0.42}
            fill="#a5f3fc"
            stroke="#04222e"
            strokeWidth={0.03}
            fontWeight={900}
            letterSpacing={0.03}
          >
            {remoteAiming} is aiming…
          </text>
        </g>
      )}

      {/* Drop animation — the placed block (player or bot) falls from the
          sky band onto its landing spot. A stable drop falls and settles
          (the tower block is revealed beneath it); a doomed drop falls in
          red above the ceiling, holds, then fades. Blocks shocked off the
          tower (extra) tumble off at the moment of impact and vanish. */}
      {falling && (
        <>
          {falling.extra.length > 0 && (
            <motion.g
              key={`shock-${falling.key}`}
              initial={{ y: 0, opacity: 1 }}
              animate={{ y: 3.4, opacity: 0 }}
              transition={{ delay: Math.min(0.85, fallSeconds + 0.05), duration: 0.55, ease: "easeIn" }}
            >
              {/* Shed pieces (shocked off by the impact) tumble and fade. */}
              {(falling.extra || []).map((c: any, i: number) => (
                <BlockCell
                  key={i}
                  x={c.x + 0.02}
                  y={cellY(c.z) + 0.02}
                  size={0.96}
                  fill="#ff9f43"
                  edge="#ffdcb0"
                />
              ))}
            </motion.g>
          )}
          {/* Motion trail — the same block drawn three more times, each a
              frame behind it on the identical fall path. They are deliberately
              rendered BEFORE the block so the opaque block always paints on
              top of its own ghosts, and they live inside this `falling` gate:
              the moment the drop is cleared (landed, quit, match changed) the
              whole group unmounts, so no ghost can ever be left behind in the
              tower. Purely visual — derived from `falling.cells` + dropDz +
              fallSeconds, with no state and no timers of its own. */}
          {!reduceMotion &&
            TRAIL_FRAMES.map((frame, i) => (
              <motion.g
                key={`trail-${falling.key}-${i}`}
                data-testid="ta-trail-ghost"
                data-trail-frame={i}
                initial={{
                  x: falling.slideDx || 0,
                  y: -dropDz,
                  opacity: frame.opacity,
                }}
                animate={{ x: 0, y: 0, opacity: 0 }}
                transition={{
                  // Same distance, same duration, same easing as the block —
                  // only the start is delayed, which is what makes these
                  // "previous positions" rather than a second animation.
                  x: { duration: fallSeconds, ease: "easeIn", delay: frame.delay },
                  y: { duration: fallSeconds, ease: "easeIn", delay: frame.delay },
                  // Held at the frame's opacity for the whole fall, then faded
                  // out the instant the drop lands (matching the doomed block's
                  // own fade) so the trail is never visible at rest.
                  opacity: falling.willFall
                    ? { duration: 0.45, delay: fallSeconds + 0.12, ease: "easeIn" }
                    : { duration: 0.2, delay: fallSeconds, ease: "easeOut" },
                }}
              >
                {(falling.cells || []).map((c: any, j: number) => (
                  <BlockCell
                    key={j}
                    x={c.x + 0.02}
                    y={cellY(c.z) + 0.02}
                    size={0.96}
                    fill={fallingFill}
                    edge={fallingEdge}
                  />
                ))}
              </motion.g>
            ))}
          <motion.g
            key={`drop-${falling.key}`}
            data-testid="ta-drop-block"
            initial={{ x: falling.slideDx || 0, y: -dropDz, opacity: 0.95 }}
            animate={
              falling.willFall
                ? { x: 0, y: 0, opacity: [0.95, 1, 1, 0] }
                : { x: 0, y: 0, opacity: 1 }
            }
            transition={
              falling.willFall
                ? {
                    // A doomed drop falls the FULL height in red, pauses a
                    // beat at the breach line, then fades out (the crash
                    // banner + shed tumble land at the same moment).
                    x: { duration: fallSeconds, ease: "easeIn" },
                    y: { duration: fallSeconds, ease: "easeIn" },
                    opacity: { duration: 0.45, delay: fallSeconds + 0.12, ease: "easeIn" },
                  }
                : {
                    // Gravity-style accelerated fall for the whole drop
                    // height, landing exactly on the support.
                    x: { duration: fallSeconds, ease: "easeIn" },
                    y: { duration: fallSeconds, ease: "easeIn" },
                    opacity: { duration: 0.12 },
                  }
            }
          >
            {/* The dropped block FALLS from the sky band down onto its
                landing spot wearing its REAL shape colors (red when the
                drop breaches the ceiling) — identical to the icon and the
                block left in the tower. */}
            {(falling.cells || []).map((c: any, i: number) => (
              <BlockCell
                key={i}
                x={c.x + 0.02}
                y={cellY(c.z) + 0.02}
                size={0.96}
                fill={fallingFill}
                edge={fallingEdge}
              />
            ))}
          </motion.g>
        </>
      )}

      {/* Aim cursor at the top of the stage + drop guide line: it follows
          the mouse over the board (or ◀ ▶ / A-D), R rotates, click/Enter
          drops from here. Rendered in the selected block's own shape color
          so the hover preview already shows what will land. */}
      {cursorCells.length > 0 && (
        <>
          <line
            x1={cursorCenterX}
            y1={yFor(cursorZ0 - 0.4)}
            x2={cursorCenterX}
            y2={yFor(guideBottomZ)}
            stroke={cursor?.danger ? "rgba(255,77,109,0.35)" : "rgba(148,233,255,0.28)"}
            strokeWidth={0.045}
            strokeDasharray="0.18 0.18"
          />
          {cursorCells.map((c: any, i: number) => (
            <BlockCell
              key={`cur${i}`}
              x={c.x + 0.02}
              y={cellY(c.z) + 0.02}
              size={0.96}
              fill={
                cursor?.danger
                  ? "#ff4d6d"
                  : SHAPE_COLORS[cursor.shape as BlockShape]?.fill ?? "#67e8f9"
              }
              edge={
                cursor?.danger
                  ? "#ff8fa3"
                  : SHAPE_COLORS[cursor.shape as BlockShape]?.edge ?? "#ffffff"
              }
              opacity={0.85}
            />
          ))}
        </>
      )}
    </svg>
    </motion.div>
  );
}

// ── Main page component ────────────────────────────────────────────────

export default function TowerArenaMatchPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const router = useRouter();
  const { socket } = useSocket();
  const posthog = usePostHog();

  const [match, setMatch] = useState<Match | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [me, setMe] = useState<any>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedCaptured = useRef(false);

  // Placement state
  const [selectedShape, setSelectedShape] = useState<BlockShape | null>(null);
  const [rotation, setRotation] = useState(0);
  const [positionX, setPositionX] = useState(2);
  const [placing, setPlacing] = useState(false);
  // Live aim preview of the human opponent currently holding the turn (from
  // their room_event broadcasts). Rendered as a labeled ghost while fresh.
  const [opponentAim, setOpponentAim] = useState<{
    userId: string;
    shape: BlockShape;
    positionX: number;
    rotation: number;
  } | null>(null);
  const aimTtlTimer = useRef<number | null>(null);
  // Ready gate
  const [readyBusy, setReadyBusy] = useState(false);
  // Free-play pause
  const [pauseBusy, setPauseBusy] = useState(false);
  // Events
  const [collapseBanner, setCollapseBanner] = useState<any>(null);
  const [showResults, setShowResults] = useState(false);
  // Win/lose result popup — dismissed to reveal the full results view.
  const [resultPopupDismissed, setResultPopupDismissed] = useState(false);
  // Mid-match resignation outcome — placement + payout are decided the moment
  // the player resigns, so their win/lose popup appears immediately.
  const [resignResult, setResignResult] = useState<any>(null);
  const [resignBusy, setResignBusy] = useState(false);
  // Resignation failures used to be completely silent (the request 500'd and
  // the button just appeared dead), so surface the reason inline.
  const [resignError, setResignError] = useState<string | null>(null);
  // One-shot guard for the viewer's OWN result popup. It is surfaced the
  // moment their result is decided — when they resign, or when they are
  // eliminated by a ceiling breach in a 3+ seat match that plays on without
  // them — and a later poll must never re-open it after they dismiss it.
  const matchResultShownRef = useRef(false);
  const [fallingBlock, setFallingBlock] = useState<{
    cells: any[]; // the dropped block's final cells (server-resolved)
    extra: any[]; // shed blocks' cells, pre-collapse positions (contact shock)
    willFall: boolean;
    slideDx: number; // aim column → resolved column (the slippery slip)
    key: number;
    shape: BlockShape | null; // dropped block's shape (for its real colors)
  } | null>(null);
  // Bump to play the impact shake on the stage when a drop lands (contact).
  const [impactKey, setImpactKey] = useState(0);
  // Blocks hidden from the tower render while the sky-drop animation plays
  // (the dropped block + any shocked blocks that shed this placement).
  const [hiddenBlockIds, setHiddenBlockIds] = useState<string[]>([]);
  // blockId of the drop this client animated optimistically at submit time;
  // used to skip re-animating it when the authoritative refresh arrives.
  const ownAnimBlockId = useRef<string | null>(null);
  // blockId of the last remote placement this client animated. Overlapping
  // refreshes (socket push + poll + the submit's own refetch can race) would
  // otherwise re-animate the same entry and restart its fall mid-way.
  const lastAnimatedBlockId = useRef<string | null>(null);
  const fallingKey = useRef(0);
  const fallTimer = useRef<number | null>(null);
  const bannerTimer = useRef<number | null>(null);
  const prevPlacementsLen = useRef<number | null>(null);
  const prevTurnUserId = useRef<string | null>(null);
  // Always-fresh `load` for socket handlers (the effect registers listeners
  // once per socket; a ref keeps them calling the LATEST render's load so
  // `me`/state reads inside are never stale).
  const loadRef = useRef<() => Promise<void>>(async () => {});

  // A ceiling-breaching block is not persisted in the tower. For the short
  // elimination animation, synthesize its visible cells from the placement.
  const visibleCellsFor = (shape: BlockShape, x: number, rotation: number, fallbackZ: number) => {
    const az = Math.max(1, fallbackZ);
    return blockCells(shape, rotation).map(([rx, rz]) => ({
      x: x + rx,
      depth: 0,
      z: az + rz,
    }));
  };

  // Play the drop-from-the-sky animation for a placement (local or remote).
  // `entry` is the server-persisted placement log: it carries the FINAL
  // resolved cells (incl. any slip) and the shed blocks' cells, so every
  // viewer — bots included — sees the exact same fall from the top of the
  // stage, the same slippery slip, and the same contact-shock shed.
  const animateDrop = (entry: any) => {
    const maxZ = (match?.towerState ?? []).reduce(
      (m: number, b: any) => Math.max(m, ...(b.cells || []).map((c: any) => c.z)),
      0,
    );
    const cells = Array.isArray(entry.placedCells) && entry.placedCells.length > 0
      ? entry.placedCells
      : visibleCellsFor(entry.shape, entry.positionX, entry.rotation ?? 0, maxZ + 2);
    const slideDx = (entry.positionX ?? 0) - (entry.resolvedX ?? entry.positionX ?? 0);
    const extra = (entry.removedBlocks || [])
      .filter((r: any) => r.id !== entry.blockId)
      .flatMap((r: any) => r.cells || []);
    const willFall = Boolean(entry.collapsed);
    setHiddenBlockIds(willFall ? (entry.removedBlockIds || [entry.blockId]).slice() : [entry.blockId]);
    fallingKey.current += 1;
    setFallingBlock({
      cells,
      extra,
      willFall,
      slideDx,
      key: fallingKey.current,
      shape: BLOCK_SHAPES.includes(entry.shape) ? entry.shape : null,
    });
    if (fallTimer.current) window.clearTimeout(fallTimer.current);
    fallTimer.current = window.setTimeout(() => {
      setFallingBlock(null);
      setHiddenBlockIds([]);
      // Teardown only — the impact shake is NOT fired from here. The block
      // touches down at `fallSeconds` (≈0.3–0.9s), while this timer holds the
      // drop on screen for 1200/1650ms, so bumping here would land the thud
      // visibly late. TowerScene reports the real landing via onDropLanded.
    }, willFall ? 1650 : 1200);
  };

  const load = async () => {
    try {
      const res = await fetch(`/api/tower-arena/get-match?matchId=${matchId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.message || "Could not load match");
        return;
      }
      setMatch(data.match);
      setPlayers(data.players || []);
      // The viewer's private projection supplies seat, ready, and status for
      // turn authorization and the ready gate.
      if (data.me) setMe(data.me);

      // Own-elimination result popup. In a 3+ seat match the game carries on
      // without an eliminated player, so surface their losing popup as soon
      // as the server says their result is decided — otherwise they are left
      // staring at a board they can no longer touch, with no result at all
      // until the whole match ends. `standing` is the server's own settlement
      // math (placement + payout), so nothing here invents a number; the
      // final survivor still gets the win popup from the final rankings when
      // the match completes.
      const myStanding = data.me?.standing;
      if (
        data.match?.status === "active" &&
        myStanding &&
        !matchResultShownRef.current
      ) {
        matchResultShownRef.current = true;
        setResignResult({
          placement: myStanding.placement,
          payout: Number(myStanding.payout || 0),
          net: Number(myStanding.net || 0),
          isWinner: Boolean(myStanding.isWinner),
          wager: Number(data.match.wager || 0),
          isAi: Boolean(data.match.isAi),
          eliminated: true,
        });
        if (myStanding.isWinner) playVictory();
        else playDefeat();
      }

      // Detect a fresh ceiling-breach: the placements log grew and its
      // newest entry is a collapsed drop → the dropping player is eliminated
      // (shown as a popup on every viewer's board). Runs on active AND just-
      // finished matches so the final elimination still announces itself.
      const plLen = Array.isArray(data.match?.placements) ? data.match.placements.length : 0;
      if (prevPlacementsLen.current !== null && plLen > prevPlacementsLen.current) {
        const last = data.match.placements[plLen - 1];
        if (last?.collapsed) {
          const elim = (data.players || []).find((p: any) => p.userId === last.userId);
          setCollapseBanner({ name: elim?.name || "A player", placement: elim?.placement ?? null });
          playCrash();
          if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
          bannerTimer.current = window.setTimeout(() => setCollapseBanner(null), 3200);
        }
        // Animate EVERY drop — bots' and other players' blocks included —
        // skipping the one we already animated optimistically at submit time
        // and any entry a racing refresh already animated.
        if (last && last.blockId !== ownAnimBlockId.current && last.blockId !== lastAnimatedBlockId.current) {
          animateDrop(last);
          lastAnimatedBlockId.current = last.blockId;
        } else if (last && last.blockId === ownAnimBlockId.current) {
          ownAnimBlockId.current = null;
        }
      }
      prevPlacementsLen.current = plLen;

      // Turn-switch chime when the turn holder changes on an active match.
      const turnId = data.match?.currentTurnPlayerId ?? null;
      const isMine = Boolean(turnId && me?.userId && turnId === me.userId);
      if (prevTurnUserId.current !== null && prevTurnUserId.current !== turnId && data.match?.status === "active") {
        playTurnSwitch(isMine);
      }
      // The previous holder's aim preview is stale once the turn moves on.
      if (prevTurnUserId.current !== null && prevTurnUserId.current !== turnId) {
        setOpponentAim(null);
      }
      prevTurnUserId.current = turnId;

      // Analytics — match started fires once on the active transition.
      if (data.match?.status === "active" && !startedCaptured.current) {
        startedCaptured.current = true;
        posthog?.capture("tower_arena_match_started", {
          wager: data.match.wager,
          maxPlayers: data.match.maxPlayers,
          lobbyType: data.match.isAi ? "ai_freeplay" : "pvp",
          lobby_id: data.match.id,
        });
      }
    } catch {
      // silent
    }
  };
  loadRef.current = load;

  useEffect(() => {
    load();
    // Realtime match events already trigger an authoritative refetch the
    // moment the engine advances; this poll is a backstop only, so a 3s
    // cadence is plenty (was 1.2s) and cuts redundant /get-match calls.
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // Realtime room — participant tracking + instant lobby/match pushes.
  // Every server-authoritative in-match event triggers an authoritative
  // `get-match` refetch (realtime carries only a light signal; the engine remains
  // the source of truth). Socket.IO reconnects on the SAME instance, so we also
  // re-join the rooms + refresh on every `connect` (initial + reconnect).
  useEffect(() => {
    if (!socket || !matchId) return;
    const matchRoom = `tower-arena:match:${matchId}`;
    const lobbyRoom = `tower-arena:lobby:${matchId}`;
    const refresh = () => loadRef.current();

    const joinRooms = () => {
      socket.emit("join_room", { roomId: matchRoom });
      socket.emit("join_room", { roomId: lobbyRoom });
    };
    joinRooms();

    const EVENT_NAMES = [
      "tower_arena_state",
      "tower_arena_turn_started",
      "tower_arena_resource_update",
      "tower_arena_block_placed",
      "tower_arena_collapse",
      "tower_arena_player_eliminated",
      "tower_arena_resource_refill",
      "tower_arena_match_finished",
      "tower-arena:lobby:updated",
    ];
    EVENT_NAMES.forEach((name) => socket.on(name, refresh));

    // Live aim previews from the current human turn holder — light payload,
    // updated directly (no authoritative refetch needed). Expires after a
    // missed-heartbeat TTL so a disconnected aimer's ghost never sticks.
    const onAimUpdate = (data: any) => {
      if (!data?.userId) return;
      if (data.clearing) {
        setOpponentAim(null);
        return;
      }
      const shape = String(data.shape || "") as BlockShape;
      if (!BLOCK_SHAPES.includes(shape)) return;
      setOpponentAim({
        userId: data.userId,
        shape,
        positionX: Math.trunc(Number(data.positionX) || 0),
        rotation: Math.trunc(Number(data.rotation) || 0),
      });
      if (aimTtlTimer.current) window.clearTimeout(aimTtlTimer.current);
      aimTtlTimer.current = window.setTimeout(() => setOpponentAim(null), AIM_TTL_MS);
    };
    socket.on(AIM_UPDATE_EVENT, onAimUpdate);

    // Fires on first connect AND every auto-reconnect; re-establishes room
    // membership (Socket.IO drops rooms server-side on disconnect) and pulls
    // the fresh authoritative snapshot immediately.
    socket.on("connect", joinRooms);
    socket.on("connect", refresh);

    return () => {
      EVENT_NAMES.forEach((name) => socket.off(name, refresh));
      socket.off(AIM_UPDATE_EVENT, onAimUpdate);
      socket.off("connect", joinRooms);
      socket.off("connect", refresh);
      if (aimTtlTimer.current) window.clearTimeout(aimTtlTimer.current);
      socket.emit("leave_room", { roomId: lobbyRoom });
      socket.emit("leave_room", { roomId: matchRoom });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, matchId]);

  // Audio for finish — win/lose follows the player's ACTUAL result (e.g. a
  // 2nd-place finisher in a 6-player game won), not just placement 1.
  useEffect(() => {
    if (match?.status === "finished") {
      const mine = (match.finalRankings || []).find((r: any) => r.userId === me?.userId);
      if (mine?.isWinner) playVictory();
      else playDefeat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.status]);

  const isFinished = match?.status === "finished";
  const activePlayers = players.filter((p) => p.status === "active");
  const isFinalDuel = isFinished ? false : activePlayers.length === 2;

  // ── Result derivation (finish + mid-match resign) ────────────────────
  // The viewer's own result from the authoritative final rankings (placement,
  // payout, and the server-computed win/lose verdict) for the result popup.
  const myFinalResult = useMemo(() => {
    if (!isFinished || !match) return null;
    const mine = (match.finalRankings || []).find((r: any) => r.userId === me?.userId);
    if (!mine) return null;
    return {
      placement: mine.placement,
      payout: Number(mine.payout || 0),
      net: Number(mine.payout || 0) - Number(match.wager || 0),
      // Server-computed verdict; legacy finished records fall back to 1st.
      isWinner: mine.isWinner != null ? Boolean(mine.isWinner) : mine.placement === 1,
      wager: Number(match.wager || 0),
      isAi: Boolean(match.isAi),
    };
  }, [isFinished, match, me]);

  // Per-player game stats for the popup — blocks placed (stable drops),
  // blocks still held in the tower, and collapses caused — from the server
  // placement log + tower state.
  const myStats = useMemo(() => {
    const mine = me?.userId;
    const entries = (match?.placements || []).filter((e: any) => e.userId === mine);
    return {
      blocksPlaced: entries.filter((e: any) => !e.collapsed).length,
      towerBlocks: (match?.towerState || []).filter((b: any) => b.placedByUserId === mine).length,
      collapses: entries.filter((e: any) => e.collapsed).length,
    };
  }, [match, me]);

  useEffect(() => {
    if (isFinished && !showResults) setShowResults(true);
  }, [isFinished, showResults]);

  // Duration + rival (for the shared result screen) — real values only;
  // a multi-player arena (>2 seats) has no single "opponent", so the
  // opponent block is limited to the final 1v1 duel.
  let resultDurationSeconds: number | null = null;
  if (match?.startedAt && match?.endedAt) {
    const t0 = new Date(match.startedAt).getTime();
    const t1 = new Date(match.endedAt).getTime();
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
      resultDurationSeconds = Math.round((t1 - t0) / 1000);
    }
  }
  const rival =
    players.length === 2 ? (players.find((p) => p.userId !== me?.userId) ?? null) : null;

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
      if (fallTimer.current) window.clearTimeout(fallTimer.current);
      if (aiTurnTimer.current) window.clearTimeout(aiTurnTimer.current);
      if (aimTtlTimer.current) window.clearTimeout(aimTtlTimer.current);
    };
  }, []);

  const leave = async () => {
    setLeaving(true);
    try {
      const res = await fetch("/api/tower-arena/cancel-lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lobbyId: matchId }),
      });
      const data = await res.json();
      if (data.ok) router.replace("/casino/tower-arena");
      else setLeaving(false);
    } catch {
      setLeaving(false);
    }
  };

  // In-game resign: the server eliminates the player at their CURRENT place
  // (based on how many players are in the match and where they stand), and
  // the win/lose popup appears immediately with the placement-based payout.
  const resign = async () => {
    if (resignBusy || !isActive) return;
    setResignBusy(true);
    setResignError(null);
    try {
      const res = await fetch("/api/tower-arena/resign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        // The viewer's own result has now been surfaced — a later poll must
        // not re-open the popup from the same standing.
        matchResultShownRef.current = true;
        if (data.matchFinished || data.placement == null) {
          // The match ended (e.g. 2 players) or raced to a terminal state —
          // the finish flow derives the popup from the final rankings.
          await loadRef.current();
        } else {
          setResignResult({
            placement: data.placement,
            payout: Number(data.payout || 0),
            net: Number(data.net || 0),
            isWinner: Boolean(data.isWinner),
            wager: Number(match?.wager || 0),
            isAi: Boolean(match?.isAi),
          });
          if (data.isWinner) playVictory();
          else playDefeat();
        }
      } else {
        setResignError(data.message || "Could not resign — please try again.");
      }
    } catch {
      setResignError("Could not resign — please try again.");
    } finally {
      setResignBusy(false);
    }
  };

  // Ready gate — toggle READY (click again to unready). The server decides
  // when every player is ready and opens the 10s start countdown.
  const toggleReady = async () => {
    if (readyBusy) return;
    setReadyBusy(true);
    try {
      await fetch("/api/tower-arena/ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      loadRef.current();
    } finally {
      setReadyBusy(false);
    }
  };

  // AI turns: when a bot holds the placement turn, ask the server to play it
  // once the bot's short think window (BOT_THINK_MS) passes — the delay is
  // what lets every viewer see the bot's planned-placement ghost before the
  // block pops in. Fires once per turn number; the server's poll backstop
  // resolves the bot if this fires late.
  const aiTurnFiredTurn = useRef<number | null>(null);
  const aiTurnTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!match || match.status !== "active") return;
    if (match.phase !== "placement") return;
    if (match.paused) return; // nothing moves while paused
    const holder = players.find((p) => p.userId === match.currentTurnPlayerId);
    if (!holder?.isAi) return;
    if (aiTurnFiredTurn.current === match.turnNumber) return;
    aiTurnFiredTurn.current = match.turnNumber;
    if (aiTurnTimer.current) window.clearTimeout(aiTurnTimer.current);
    aiTurnTimer.current = window.setTimeout(() => {
      void fetch("/api/tower-arena/ai-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      }).catch(() => {
        // Transient failure (e.g. the poll already resolved the bot) — the
        // next get-match refetch reconciles.
      });
    }, BOT_PLAN_DELAY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.status, match?.phase, match?.currentTurnPlayerId, match?.turnNumber, match?.paused]);

  // ── Derivation for the active board ──────────────────────────────
  const isActive = match?.status === "active";
  const isPaused = Boolean(match?.paused);
  const phase = match?.phase; // "placement"
  const isMyTurn = isActive && !isPaused && phase === "placement" && match?.currentTurnPlayerId === me?.userId && me?.status !== "eliminated";

  const shapeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of match?.resourcePool || []) c[p.shape] = (c[p.shape] || 0) + 1;
    return c;
  }, [match?.resourcePool]);

  const poolTotal = useMemo(
    () => (match?.resourcePool || []).length,
    [match?.resourcePool],
  );

  // Ghost preview uses the same deterministic placement math as the server.
  // It turns red when the block would cross the hard ceiling.
  const ghostBlock = useMemo(() => {
    if (!isMyTurn || !selectedShape) return null;
    const tower = match?.towerState || [];
    const out = simulatePlacement(tower, {
      shape: selectedShape,
      x: positionX,
      rotation,
      blockId: "ghost",
      placedByUserId: me?.userId,
      turnNumber: (match?.turnNumber || 0) + 1,
    });
    const maxZ = tower.reduce((m: number, b: any) => Math.max(m, ...(b.cells || []).map((c: any) => c.z)), 0);
    const cells =
      out.placedBlock && out.placedBlock.cells.length > 0
        ? out.placedBlock.cells
        : visibleCellsFor(selectedShape, positionX, rotation, maxZ + 2);
    return { cells, willFall: out.collapsed, slideDx: 0 };
  }, [isMyTurn, selectedShape, rotation, positionX, match, me]);

  // Remote ghost: when another player holds the placement turn, every viewer
  // sees where they are about to place.
  //   • Bots — the intent is fully deterministic (the server plays
  //     safeFallbackIntent: findSafeDrop, else the smallest available shape
  //     centered), so we run the exact same policy locally and render the
  //     planned cells until the server resolves the drop.
  //   • Humans — their client broadcasts its live aim (shape / column /
  //     rotation) over the match room; we render the last fresh broadcast.
  const remoteGhost = useMemo(() => {
    if (!isActive || isPaused || phase !== "placement") return null;
    const holder = players.find((p) => p.userId === match?.currentTurnPlayerId);
    if (!holder || holder.userId === me?.userId) return null;
    const tower = match?.towerState || [];
    const maxZ = tower.reduce((m: number, b: any) => Math.max(m, ...(b.cells || []).map((c: any) => c.z)), 0);

    let shape: BlockShape;
    let x: number;
    let rotation: number;
    if (holder.isAi) {
      const available: BlockShape[] = [];
      for (const piece of match?.resourcePool || []) {
        if (piece?.shape && !available.includes(piece.shape)) available.push(piece.shape);
      }
      const intent = findSafeDrop(tower, available);
      if (intent) {
        shape = intent.shape;
        x = intent.x;
        rotation = intent.rotation;
      } else {
        shape =
          (["short", "square", "I", "L", "T", "big", "long"] as BlockShape[]).find((s) => available.includes(s)) || "short";
        x = centerXFor(shape, 0);
        rotation = 0;
      }
    } else {
      // Human opponent — only when we've received their fresh live aim.
      const aim = opponentAim;
      if (!aim || aim.userId !== holder.userId) return null;
      shape = aim.shape;
      x = aim.positionX;
      rotation = aim.rotation;
    }

    const out = simulatePlacement(tower, {
      shape,
      x,
      rotation,
      blockId: "remote-ghost",
      placedByUserId: holder.userId,
      turnNumber: (match?.turnNumber || 0) + 1,
    });
    const cells =
      out.placedBlock && out.placedBlock.cells.length > 0
        ? out.placedBlock.cells
        : visibleCellsFor(shape, x, rotation, maxZ + 2);
    return { cells, willFall: out.collapsed, remote: true, label: holder.name };
  }, [isActive, isPaused, phase, players, match, me, opponentAim]);

  // Generic drop indicator: while a HUMAN opponent holds the turn and their
  // live aim preview isn't visible yet (they haven't picked a block), a
  // pulsing marker + their name reads as "about to drop".
  const humanOpponentAiming = useMemo(() => {
    if (!isActive || isPaused || phase !== "placement") return null;
    const holder = players.find((p) => p.userId === match?.currentTurnPlayerId);
    if (!holder || holder.isAi || holder.userId === me?.userId) return null;
    return holder.name;
  }, [isActive, isPaused, phase, players, match, me]);

  // Aim heartbeat: while we're aiming, keep opponents' live preview fresh
  // even when we're parked on a fixed column (they show our last-known aim).
  useEffect(() => {
    if (!isMyTurn || !selectedShape || !socket) return;
    const id = setInterval(() => {
      socket.emit("room_event", {
        roomId: `tower-arena:match:${matchId}`,
        event: AIM_UPDATE_EVENT,
        payload: { shape: selectedShape, positionX, rotation },
      });
    }, 1_500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyTurn, selectedShape, socket, matchId, positionX, rotation]);

  const countdown = useServerCountdown(match?.turnDeadline ?? null);
  const countdownUrgent = isActive && !isPaused && countdown <= 3.5;

  // ── Free-play pause ──────────────────────────────────────────────
  // Only human-vs-AI matches can pause. The server freezes the turn engine
  // while paused and hands back a fresh window on resume, so the deadline
  // never burns a turn.
  const togglePause = async () => {
    if (pauseBusy || !match?.isAi || !isActive) return;
    setPauseBusy(true);
    try {
      await fetch("/api/tower-arena/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId, paused: !isPaused }),
      });
      loadRef.current();
    } finally {
      setPauseBusy(false);
    }
  };

  // ── Handlers ─────────────────────────────────────────────────────

  const clampX = (shape: BlockShape, rot: number, x: number) => {
    const { minX, maxX } = dropRangeFor(shape, rot);
    return Math.max(minX, Math.min(x, maxX));
  };

  // Broadcast our current aim so human opponents see (live) where we're
  // about to place — the human equivalent of the bot's planned-placement
  // ghost. The realtime server stamps our userId and fans it out to the
  // match room; receivers only render it while we're the current holder.
  const emitAim = (shape: BlockShape, x: number, rot: number) => {
    if (!socket || !isMyTurn) return;
    socket.emit("room_event", {
      roomId: `tower-arena:match:${matchId}`,
      event: AIM_UPDATE_EVENT,
      payload: { shape, positionX: x, rotation: rot },
    });
  };

  const selectShape = (shape: BlockShape) => {
    const x = centerXFor(shape, 0);
    setSelectedShape(shape);
    setRotation(0);
    setPositionX(x);
    emitAim(shape, x, 0);
  };

  const rotate = () => {
    if (!selectedShape) return;
    const nr = (rotation + 1) % 4;
    const nx = clampX(selectedShape, nr, positionX);
    setRotation(nr);
    setPositionX(nx);
    emitAim(selectedShape, nx, nr);
  };

  const nudgeX = (dir: number) => {
    if (!selectedShape) return;
    const nx = clampX(selectedShape, rotation, positionX + dir);
    setPositionX(nx);
    emitAim(selectedShape, nx, rotation);
  };

  // Mouse aim: while a block is selected, moving the mouse over the board
  // re-positions the drop column — the block is centered under the pointer
  // (clamped to the valid drop range), so aiming is purely "hover where you
  // want it, click to drop". Opponents still see the live aim via the
  // 1.5s heartbeat, so no socket traffic is sent per mouse move.
  const aimMove = (worldX: number) => {
    if (!isMyTurn || !selectedShape || placing) return;
    const width = blockWidth(selectedShape, rotation);
    const nx = clampX(selectedShape, rotation, Math.round(worldX - width / 2));
    setPositionX(nx);
  };

  // Core submit — takes explicit shape/rotation/x so the server resolves the
  // exact intent against the authoritative pool and tower.
  const place = async (shape: BlockShape, x: number, rot: number) => {
    if (!isMyTurn || placing) return;
    setPlacing(true);
    const res = await fetch("/api/tower-arena/submit-placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId, shape, positionX: x, rotation: rot }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      playTick();
      setSelectedShape(null);
      setRotation(0);
      setPositionX(2);
      // Tell opponents the preview is over — the resolved pop replaces it.
      socket?.emit("room_event", {
        roomId: `tower-arena:match:${matchId}`,
        event: AIM_UPDATE_EVENT,
        payload: { clearing: true },
      });
      load();
    }
    setPlacing(false);
  };

  // Drop the block from the sky: run the full engine outcome locally (same
  // deterministic math the server resolves) so the animation shows the slip,
  // the landing, and any contact-shock shed IMMEDIATELY — then submit. The
  // authoritative refresh skips re-animating this block (ownAnimBlockId).
  const drop = async () => {
    if (!isMyTurn || !selectedShape || placing) return;
    const tower = match?.towerState || [];
    const blockId = `b:${(match?.turnNumber || 0) + 1}`;
    const out = simulatePlacement(tower, {
      shape: selectedShape,
      x: positionX,
      rotation,
      blockId,
      placedByUserId: me?.userId,
      turnNumber: (match?.turnNumber || 0) + 1,
    });
    const maxZ = tower.reduce((m: number, b: any) => Math.max(m, ...(b.cells || []).map((c: any) => c.z)), 0);
    const cells =
      out.placedBlock && out.placedBlock.cells.length > 0
        ? out.placedBlock.cells
        : visibleCellsFor(selectedShape, positionX, rotation, maxZ + 2);
    const extra = (out.fallenBlocks || []).filter((b: any) => b.id !== blockId).flatMap((b: any) => b.cells || []);
    const willFall = out.collapsed;
    ownAnimBlockId.current = blockId;
    setHiddenBlockIds(willFall ? out.removedBlockIds.slice() : [blockId]);
    fallingKey.current += 1;
    setFallingBlock({
      cells,
      extra,
      willFall,
      slideDx: positionX - out.finalX,
      key: fallingKey.current,
      shape: selectedShape,
    });
    if (fallTimer.current) window.clearTimeout(fallTimer.current);
    fallTimer.current = window.setTimeout(() => {
      setFallingBlock(null);
      setHiddenBlockIds([]);
      // Teardown only — the landing (and its rumble) is reported by TowerScene
      // at the exact moment the drop animation reaches the tower.
    }, willFall ? 1650 : 1200);
    await place(selectedShape, positionX, rotation);
  };

  // Keyboard controls — fruit-merge aim: ◀ ▶ (or A/D) move the cursor at
  // the top of the board, R rotates 90°, Enter/Space/▲ drops.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMyTurn || !selectedShape || placing) return;
      const k = e.key.toLowerCase();
      if (e.key === "ArrowLeft" || k === "a") { e.preventDefault(); nudgeX(-1); }
      else if (e.key === "ArrowRight" || k === "d") { e.preventDefault(); nudgeX(1); }
      else if (k === "r" || k === " ") { e.preventDefault(); rotate(); }
      else if (e.key === "Enter" || e.key === "ArrowUp") { e.preventDefault(); void drop(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyTurn, selectedShape, placing]);

  const seats = useMemo(
    () =>
      Array.from({ length: match?.maxPlayers ?? 0 }, (_, i) => {
        const slot = i + 1;
        const p = players.find((x) => x.seat === slot) || null;
        return { seat: slot, player: p, isMe: p?.userId === me?.userId };
      }),
    [players, match, me],
  );

  // ── Result rendering ─────────────────────────────────────────────

  if (error) {
    return (
      <div className="min-h-screen bg-[#050512] px-3 pt-20 pb-24 text-white sm:px-6">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-16 max-w-md rounded-2xl border border-red-800 bg-black/40 p-8 text-center">
          <h1 className="text-2xl font-black text-red-300">Match unavailable</h1>
          <p className="mt-2 text-sm text-white/60">{error}</p>
          <button
            onClick={() => router.replace("/casino/tower-arena")}
            className="mt-6 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-black"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  // ── Waiting room / ready gate ─────────────────────────────────────
  // The match does NOT auto-start when the lobby fills. Every player must
  // click READY (bots are always ready); once everyone is ready a 10-second
  // countdown runs before the placement-only game begins.
  if (!isActive && !isFinished && match?.status === "waiting") {
    const activeCount = players.filter((p) => p.status === "active").length;
    const isLobbyFull = activeCount >= (match?.maxPlayers ?? 0);
    const isCountdown = match?.phase === "countdown";
    const isReadyPhase = match?.phase === "ready";
    const iAmReady = Boolean(me?.ready);
    // Derived from the server deadline so the very first paint is already
    // accurate (the `countdown` hook re-renders us each tick anyway).
    const countdownSeconds =
      isCountdown && match?.turnDeadline
        ? Math.max(0, Math.ceil((new Date(match.turnDeadline).getTime() - Date.now()) / 1000))
        : null;
    return (
      <div className="min-h-screen bg-[#050512] px-3 pb-24 pt-20 text-white sm:px-6">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-6 max-w-lg sm:mt-10">
          <div className="mb-6 text-center">
            <IconBuildingSkyscraper className="mx-auto h-12 w-12 text-cyan-400" />
            <h1 className="mt-3 bg-gradient-to-r from-cyan-300 to-cyan-500 bg-clip-text text-3xl font-black text-transparent">
              Tower Arena
            </h1>
            <p className="mt-1 text-sm text-white/60">Drop blocks onto a tiny floating platform — don't let yours fall into the void.</p>
          </div>
          <div className="rounded-2xl border border-cyan-800 bg-black/30 p-6">
            <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3">
              {seats.map((seat) => {
                const isReady = Boolean(seat.player && (seat.player.isAi || seat.player.ready));
                return (
                  <div
                    key={seat.seat}
                    className={`flex flex-col items-center gap-2 rounded-xl border p-4 ${
                      seat.player ? "border-cyan-500/40 bg-cyan-500/10" : "border-white/15 bg-black/40"
                    }`}
                  >
                    {seat.player ? (
                      <>
                        <FrameAvatar frame={seat.player.profileFrame} iconKey={seat.player.iconKey} name={seat.player.name} size="h-12 w-12" />
                        <p className="max-w-full truncate text-sm font-bold">
                          {seat.player.name}
                          {seat.isMe ? " (you)" : ""}
                        </p>
                        <div className="flex items-center gap-2 text-[10px] font-semibold">
                          {seat.player.userId === match?.hostUserId && (
                            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-amber-300">HOST</span>
                          )}
                          {seat.player.isAi ? (
                            <span className="rounded-full bg-white/10 px-2 py-0.5 text-white/60">BOT</span>
                          ) : null}
                          <span
                            className={`rounded-full px-2 py-0.5 ${
                              isReady ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-white/50"
                            }`}
                          >
                            {isReady ? "READY" : "NOT READY"}
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="animate-pulse py-4 text-sm font-semibold text-white/40">Waiting…</p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Start countdown */}
            {isCountdown && countdownSeconds !== null && (
              <div className="mt-6 flex flex-col items-center rounded-xl border border-amber-500/40 bg-amber-950/30 px-6 py-4">
                <p className="text-xs font-black uppercase tracking-widest text-amber-300">Game starts in</p>
                <p className="mt-1 font-mono text-6xl font-black tabular-nums text-amber-300 drop-shadow-[0_0_20px_rgba(245,255,59,0.4)]">
                  {countdownSeconds}
                </p>
              </div>
            )}

            <div className="mt-6 text-center">
              <span className="text-2xl font-black text-cyan-300">{activeCount} / {match?.maxPlayers}</span>
              <span className="ml-2 text-xs uppercase tracking-widest text-white/50">players</span>
            </div>
            <div className="mt-4 flex items-center justify-center gap-6 text-sm">
              <span>
                Entry:{" "}
                <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
                  {Number(match?.wager).toLocaleString()}
                  <CoinIcon className="h-4 w-4 text-yellow-300" />
                </span>
              </span>
              <span>
                Prize:{" "}
                <span className="font-semibold text-cyan-300">~{Number(match?.prizePool || 0).toLocaleString()}</span>
              </span>
              {match?.isAi && (
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                  FREE PLAY
                </span>
              )}
            </div>
            <p className="mt-4 text-center text-xs text-white/50">
              {!isLobbyFull
                ? `Waiting for ${(match?.maxPlayers ?? 0) - activeCount} more player${(match?.maxPlayers ?? 0) - activeCount === 1 ? "" : "s"} to join…`
                : isCountdown
                  ? "All players ready — get set!"
                  : isReadyPhase
                    ? "Everyone’s here. Click READY to start — the match begins with a 10-second countdown once all players are ready."
                    : "Waiting for more players to join before the ready-up phase…"}
            </p>

            {/* Ready / unready toggle (humans only) */}
            {!me?.isAi && (
              <div className="mt-6 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={toggleReady}
                  disabled={readyBusy}
                  className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-black uppercase tracking-wider transition disabled:opacity-50 ${
                    iAmReady
                      ? "border border-amber-500/60 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                      : "bg-emerald-500 text-black hover:brightness-110"
                  }`}
                >
                  {readyBusy ? "…" : iAmReady ? (isCountdown ? "Not Ready — cancel" : "Not Ready") : "Ready"}
                </button>
                {isCountdown && iAmReady && (
                  <p className="text-[11px] text-white/45">Click again to cancel the start.</p>
                )}
                {match?.isAi && !isCountdown && (
                  <p className="text-[11px] text-white/45">Bots are always ready — click Ready when you’re set.</p>
                )}
              </div>
            )}

            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={leave}
                disabled={leaving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 text-sm font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
              >
                <IconX size={15} /> {leaving ? "Leaving…" : "Leave"}
              </button>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  // ── Results ──────────────────────────────────────────────────────
  // Deliberately NOT an early return any more. Returning here unmounted
  // <GameSessionHost>, which tore the recording frame down before the
  // standings screen or the placement popup could appear. The finished
  // state renders INSIDE the still-mounted host (see the main return
  // below): the game content is swapped for <ResultsView> and the popup
  // stays a sibling of it.
  const showingResults = isFinished && showResults;
  const finalPlacementPopup =
    !resultPopupDismissed && myFinalResult ? (
      <PvpResultScreen
        open
        outcome={myFinalResult.isWinner ? "win" : "loss"}
        headline={`${ordinal(myFinalResult.placement)} place`}
        subline={
          myFinalResult.isAi ? "Free play — no tokens at stake." : undefined
        }
        gameName="Tower Arena"
        opponent={
          rival
            ? {
                name: rival.name || "Opponent",
                iconKey: rival.iconKey || null,
                isAi: Boolean(rival.isAi),
              }
            : null
        }
        tokenDelta={myFinalResult.isAi ? null : myFinalResult.net}
        durationSeconds={resultDurationSeconds}
        summary={[
          { label: "Placement", value: ordinal(myFinalResult.placement) },
          ...(myFinalResult.isAi
            ? []
            : [
                {
                  label: "Stake",
                  value: `${Number(myFinalResult.wager || 0).toLocaleString()} tokens`,
                },
              ]),
        ]}
        details={[
          ...(match?.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
          ...(myFinalResult.isAi
            ? []
            : [
                {
                  label: "Payout",
                  value: `${Number(myFinalResult.payout || 0).toLocaleString()} tokens`,
                },
              ]),
        ]}
        detailsContent={
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              ["Blocks placed", myStats?.blocksPlaced ?? 0],
              ["Blocks in tower", myStats?.towerBlocks ?? 0],
              ["Collapses", myStats?.collapses ?? 0],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-xl border border-white/10 bg-black/30 px-2 py-3"
              >
                <p className="text-xl font-black text-white">{value}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wider text-white/50">
                  {label}
                </p>
              </div>
            ))}
          </div>
        }
        playAgain={{ onClick: () => router.replace("/casino/tower-arena") }}
        onDismiss={() => setResultPopupDismissed(true)}
        dismissLabel="View Results"
      />
    ) : null;

  // ── Live board ───────────────────────────────────────────────────
  const turnHolder = players.find((p) => p.userId === match?.currentTurnPlayerId);
  const currentTurnName = me?.userId === turnHolder?.userId ? "You" : (turnHolder?.name ?? "…");
  // Tower stage: stable 2D stack, aim cursor follows the mouse over the
  // board (click the stage to drop), ghost preview + drop/shock animation.
  const aiming = Boolean(isMyTurn && selectedShape);
  // Tower stage: one node, two sizing modes. `fillHeight` (creator
  // portrait/landscape frames) grows the stage to fill every spare pixel
  // of the shell so the game reads big and phone-like; the default mode
  // (normal desktop/mobile page) keeps a fixed comfortable height.
  const towerStageNode = (fillHeight = false) => (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-xl ${
        fillHeight ? "min-h-0 flex-1" : "h-[min(56vh,520px)] min-h-[380px] sm:h-[480px]"
      }`}
      style={{
        background:
          "radial-gradient(circle at 50% 95%, rgba(45,212,191,0.08), transparent 60%), linear-gradient(#070916, #010205)",
      }}
    >
      {/* The svg fills the stage exactly (h-full); the width cap only
          applies in the fixed-height (non-fill) mode so the floor line
          never spans a huge desktop card. Clicking/tapping the stage drops
          the aimed block from where the cursor sits (fruit-merge). */}
      <div className={`mx-auto h-full w-full ${fillHeight ? "" : "max-w-[700px]"}`}>
        <TowerScene
          tower={(match?.towerState || []).filter((b: any) => !hiddenBlockIds.includes(b.id))}
          ghost={isMyTurn ? ghostBlock : remoteGhost}
          falling={fallingBlock}
          cursor={aiming && ghostBlock ? { shape: selectedShape as BlockShape, x: positionX, rotation, danger: ghostBlock.willFall } : null}
          impact={impactKey}
          onDropLanded={() => setImpactKey((k) => k + 1)}
          remoteAiming={remoteGhost ? null : humanOpponentAiming}
          onStageClick={aiming ? () => void drop() : undefined}
          onAimMove={aiming ? aimMove : undefined}
        />
      </div>
      {/* Aim hint strip (own placement turn only) */}
      {aiming && (
        <div className="pointer-events-none absolute left-0 right-0 top-2 flex justify-center">
          <p className="rounded-full border border-cyan-400/30 bg-black/60 px-3 py-1 text-[11px] font-bold text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.25)]">
            move over the board to aim · <span className="font-black">R</span> rotate · tap to drop
          </p>
        </div>
      )}
      {/* Ceiling-breach elimination popup — announces to the other players
          that this player hit the top of the tower and is out. */}
      <AnimatePresence>
        {collapseBanner && (
          <motion.div
            initial={{ opacity: 0, scale: 0.7, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 420, damping: 24 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="max-w-[90%] rounded-2xl border-2 border-red-500/60 bg-red-950/85 px-8 py-6 text-center shadow-[0_0_40px_rgba(239,68,68,0.5)]">
              <p className="text-xl font-black text-red-300 sm:text-2xl">{collapseBanner.name}</p>
              <p className="mt-1 text-sm font-bold text-white sm:text-base">
                has reached the top of the tower!
              </p>
              <p className="mt-1.5 text-xs font-semibold text-red-200">
                Eliminated · {ordinal(collapseBanner.placement ?? 0)} place
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Free-play pause overlay — the stage freezes until resumed */}
      {isPaused && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/75 backdrop-blur-[2px]">
          <p className="text-2xl font-black uppercase tracking-[0.35em] text-amber-300">Paused</p>
          <p className="max-w-[260px] text-center text-xs text-white/60">
            Free-play match paused — the tower and timer are frozen until you resume.
          </p>
          <button
            type="button"
            onClick={togglePause}
            disabled={pauseBusy}
            className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-black text-black transition hover:brightness-110 disabled:opacity-50"
          >
            {pauseBusy ? "…" : "Resume"}
          </button>
        </div>
      )}
    </div>
  );

  // Turn controls: the block panel is ALWAYS shown during a live match, so
  // every player can keep reading the shared pool (block icons + remaining
  // counts + total). While it is not your turn the panel is simply disabled
  // — nothing is clickable, and the current dropper's name is shown inside
  // the panel instead of the aim controls.
  const turnControlsNode = isActive ? (
    <PlacementControls
      selectedShape={selectedShape}
      shapeCounts={shapeCounts}
      poolTotal={poolTotal}
      rotation={rotation}
      positionX={positionX}
      onSelect={selectShape}
      onRotate={rotate}
      onNudge={nudgeX}
      onDrop={drop}
      placing={placing}
      disabled={!isMyTurn}
      statusText={
        isPaused
          ? "Match paused — the pool is frozen."
          : !isMyTurn
            ? `${currentTurnName} is dropping…`
            : null
      }
    />
  ) : null;

  // Top bar (status strip).
  const topBarNode = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-800 bg-black/40 px-4 py-3">
      <div className="flex items-center gap-3">
        <IconBuildingSkyscraper className="h-7 w-7 text-cyan-400" />
        <div>
          <h1 className="bg-gradient-to-r from-cyan-300 to-cyan-500 bg-clip-text text-xl font-black text-transparent">
            Tower Arena
          </h1>
          <p className="text-[11px] uppercase tracking-widest text-white/50">
            {match?.isAi ? "Free Play" : "PvP"} · Cycle {match?.resourceCycle} · Turn #{match?.turnNumber}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {isFinalDuel ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/15 px-3 py-1 text-xs font-black uppercase tracking-widest text-amber-300">
            <IconTrophy size={14} /> Final Duel
          </span>
        ) : null}
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-widest text-white/50">Current</p>
          <p className="text-sm font-bold text-cyan-200">          {currentTurnName}</p>
        </div>
        {match?.isAi && isActive ? (
          <PauseChip paused={isPaused} busy={pauseBusy} onToggle={togglePause} />
        ) : null}
        {/* Free vs-AI matches are untimed — hide the countdown timer. */}
        {!match?.isAi && (
          <Timer countdown={countdown} urgent={countdownUrgent} isActive={Boolean(isActive)} paused={isPaused} />
        )}
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-widest text-white/50">Players</p>
          <p className="text-sm font-bold text-white">
            {activePlayers.length} / {match?.maxPlayers}
          </p>
        </div>
      </div>
    </div>
  );

  // Out-of-the-running spectators: a player eliminated mid-match (ceiling
  // breach or resignation) stays in the game as a spectator — no auto-kick,
  // no auto-redirect — until they click Return to Lobby. Active players who
  // want out still use Resign.
  const iAmEliminated = Boolean(isActive && me?.status === "eliminated");
  const backToLobby = () => router.replace("/casino/tower-arena");

  // Right: leaderboard + resign / return-to-lobby.
  const leaderboardNode = (
    <div className="rounded-2xl border border-cyan-800 bg-black/40 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-black uppercase tracking-wider text-cyan-300">
        <IconTrophy className="h-4 w-4" /> Players
      </h2>
      <div className="space-y-2">
        {players
          .slice()
          .sort((a, b) => a.seat - b.seat)
          .map((p) => {
            const eliminated = p.status === "eliminated";
            return (
              <div
                key={p.userId}
                className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 ${
                  eliminated ? "border-white/10 bg-black/30 opacity-60" : 
                  p.userId === match?.currentTurnPlayerId && isActive ? "border-cyan-500/60 bg-cyan-500/10" : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <FrameAvatar frame={p.profileFrame} iconKey={p.iconKey} name={p.name} size="h-9 w-9" />                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">
                    {p.name}
                    {p.userId === me?.userId ? " (you)" : ""}
                    {p.prestigeBadge && (
                      <span className="ml-1.5 inline-block rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-px align-middle text-[9px] font-semibold uppercase tracking-wide text-violet-300">
                        {p.prestigeBadge}
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-white/50">
                    {eliminated
                      ? `Eliminated · ${ordinal(p.placement)}`
                      : isActive && p.userId === match?.currentTurnPlayerId
                        ? "Dropping…"
                        : "Active"}
                  </p>
                </div>
                <span className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-white/50">
                  #{p.seat}
                </span>
              </div>
            );
          })}
      </div>

      {iAmEliminated ? (
        <>
          <button
            onClick={backToLobby}
            className="mt-4 w-full rounded-lg border border-cyan-400/60 bg-cyan-500/20 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-cyan-100 shadow-[0_0_16px_rgba(0,229,255,0.15)] transition hover:bg-cyan-500/30"
          >
            Return to Lobby
          </button>
          <p className="mt-2 text-center text-[10px] text-white/45">
            You're out — watch the rest of the game or head back to the lobby.
          </p>
        </>
      ) : (
        <>
          <button
            onClick={resign}
            disabled={resignBusy || !isActive}
            className="mt-4 w-full rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 text-xs font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
          >
            {resignBusy ? "Resigning…" : "Resign"}
          </button>
          {resignError && (
            <p className="mt-2 rounded-lg border border-red-500/30 bg-red-950/40 px-2 py-1.5 text-center text-[10px] font-semibold text-red-200">
              {resignError}
            </p>
          )}
        </>
      )}
    </div>
  );

  // Desktop / landscape / square game body. The block picker lives in the
  // RIGHT column beside the gameboard so it is always on screen (no more
  // scrolling down to click a block), and the Players panel sits BELOW the
  // board where the picker used to be. Grid auto-placement puts the picker
  // in row 1 col 2 and the leaderboard in row 2 col 1 (under the tower);
  // on small screens they stack board → blocks → players.
  const pageBody = (
    <div>
      {topBarNode}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="rounded-2xl border border-cyan-800 bg-gradient-to-b from-[#040d24] to-[#071626] p-4">
          {towerStageNode(false)}
        </div>
        <div>{turnControlsNode}</div>
        <div>{leaderboardNode}</div>
      </div>
    </div>
  );

  // Compact mobile-style players strip for the portrait (phone) frame —
  // players scroll horizontally so the bottom controls stay compact and
  // thumb-reachable. Same data as the full leaderboard; purely visual.
  const compactPlayersNode = (
    <div className="rounded-xl border border-cyan-800 bg-black/40 px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-cyan-300">
          <IconTrophy className="h-3.5 w-3.5" /> Players
        </h2>
        <span className="shrink-0 text-[10px] font-semibold text-white/50">
          {activePlayers.length} / {match?.maxPlayers} in game
        </span>
        {iAmEliminated ? (
          <button
            onClick={backToLobby}
            className="shrink-0 rounded-lg border border-cyan-400/60 bg-cyan-500/20 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-cyan-100 transition hover:bg-cyan-500/30"
          >
            Return
          </button>
        ) : (
          <button
            onClick={resign}
            disabled={resignBusy || !isActive}
            className="shrink-0 rounded-lg border border-red-500/40 bg-red-500/15 px-2.5 py-1 text-[10px] font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
          >
            {resignBusy ? "…" : "Resign"}
          </button>
        )}
      </div>
      {resignError && (
        <p className="mb-2 rounded-lg border border-red-500/30 bg-red-950/40 px-2 py-1 text-[10px] font-semibold text-red-200">
          {resignError}
        </p>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {players
          .slice()
          .sort((a, b) => a.seat - b.seat)
          .map((p) => {
            const eliminated = p.status === "eliminated";
            const isTurn = isActive && p.userId === match?.currentTurnPlayerId;
            return (
              <div
                key={p.userId}
                className={`flex min-w-0 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 ${
                  eliminated
                    ? "border-white/10 bg-black/30 opacity-60"
                    : isTurn
                      ? "border-cyan-500/60 bg-cyan-500/10"
                      : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <FrameAvatar frame={p.profileFrame} iconKey={p.iconKey} name={p.name} size="h-6 w-6" />
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-bold">
                    {p.name}
                    {p.userId === me?.userId ? " (you)" : ""}
                  </p>
                  <p className="text-[9px] uppercase tracking-wider text-white/50">
                    {eliminated ? `Out · ${ordinal(p.placement)}` : isTurn ? "Dropping…" : "Active"}
                  </p>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );

  // Portrait 9:16 creator arrangement — tower on stage filling most of
  // the height, compact status header, controls + players pinned below.

  // Landscape (16:9) / square (1:1) creator arrangement — the tower fills
  // the frame's height with controls + players in a right rail, so the
  // game adapts to any landscape/square ratio instead of scrolling a
  // desktop-sized column.

  return (
    <div
      className={
        showingResults
          ? "min-h-screen bg-[#050512] text-white"
          : "min-h-screen bg-[#050512] px-3 pb-24 pt-20 text-white sm:px-6"
      }
    >
      {/* <ResultsView /> (the finished state) brings its own nav, footer and
          page padding, so the page chrome is skipped here rather than
          doubled up: normal play and the finished screen both render
          exactly as they always did. */}
      {!showingResults && <NavigationBar currentPath="/casino" />}
      <div className={showingResults ? "" : "mx-auto mt-4 max-w-6xl"}>
        <GameSessionHost
          autoStart={isActive}
          autoStop={isFinished}
          // Active-player presence (lobby "N playing"): an eliminated player
          // stays on the live match page (match.status is still "active")
          // watching the survivors, and this page calls that state "out of the
          // running" — so they stop counting the moment they are knocked out,
          // exactly like a spectator on the other games.
          presenceEnabled={!iAmEliminated}
          gameLabel="tower-arena"
        >
          {showingResults ? (
            <ResultsView
              match={match}
              players={players}
              meUserId={me?.userId}
              onBack={() => router.replace("/casino/tower-arena")}
            />
          ) : (
            pageBody
          )}

          {/* Final placement popup (built above) — inside the host, i.e.
              inside the recording frame, so the clip ends on the result. */}
          {finalPlacementPopup}

          {/* Mid-match resign result (over the live board as a spectator) —
              also inside the host so the resign outcome is recorded. Hidden
              once the finished state takes over, exactly as before (the
              placement popup replaces it). */}
          {!showingResults && resignResult && (
            <PvpResultScreen
              open
              outcome={resignResult.isWinner ? "win" : "loss"}
              headline={
                resignResult.eliminated
                  ? `Eliminated · ${ordinal(resignResult.placement)} place`
                  : `${ordinal(resignResult.placement)} place`
              }
              subline={
                resignResult.isAi ? "Free play — no tokens at stake." : undefined
              }
              gameName="Tower Arena"
              opponent={
                rival
                  ? {
                      name: rival.name || "Opponent",
                      iconKey: rival.iconKey || null,
                      isAi: Boolean(rival.isAi),
                    }
                  : null
              }
              tokenDelta={resignResult.isAi ? null : resignResult.net}
              durationSeconds={null}
              summary={[
                { label: "Placement", value: ordinal(resignResult.placement) },
                ...(resignResult.isAi
                  ? []
                  : [
                      {
                        label: "Stake",
                        value: `${Number(resignResult.wager || 0).toLocaleString()} tokens`,
                      },
                    ]),
              ]}
              details={[
                ...(match?.id != null ? [{ label: "Match ID", value: String(match.id) }] : []),
                ...(resignResult.isAi
                  ? []
                  : [
                      {
                        label: "Payout",
                        value: `${Number(resignResult.payout || 0).toLocaleString()} tokens`,
                      },
                    ]),
              ]}
              detailsContent={
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  {[
                    ["Blocks placed", myStats?.blocksPlaced ?? 0],
                    ["Blocks in tower", myStats?.towerBlocks ?? 0],
                    ["Collapses", myStats?.collapses ?? 0],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl border border-white/10 bg-black/30 px-2 py-3"
                    >
                      <p className="text-xl font-black text-white">{value}</p>
                      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-white/50">
                        {label}
                      </p>
                    </div>
                  ))}
                </div>
              }
              playAgain={{ onClick: () => router.replace("/casino/tower-arena") }}
              onDismiss={() => setResignResult(null)}
              dismissLabel="Watch game"
            />
          )}
        </GameSessionHost>
      </div>
      {!showingResults && <Footer />}
    </div>
  );
}

// ── Timer ──────────────────────────────────────────────────────────────

function fmtCountdown(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${s}s`;
}

function Timer({ countdown, urgent, isActive, paused }: { countdown: number; urgent: boolean; isActive: boolean; paused?: boolean }) {
  const seconds = Math.max(0, Math.ceil(countdown));
  const tenths = Math.max(0, Math.floor((countdown - seconds + 1) * 10));
  if (paused) {
    return (
      <div className="flex animate-pulse flex-col items-center rounded-xl border border-amber-500/60 bg-amber-500/15 px-3 py-1">
        <span className="text-[10px] uppercase tracking-widest text-white/50">Timer</span>
        <span className="font-mono text-xl font-black tabular-nums text-amber-300">PAUSED</span>
      </div>
    );
  }
  return (
    <div
      className={`flex flex-col items-center rounded-xl border px-3 py-1 ${
        urgent ? "border-red-500/60 bg-red-950/40" : "border-cyan-700/40 bg-black/40"
      }`}
    >
      <span className="text-[10px] uppercase tracking-widest text-white/50">Timer</span>
      <span
        className={`font-mono text-xl font-black tabular-nums ${
          urgent ? "animate-pulse text-red-300" : "text-cyan-200"
        }`}
      >
        {urgent && isActive ? `${seconds}.${tenths}` : fmtCountdown(seconds)}
      </span>
    </div>
  );
}

// Free-play pause toggle (vs-AI matches only).
function PauseChip({ paused, busy, onToggle }: { paused: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-black uppercase tracking-widest transition disabled:opacity-50 ${
        paused
          ? "border-amber-500/60 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
          : "border-cyan-700/40 bg-black/40 text-cyan-200 hover:border-cyan-500/50"
      }`}
    >
      {paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />}
      {busy ? "…" : paused ? "Resume" : "Pause"}
    </button>
  );
}

// Small side-view glyph of a block shape — the chooser's icon for that
// block. It is drawn from the REAL footprint (blockCells: the same cells
// that land in the tower) and uses the same per-shape color + a matching
// gloss/edge treatment, so the icon is a truthful miniature of the actual
// block — never a misleading text glyph or a different-looking shape.
function BlockGlyph({ shape, size = 26 }: { shape: BlockShape; size?: number }) {
  const cells = blockCells(shape, 0);
  const maxX = Math.max(...cells.map(([x]) => x));
  const maxZ = Math.max(...cells.map(([, z]) => z));
  const w = maxX + 1;
  const h = maxZ + 1;
  // Lay the icon out in real pixels (cell ≈ 6-8 px) so the 1px edges and
  // gloss read crisply at button size.
  const cell = size / Math.max(w, h);
  const style = SHAPE_COLORS[shape] ?? SHAPE_COLORS.short;
  return (
    <svg
      width={w * cell}
      height={h * cell}
      viewBox={`0 0 ${w * cell} ${h * cell}`}
      className="shrink-0"
      aria-hidden
    >
      {cells.map(([x, z], i) => {
        const cx = x * cell;
        const cy = (h - 1 - z) * cell;
        return (
          <g key={i}>
            <rect
              x={cx + 0.6}
              y={cy + 0.6}
              width={cell - 1.2}
              height={cell - 1.2}
              rx={Math.max(1, cell * 0.14)}
              fill={style.fill}
              stroke={style.edge}
              strokeWidth={Math.max(0.8, cell * 0.09)}
            />
            {/* Top gloss — same orientation as the real block cells. */}
            <rect
              x={cx + cell * 0.14}
              y={cy + cell * 0.12}
              width={cell * 0.72}
              height={cell * 0.24}
              rx={Math.max(0.6, cell * 0.09)}
              fill="#ffffff"
              opacity={0.34}
            />
            {/* Bottom bevel */}
            <rect
              x={cx + cell * 0.14}
              y={cy + cell * 0.78}
              width={cell * 0.72}
              height={cell * 0.14}
              rx={Math.max(0.5, cell * 0.06)}
              fill="#000000"
              opacity={0.22}
            />
          </g>
        );
      })}
    </svg>
  );
}

// ── Placement controls ─────────────────────────────────────────────────

function PlacementControls(props: any) {
  const {
    selectedShape,
    shapeCounts,
    poolTotal,
    rotation,
    positionX,
    onSelect,
    onRotate,
    onNudge,
    onDrop,
    placing,
    disabled = false,
    statusText = null,
  } = props;

  const available = BLOCK_SHAPES.filter((s) => (shapeCounts[s] || 0) > 0);
  const interactive = !disabled;

  return (
    <div
      className={`mt-4 rounded-xl border bg-black/30 p-4 ${
        disabled ? "border-cyan-900/30" : "border-cyan-700/40"
      }`}
    >
      <p className="mb-2 text-xs font-semibold text-white/70">
        {disabled
          ? "Blocks left in the shared pool — pick one when it's your turn."
          : "Pick a block — it drops from the sky onto the tower."}
      </p>

      {/* Block chooser: each button shows a truthful mini-icon of the
          block (its real footprint + color) with the count remaining.
          Selecting a shape enters aim mode. While it is not your turn the
          buttons stay visible for reference but are disabled. */}
      <div className="flex flex-wrap items-center gap-2">
        {available.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSelect(s)}
              disabled={placing || disabled}
              title={
                disabled
                  ? `${SHAPE_NAME[s]} — ${shapeCounts[s] || 0} left (pick on your turn)`
                  : `${SHAPE_NAME[s]} — ${shapeCounts[s] || 0} available`
              }
              aria-label={`${SHAPE_NAME[s]} block, ${shapeCounts[s] || 0} available${disabled ? ", disabled until your turn" : ""}`}
              aria-disabled={disabled || undefined}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition ${
                interactive && selectedShape === s
                  ? "border-cyan-400 bg-cyan-500/20 shadow-[0_0_14px_rgba(0,229,255,0.3)]"
                  : disabled
                    ? "cursor-not-allowed border-white/10 bg-white/[0.02] opacity-60"
                    : "border-white/15 bg-white/[0.03] hover:border-cyan-500/40"
              } disabled:opacity-60`}
            >
              <BlockGlyph shape={s} size={26} />
              <span
                className={`text-xs font-bold ${disabled ? "text-white/45" : "text-white/70"}`}
              >
                ×{shapeCounts[s] || 0}
              </span>
            </button>
          ))}
        <span className="ml-auto rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-cyan-200/80">
          {poolTotal} blocks left
        </span>
      </div>

      {interactive && selectedShape ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-white">
            {SHAPE_NAME[selectedShape]} · column {positionX} · rot {rotation * 90}°
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onNudge(-1)} className="controlBtn" aria-label="Aim left">
              <IconArrowsLeftRight className="h-4 w-4 scale-x-[-1]" />
            </button>
            <button type="button" onClick={() => onNudge(1)} className="controlBtn" aria-label="Aim right">
              <IconArrowsLeftRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={onRotate} className="controlBtn" aria-label="Rotate 90°">
              <IconRotate className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onDrop}
              disabled={placing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-black text-black transition hover:brightness-110 disabled:opacity-50"
            >
              <IconHandStop className="h-4 w-4" /> {placing ? "Dropping…" : "Drop"}
            </button>
          </div>
        </div>
      ) : disabled && statusText ? (
        <p className="mt-3 text-sm font-semibold text-cyan-200/80">{statusText}</p>
      ) : interactive ? (
        <p className="mt-3 text-sm text-white/50">
          Pick a block, then move over the board to aim it (or use ◀ ▶),
          rotate with R, and tap the stage to drop. Blocks stay where they
          land; crossing the ceiling eliminates the current player.
        </p>
      ) : null}
    </div>
  );
}

// ── Results view ───────────────────────────────────────────────────────

function ResultsView({ match, players, meUserId, onBack }: any) {
  const ranked = (match?.finalRankings || []).slice().sort((a: any, b: any) => a.placement - b.placement);
  return (
    <div className="min-h-screen bg-[#050512] px-3 pb-24 pt-20 text-white sm:px-6">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-8 max-w-2xl">
        <div className="mb-6 text-center">
          <IconTrophy className="mx-auto h-10 w-10 text-amber-400" />
          <h1 className="mt-2 text-2xl font-black text-amber-300">Match Finished</h1>
          <p className="text-sm text-white/60">Tower Arena #{String(match?.id).slice(-8)}</p>
        </div>

        <div className="rounded-2xl border border-cyan-800 bg-black/40 p-5">
          <div className="space-y-2">
            {ranked.map((r: any, i: number) => {
              const p = players.find((x: any) => x.userId === r.userId);
              const net = Number(r.payout || 0) - Number(match?.wager || 0);
              // Server-computed win/lose verdict (falls back for old records).
              const isWinner = r.isWinner != null ? Boolean(r.isWinner) : r.placement === 1;
              return (
                <div
                  key={r.userId}
                  className={[
                    "flex items-center gap-3 rounded-xl border px-4 py-3",
                    isWinner ? "border-amber-500/50 bg-amber-500/10" : "border-white/10 bg-white/[0.03]",
                  ].join(" ")}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-sm font-black text-amber-300">
                    {ordinal(r.placement)}
                  </div>
                  <FrameAvatar frame={p?.profileFrame} iconKey={p?.iconKey} name={p?.name} size="h-11 w-11" />
                  <div className="min-w-0 flex-1">                    <p className="truncate text-sm font-bold">
                      {p?.name}
                      {r.userId === meUserId ? " (you)" : ""}
                      {p?.prestigeBadge && (
                        <span className="ml-1.5 inline-block rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-px align-middle text-[9px] font-semibold uppercase tracking-wide text-violet-300">
                          {p.prestigeBadge}
                        </span>
                      )}
                    </p>

                    <p className="text-[10px] uppercase tracking-wider text-white/50">
                      {isWinner ? "Survivor" : "Eliminated"} · Seat #{r.seat}
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-white/60">
                      Wager <span className="font-semibold text-yellow-300">{Number(match?.wager).toLocaleString()}</span>
                    </p>
                    <p className="text-white/60">
                      Payout <span className="font-semibold text-cyan-300">{Number(r.payout || 0).toLocaleString()}</span>
                    </p>
                    <p className={net >= 0 ? "font-bold text-emerald-300" : "font-bold text-red-300"}>
                      {net >= 0 ? "+" : ""}
                      {net.toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex items-center justify-center gap-6 border-t border-cyan-800/50 pt-4 text-sm">
            <span className="text-white/60">
              Prize pool <span className="font-bold text-cyan-300">{Number(match?.prizePool || 0).toLocaleString()}</span>
            </span>
            <button onClick={onBack} className="rounded-lg bg-cyan-500 px-5 py-2 font-bold text-black transition hover:brightness-110">
              Back to Lobby
            </button>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}

function ordinal(n: number): string {
  if (n == null) return "";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
