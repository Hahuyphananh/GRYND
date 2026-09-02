"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { usePostHog } from "posthog-js/react";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the match actually starts,
// auto-stops when it ends or the user quits. Portrait 9:16 renders the
// phone-style stacked arrangement; landscape/square reuse the desktop
// grid. No gameplay logic touched.
import CreatorModeHost from "../../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorModeShell,
  CreatorView,
  ShellHeader,
  ShellMain,
  ShellAside,
} from "../../../../../components/creator-mode/CreatorModeLayout";
import NavigationBar from "../../../../../components/navigation-bar";
import Footer from "../../../../../components/Footer";
import IconAvatar from "../../../../../components/IconAvatar";
import { useSocket } from "../../../../../context/SocketProvider";
import { CoinIcon } from "../../../../../components/lobby/PvpLobby";
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

const SHAPE_LABEL: Record<BlockShape, string> = {
  I: "I",
  L: "L",
  T: "T",
  square: "▪",
  short: "▮",
};

const SHAPE_NAME: Record<BlockShape, string> = {
  I: "Beam",
  L: "Spire",
  T: "Post",
  square: "Square",
  short: "Short",
};

const BLOCK_PALETTE = [
  "#00e5ff",
  "#f5ff3b",
  "#ff5c8a",
  "#7cf29c",
  "#ff9f43",
  "#a78bfa",
  "#38bdf8",
  "#f472b6",
];

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
};

type Player = {
  userId: string;
  seat: number;
  status: string;
  placement: number | null;
  isAi: boolean;
  ready: boolean;
  name: string;
  iconKey: string;
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

function TowerScene({
  tower,
  ghost,
  falling,
  cursor,
  impact,
  remoteAiming,
  onStageClick,
}: {
  tower: any[];
  ghost?: { cells: any[]; willFall: boolean; remote?: boolean; label?: string } | null;
  falling?: { cells: any[]; extra: any[]; willFall: boolean; slideDx: number; key: number } | null;
  cursor?: { shape: BlockShape; x: number; rotation: number; danger: boolean } | null;
  impact?: number;
  remoteAiming?: string | null;
  onStageClick?: () => void;
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
  const X_MIN = -1.4;
  const X_MAX = GRID_WIDTH + 1.4;

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

  // y is bottom-aligned: the floor line always sits on the bottom edge of
  // the stage, no matter how the container's aspect ratio differs.
  return (
    <motion.div
      className="h-full w-full"
      animate={{ x: impact ? [0, -3, 3, -2, 2, 0] : 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <svg
        viewBox={`${X_MIN} 0 ${X_MAX - X_MIN} ${viewH}`}
        className={onStageClick ? "h-full w-full cursor-pointer select-none" : "h-full w-full select-none"}
        preserveAspectRatio="xMidYMax meet"
        onClick={onStageClick}
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
          the player, while every block below it remains fixed. Drawn bright
          and layered so it always reads against the sky — the game is
          decided at this line. */}
      <line
        x1={0}
        y1={ceilingY}
        x2={GRID_WIDTH}
        y2={ceilingY}
        stroke="rgba(255,207,90,0.28)"
        strokeWidth={0.34}
      />
      <line
        x1={0}
        y1={ceilingY}
        x2={GRID_WIDTH}
        y2={ceilingY}
        stroke="#ffcf5a"
        strokeWidth={0.11}
        strokeDasharray="0.3 0.16"
        opacity={0.95}
      />
      <text
        x={X_MAX - 0.15}
        y={ceilingY + 0.18}
        fontSize={0.4}
        fill="#ffcf5a"
        fontWeight={900}
        letterSpacing={0.03}
        textAnchor="end"
      >
        CEILING
      </text>

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

      {/* The floor line (z 0..1) — a thin platform pinned to the bottom of
          the stage; the bright top edge reads as THE LINE blocks stand on */}
      <rect
        x={0}
        y={yFor(1)}
        width={GRID_WIDTH}
        height={1}
        fill="url(#ta-platform)"
        stroke="rgba(94,234,212,0.85)"
        strokeWidth={0.06}
        rx={0.08}
      />
      <line
        x1={0}
        y1={yFor(1)}
        x2={GRID_WIDTH}
        y2={yFor(1)}
        stroke="#9dfff0"
        strokeWidth={0.1}
        opacity={0.95}
      />
      {Array.from({ length: GRID_WIDTH - 1 }, (_, i) => (
        <line
          key={`t${i}`}
          x1={i + 1}
          y1={yFor(1.04)}
          x2={i + 1}
          y2={yFor(0.96)}
          stroke="rgba(1,22,30,0.7)"
          strokeWidth={0.05}
        />
      ))}
      {/* Cliff edge glow where the platform meets the void below */}
      <line x1={0} y1={yFor(1.05)} x2={0} y2={yFor(1.8)} stroke="rgba(94,234,212,0.2)" strokeWidth={0.05} />
      <line x1={GRID_WIDTH} y1={yFor(1.05)} x2={GRID_WIDTH} y2={yFor(1.8)} stroke="rgba(94,234,212,0.2)" strokeWidth={0.05} />

      {/* Tower blocks (oldest first so newer blocks paint above) */}
      {sortedBlocks.map((b, i) => {
        const color = BLOCK_PALETTE[i % BLOCK_PALETTE.length];
        return (b.cells || []).map((c: any) => (
          <rect
            key={`${b.id}-${c.x}:${c.z}`}
            x={c.x + 0.03}
            y={cellY(c.z) + 0.03}
            width={0.94}
            height={0.94}
            fill={color}
            opacity={0.95}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={0.04}
            rx={0.06}
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

      {/* Pop-in animation — the block no longer falls from the sky; it
          appears with a springy pop right where it lands. A stable drop pops
          in and stays (the tower block is revealed beneath it); a doomed
          drop pops in red above the ceiling, holds, then fades. Blocks
          shocked off the tower (extra) tumble in place and vanish. */}
      {falling && (
        <>
          {falling.extra.length > 0 && (
            <motion.g
              key={`shock-${falling.key}`}
              initial={{ y: 0, opacity: 1 }}
              animate={{ y: 3.4, opacity: 0 }}
              transition={{ delay: 0.35, duration: 0.5, ease: "easeIn" }}
            >
              {(falling.extra || []).map((c: any, i: number) => (
                <rect
                  key={i}
                  x={c.x + 0.03}
                  y={cellY(c.z) + 0.03}
                  width={0.94}
                  height={0.94}
                  fill="#ff9f43"
                  opacity={0.9}
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth={0.04}
                  rx={0.06}
                />
              ))}
            </motion.g>
          )}
          <motion.g
            key={`pop-${falling.key}`}
            initial={{ scale: 0.2, opacity: 0 }}
            animate={
              falling.willFall
                ? { scale: 1, opacity: [1, 1, 0], y: 0 }
                : { scale: 1, opacity: 1, y: 0 }
            }
            transition={
              falling.willFall
                ? {
                    scale: { type: "spring", stiffness: 620, damping: 20 },
                    opacity: { duration: 1.05, times: [0, 0.68, 1], ease: "easeIn" },
                  }
                : {
                    scale: { type: "spring", stiffness: 460, damping: 14 },
                    opacity: { duration: 0.1 },
                  }
            }
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          >
            {(falling.cells || []).map((c: any, i: number) => (
              <rect
                key={i}
                x={c.x + 0.03}
                y={cellY(c.z) + 0.03}
                width={0.94}
                height={0.94}
                fill={falling.willFall ? "#ff4d6d" : "#a7f3d0"}
                opacity={0.94}
                stroke="rgba(255,255,255,0.65)"
                strokeWidth={0.04}
                rx={0.06}
              />
            ))}
          </motion.g>
        </>
      )}

      {/* Aim cursor at the top of the stage + drop guide line (fruit-merge
          feel): move left/right, R rotates, click/Enter drops from here. */}
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
            <rect
              key={`cur${i}`}
              x={c.x + 0.03}
              y={cellY(c.z) + 0.03}
              width={0.94}
              height={0.94}
              fill={cursor?.danger ? "#ff4d6d" : "#67e8f9"}
              opacity={0.75}
              stroke="#ffffff"
              strokeWidth={0.05}
              rx={0.08}
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
  const [fallingBlock, setFallingBlock] = useState<{
    cells: any[]; // the dropped block's final cells (server-resolved)
    extra: any[]; // shed blocks' cells, pre-collapse positions (contact shock)
    willFall: boolean;
    slideDx: number; // aim column → resolved column (the slippery slip)
    key: number;
  } | null>(null);
  // Bump to play the impact shake on the stage when a drop lands (contact).
  const [impactKey, setImpactKey] = useState(0);
  // Blocks hidden from the tower render while the sky-drop animation plays
  // (the dropped block + any shocked blocks that shed this placement).
  const [hiddenBlockIds, setHiddenBlockIds] = useState<string[]>([]);
  // blockId of the drop this client animated optimistically at submit time;
  // used to skip re-animating it when the authoritative refresh arrives.
  const ownAnimBlockId = useRef<string | null>(null);
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
    setFallingBlock({ cells, extra, willFall, slideDx, key: fallingKey.current });
    if (fallTimer.current) window.clearTimeout(fallTimer.current);
    fallTimer.current = window.setTimeout(() => {
      setFallingBlock(null);
      setHiddenBlockIds([]);
      // Contact + shock: the stage shakes when the drop (or collapse) lands.
      setImpactKey((k) => k + 1);
    }, willFall ? 1150 : 700);
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
        // Animate EVERY drop with the pop — bots' and other players' blocks
        // included — skipping the one we already animated at submit time.
        if (last && last.blockId !== ownAnimBlockId.current) {
          animateDrop(last);
        } else if (last) {
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
    try {
      const res = await fetch("/api/tower-arena/resign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
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
      }
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
          (["short", "square", "I", "T", "L"] as BlockShape[]).find((s) => available.includes(s)) || "short";
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
    setFallingBlock({ cells, extra, willFall, slideDx: positionX - out.finalX, key: fallingKey.current });
    if (fallTimer.current) window.clearTimeout(fallTimer.current);
    fallTimer.current = window.setTimeout(() => {
      setFallingBlock(null);
      setHiddenBlockIds([]);
      // The landing (or collapse) hits the tower — contact shock.
      setImpactKey((k) => k + 1);
    }, willFall ? 1150 : 700);
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
                        <IconAvatar iconKey={seat.player.iconKey} name={seat.player.name} size="h-12 w-12" />
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
  if (isFinished && showResults) {
    return (
      <>
        <ResultsView match={match} players={players} meUserId={me?.userId} onBack={() => router.replace("/casino/tower-arena")} />
        {!resultPopupDismissed && myFinalResult && (
          <ResultPopup
            result={myFinalResult}
            stats={myStats}
            onDismiss={() => setResultPopupDismissed(true)}
            onBack={() => router.replace("/casino/tower-arena")}
          />
        )}
      </>
    );
  }

  // ── Live board ───────────────────────────────────────────────────
  const turnHolder = players.find((p) => p.userId === match?.currentTurnPlayerId);
  const currentTurnName = me?.userId === turnHolder?.userId ? "You" : (turnHolder?.name ?? "…");
  // Tower stage: stable 2D stack, aim cursor at the top (click the
  // stage to drop), ghost preview + drop/shock animation.
  const aiming = Boolean(isMyTurn && selectedShape);
  const towerInnerNode = (
    // Fixed-height stage: the floor line renders pinned to its bottom edge.
    <div
      className="relative flex h-[380px] items-center justify-center overflow-hidden rounded-xl sm:h-[420px]"
      style={{
        background:
          "radial-gradient(circle at 50% 95%, rgba(45,212,191,0.08), transparent 60%), linear-gradient(#070916, #010205)",
      }}
    >
      {/* The svg fills the stage exactly (h-full) and is width-capped so the
          small floor line never spans the whole screen. Clicking the stage
          drops the aimed block from where the cursor sits (fruit-merge). */}
      <div className="mx-auto h-full w-full max-w-[560px]">
        <TowerScene
          tower={(match?.towerState || []).filter((b: any) => !hiddenBlockIds.includes(b.id))}
          ghost={isMyTurn ? ghostBlock : remoteGhost}
          falling={fallingBlock}
          cursor={aiming && ghostBlock ? { shape: selectedShape as BlockShape, x: positionX, rotation, danger: ghostBlock.willFall } : null}
          impact={impactKey}
          remoteAiming={remoteGhost ? null : humanOpponentAiming}
          onStageClick={aiming ? () => void drop() : undefined}
        />
      </div>
      {/* Aim hint strip (own placement turn only) */}
      {aiming && (
        <div className="pointer-events-none absolute left-0 right-0 top-2 flex justify-center">
          <p className="rounded-full border border-cyan-400/30 bg-black/60 px-3 py-1 text-[11px] font-bold text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.25)]">
            ◀ ▶ aim · <span className="font-black">R</span> rotate · click /
            <span className="font-black">↵</span> to drop
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

  // Turn controls: placement controls or the "opponent dropping" commentary.
  const turnControlsNode = (
    <>
      {isMyTurn && (
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
        />
      )}
      {isActive && !isMyTurn && (
        <p className="mt-4 text-center text-sm text-white/60">
          {currentTurnName} is dropping… {!turnHolder?.isAi && turnHolder?.userId !== me?.userId ? "(watch the tower — every block changes the balance)" : ""}
        </p>
      )}
    </>
  );

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
        <Timer countdown={countdown} urgent={countdownUrgent} isActive={Boolean(isActive)} paused={isPaused} />
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-widest text-white/50">Players</p>
          <p className="text-sm font-bold text-white">
            {activePlayers.length} / {match?.maxPlayers}
          </p>
        </div>
      </div>
    </div>
  );

  // Right: leaderboard + resign.
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
                <IconAvatar iconKey={p.iconKey} name={p.name} size="h-9 w-9" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">
                    {p.name}
                    {p.userId === me?.userId ? " (you)" : ""}
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

      <button
        onClick={resign}
        disabled={resignBusy || !isActive}
        className="mt-4 w-full rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 text-xs font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
      >
        {resignBusy ? "Resigning…" : "Resign"}
      </button>
    </div>
  );

  // Desktop / landscape / square game body.
  const pageBody = (
    <div>
      {topBarNode}
      {/* Body: tower center + leaderboard right (desktop), stacked mobile */}
      <div className="grid gap-4 lg:grid-cols-[1fr_290px]">
        <div className="rounded-2xl border border-cyan-800 bg-gradient-to-b from-[#040d24] to-[#071626] p-4">
          {towerInnerNode}
          {turnControlsNode}
        </div>
        <div>{leaderboardNode}</div>
      </div>
    </div>
  );

  // Portrait 9:16 creator arrangement — tower on stage filling most of
  // the height, compact status header, controls + players pinned below.
  const portraitContent = (
    <CreatorModeShell className="bg-[#050512]">
      <ShellHeader className="flex flex-col items-stretch gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <IconBuildingSkyscraper className="h-6 w-6 shrink-0 text-cyan-400" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-black tracking-tight text-cyan-100">
                Tower Arena
              </h1>
              <p className="truncate text-[10px] uppercase tracking-widest text-white/50">
                {match?.isAi ? "Free Play" : "PvP"} · Cycle {match?.resourceCycle} · Turn #{match?.turnNumber}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isFinalDuel ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-amber-300">
                <IconTrophy size={12} /> Final Duel
              </span>
            ) : null}
            {match?.isAi && isActive ? (
              <PauseChip paused={isPaused} busy={pauseBusy} onToggle={togglePause} />
            ) : null}
            <Timer countdown={countdown} urgent={countdownUrgent} isActive={Boolean(isActive)} paused={isPaused} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] font-semibold">
          <span className="truncate text-cyan-200">
            {`${currentTurnName} dropping…`}
          </span>
          <span className="shrink-0 text-white/60">
            {activePlayers.length} / {match?.maxPlayers} players
          </span>
        </div>
      </ShellHeader>

      <ShellMain className="flex-col items-center justify-start overflow-y-auto">
        <div className="w-full max-w-[640px] px-3 py-2">
          <div className="rounded-2xl border border-cyan-800 bg-gradient-to-b from-[#040d24] to-[#071626] p-4">
            {towerInnerNode}
          </div>
        </div>
      </ShellMain>

      <ShellAside>
        <div className="flex flex-col gap-2">
          {turnControlsNode}
          {leaderboardNode}
        </div>
      </ShellAside>
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) creator arrangement — reuse the
  // standard grid inside the frame shell so it adapts responsively.
  const landscapeContent = (
    <CreatorModeShell className="bg-[#050512]">
      <ShellMain className="items-start justify-start overflow-y-auto">
        {pageBody}
      </ShellMain>
    </CreatorModeShell>
  );

  return (
    <div className="min-h-screen bg-[#050512] px-3 pb-24 pt-20 text-white sm:px-6">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-6xl">
        <CreatorModeHost
          autoStart={isActive}
          autoStop={isFinished}
          gameLabel="tower-arena"
        >
          <CreatorView
            normal={pageBody}
            portrait={portraitContent}
            landscape={landscapeContent}
          />
        </CreatorModeHost>
      </div>
      <Footer />
      {/* Mid-match resign result popup (over the live board as a spectator) */}
      {resignResult && (
        <ResultPopup
          result={resignResult}
          stats={myStats}
          dismissLabel="Watch game"
          onDismiss={() => setResignResult(null)}
          onBack={() => router.replace("/casino/tower-arena")}
        />
      )}
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

// Small side-view glyph of a block shape — makes the pool pieces visible
// ("the blocks are actually there") instead of only text labels.
function BlockGlyph({ shape, size = 24 }: { shape: BlockShape; size?: number }) {
  const cells = blockCells(shape, 0);
  const maxZ = Math.max(...cells.map(([, z]) => z));
  const maxX = Math.max(...cells.map(([x]) => x));
  const w = maxX + 1;
  const h = maxZ + 1;
  const cell = size / Math.max(w, h);
  const color = BLOCK_PALETTE[BLOCK_SHAPES.indexOf(shape) % BLOCK_PALETTE.length];
  return (
    <svg
      width={w * cell}
      height={h * cell}
      viewBox={`0 0 ${w * cell} ${h * cell}`}
      className="shrink-0"
      aria-hidden
    >
      {cells.map(([x, z], i) => (
        <rect
          key={i}
          x={x * cell + 0.4}
          y={(h - 1 - z) * cell + 0.4}
          width={cell - 0.8}
          height={cell - 0.8}
          fill={color}
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={0.6}
          rx={1}
        />
      ))}
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
  } = props;

  const available = BLOCK_SHAPES.filter((s) => (shapeCounts[s] || 0) > 0);

  return (
    <div className="mt-4 rounded-xl border border-cyan-700/40 bg-black/30 p-4">
      <p className="mb-2 text-xs font-semibold text-white/70">
        Choose a block to drop — it appears at the top of the tower.
      </p>

      {/* Block chooser: selecting a shape enters aim mode. */}
      <div className="flex flex-wrap items-center gap-2">
        {available.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSelect(s)}
              disabled={placing}
              className={`rounded-lg border px-3 py-2 text-sm font-bold transition ${
                selectedShape === s
                  ? "border-cyan-400 bg-cyan-500/20 text-cyan-100 shadow-[0_0_14px_rgba(0,229,255,0.3)]"
                  : "border-white/15 bg-white/[0.03] text-white/80 hover:border-cyan-500/40"
              } disabled:opacity-50`}
            >
              <span className="mr-1">{SHAPE_LABEL[s]}</span>
              <span className="text-white/40">×{shapeCounts[s] || 0}</span>
            </button>
          ))}
        <span className="ml-auto rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-cyan-200/80">
          {poolTotal} blocks left
        </span>
      </div>

      {selectedShape ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-white">            {SHAPE_NAME[selectedShape]}{" "}

            · aim {positionX} · rot {rotation * 90}°
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
      ) : (
        <p className="mt-3 text-sm text-white/50">
          Pick a block and it hovers at the top of the board — aim it, rotate with R, then click the
          stage (or press Enter) to drop it. Blocks remain fixed after they land; exceeding the
          ceiling eliminates the current player.
        </p>
      )}
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
                  <IconAvatar iconKey={p?.iconKey} name={p?.name} size="h-11 w-11" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">
                      {p?.name}
                      {r.userId === meUserId ? " (you)" : ""}
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

// ── Result popup (win / lose) ──────────────────────────────────────────
//
// Shown to each player with THEIR OWN result: placement, game stats and the
// profit/loss. Paid matches show the money (win = payout beats the wager);
// free-play shows placement + stats only. Used both on match finish and when
// a player resigns mid-match (their placement + payout are already decided).

function ResultPopup({
  result,
  stats,
  onDismiss,
  onBack,
  dismissLabel = "View Results",
}: {
  result: any;
  stats?: { blocksPlaced: number; towerBlocks: number; collapses: number };
  onDismiss?: () => void;
  onBack: () => void;
  dismissLabel?: string;
}) {
  const { placement, payout, net, isWinner, isAi, wager } = result;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.7, opacity: 0, y: 24 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        className={`w-full max-w-md rounded-3xl border-2 p-6 text-center shadow-2xl ${
          isWinner
            ? "border-amber-400/70 bg-gradient-to-b from-[#2a1d05] to-[#120c02] shadow-[0_0_60px_rgba(251,191,36,0.25)]"
            : "border-red-500/60 bg-gradient-to-b from-[#2a0707] to-[#120303]"
        }`}
      >
        {isWinner ? (
          <IconTrophy className="mx-auto h-14 w-14 text-amber-400 drop-shadow-[0_0_16px_rgba(251,191,36,0.6)]" />
        ) : (
          <IconX className="mx-auto h-14 w-14 text-red-400" />
        )}
        <h1
          className={`mt-3 text-4xl font-black tracking-tight ${
            isWinner ? "text-amber-300" : "text-red-300"
          }`}
        >
          {isWinner ? "YOU WIN!" : "YOU LOSE"}
        </h1>
        <p className="mt-1 text-sm font-semibold text-white/70">{ordinal(placement)} place</p>

        {/* Game stats */}
        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <Stat label="Blocks placed" value={stats?.blocksPlaced ?? 0} />
          <Stat label="Blocks in tower" value={stats?.towerBlocks ?? 0} />
          <Stat label="Collapses" value={stats?.collapses ?? 0} />
        </div>

        {/* Money result */}
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/40 p-4">
          {isAi ? (
            <p className="text-sm font-semibold text-white/60">Free play — no tokens at stake</p>
          ) : (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-white/60">Wager</span>
                <span className="font-semibold text-yellow-300">{Number(wager || 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/60">Payout</span>
                <span className="font-semibold text-cyan-300">{Number(payout || 0).toLocaleString()}</span>
              </div>
              <div
                className={`flex justify-between border-t border-white/10 pt-1 text-base font-black ${
                  Number(net) >= 0 ? "text-emerald-300" : "text-red-300"
                }`}
              >
                <span>{Number(net) > 0 ? "Profit" : "Lost"}</span>
                <span>
                  {Number(net) > 0 ? "+" : ""}
                  {Number(net).toLocaleString()}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="flex-1 rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-bold text-white/80 transition hover:bg-white/10"
            >
              {dismissLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="flex-1 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-black text-black transition hover:brightness-110"
          >
            Back to Lobby
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 px-2 py-3">
      <p className="text-xl font-black text-white">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-white/50">{label}</p>
    </div>
  );
}