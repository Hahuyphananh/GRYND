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
  IconLock,
  IconTrophy,
} from "@tabler/icons-react";
import {
  playTurnSwitch,
  playCrash,
  playTick,
  playVictory,
  playDefeat,
} from "../../../../../lib/gameAudio";
import {
  applyPlacementBlock,
  centerDepthFor,
  footprintFor,
  fitsInGrid,
  GRID_WIDTH,
  GRID_DEPTH,
  BLOCK_SHAPES,
  type BlockShape,
} from "../../../../../lib/tower-arena/engine";

// ── Game meta ──────────────────────────────────────────────────────────

const SHAPE_LABEL: Record<BlockShape, string> = {
  I: "I",
  L: "L",
  T: "T",
  square: "▪",
  short: "▮",
};

const SHAPE_NAME: Record<BlockShape, string> = {
  I: "Long",
  L: "L",
  T: "T",
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
  name: string;
  iconKey: string;
};

// ── Countdown hook ─────────────────────────────────────────────────────

function useServerCountdown(deadline: string | null, tickMs = 100) {
  const [left, setLeft] = useState(8);
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

// ── Isometric tower renderer ───────────────────────────────────────────

const TILE_W = 40;
const TILE_H = 20;
const COL_H = 16;

function isoCell(x: number, depth: number, z: number): [number, number] {
  // Camera from the front-bottom; x increases right, depth increases left-down.
  const sx = (x - depth) * (TILE_W / 2);
  const sy = (depth + x) * (TILE_H / 2) - z * COL_H;
  return [sx, sy];
}

function isoDiamondPoints(x: number, depth: number, z: number, cellSize = 1): string {
  const [cx, cy] = isoCell(x, depth, z);
  const w = (TILE_W / 2) * cellSize;
  const h = (TILE_H / 2) * cellSize;
  return `${cx},${cy - h} ${cx + w},${cy} ${cx},${cy + h} ${cx - w},${cy}`;
}

function buildHeightMap(tower: any[]): number[][] {
  const h: number[][] = Array.from({ length: GRID_WIDTH }, () =>
    new Array<number>(GRID_DEPTH).fill(0),
  );
  for (const b of tower || []) {
    for (const c of b.cells || []) {
      h[c.x][c.depth] = Math.max(h[c.x][c.depth], c.z);
    }
  }
  return h;
}

// The towerView takes the tower + an optional ghost block and renders an
// isometric SVG. Each block is colored by a stable index based on its id hash.
function TowerView({ tower, ghost, collapsedBlocks }: { tower: any[]; ghost?: any; collapsedBlocks?: Set<string> }) {
  const rows: { key: string; points: string; fill: string; opacity: number; stroke: string }[] = [];

  // Floor
  for (let x = 0; x < GRID_WIDTH; x += 1) {
    for (let d = 0; d < GRID_DEPTH; d += 1) {
      rows.push({
        key: `f${x}-${d}`,
        points: isoDiamondPoints(x, d, 0),
        fill: "#071626",
        opacity: 1,
        stroke: "#0e2a44",
      });
    }
  }

  // Blocks (painter's order: far rows first, then higher up drawn last so the
  // silhouette reads top-first).
  const sortedBlocks = (tower || []).slice().sort((a, b) => {
    const aMax = Math.max(...a.cells.map((c: any) => c.x + c.depth));
    const bMax = Math.max(...b.cells.map((c: any) => c.x + c.depth));
    return aMax - bMax;
  });

  sortedBlocks.forEach((b, i) => {
    const color = BLOCK_PALETTE[i % BLOCK_PALETTE.length];
    const isCollapsed = collapsedBlocks?.has(b.id);
    const zOff = isCollapsed ? 24 : 0; // lift falling blocks during animation
    for (const c of b.cells || []) {
      rows.push({
        key: `${b.id}-${c.x}-${c.depth}-${c.z}`,
        points: isoDiamondPoints(c.x, c.depth, c.z + zOff),
        fill: color,
        opacity: isCollapsed ? 0.5 : 0.95,
        stroke: "rgba(255,255,255,0.5)",
      });
    }
  });

  // Ghost preview of the selected block
  if (ghost) {
    const ghostColor = "#ffffff";
    for (const c of ghost.cells || []) {
      rows.push({
        key: `g${c.x}-${c.depth}-${c.z}`,
        points: isoDiamondPoints(c.x, c.depth, c.z),
        fill: ghostColor,
        opacity: 0.22,
        stroke: "#ffffff",
      });
    }
  }

  // Compute bounds for centering.
  const allXs = rows.map((r) => r.points);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pts of allXs) {
    for (const pair of pts.split(" ")) {
      if (!pair) continue;
      const [px, py] = pair.split(",").map(Number);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }
  const pad = 30;
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;

  return (
    <svg
      viewBox={`${minX - pad} ${minY - pad} ${width} ${height}`}
      className="h-full w-full max-w-full select-none"
      preserveAspectRatio="xMidYMid meet"
    >
      {rows.map((r) => (
        <polygon key={r.key} points={r.points} fill={r.fill} opacity={r.opacity} stroke={r.stroke} strokeWidth={1} />
      ))}
    </svg>
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
  // Reserve UI
  const [reserveTargetId, setReserveTargetId] = useState<string | null>(null);
  const [reserving, setReserving] = useState(false);
  const [placing, setPlacing] = useState(false);
  // Events
  const [collapseBanner, setCollapseBanner] = useState<any>(null);
  const [showResults, setShowResults] = useState(false);
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string> | null>(null);
  const prevTowerLen = useRef<number | null>(null);
  const prevTurnUserId = useRef<string | null>(null);

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

      // Detect a fresh collapse (the tower thus shrinks below its previous
      // stable length) to trigger the elimination animation.
      const towerLen = Array.isArray(data.match?.towerState) ? data.match.towerState.length : 0;
      if (prevTowerLen.current !== null && prevTowerLen.current > towerLen && data.match?.status === "active") {
        // Which player just got eliminated? Find the newly-eliminated one.
        const elim = (data.players || []).find((p: any) => p.status === "eliminated");
        setCollapseBanner({ name: elim?.name || "A player", placement: elim?.placement });
        setCollapsedBlockIds(new Set(data.match.placements?.slice(-1)?.[0]?.removedBlockIds || []));
        playCrash();
        setTimeout(() => {
          setCollapseBanner(null);
          setCollapsedBlockIds(null);
        }, 2400);
      }
      prevTowerLen.current = towerLen;

      // Turn-switch chime when the turn holder changes on an active match.
      const turnId = data.match?.currentTurnPlayerId ?? null;
      const isMine = Boolean(turnId && me?.userId && turnId === me.userId);
      if (prevTurnUserId.current !== null && prevTurnUserId.current !== turnId && data.match?.status === "active") {
        playTurnSwitch(isMine);
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
    const refresh = () => load();

    const joinRooms = () => {
      socket.emit("join_room", { roomId: matchRoom });
      socket.emit("join_room", { roomId: lobbyRoom });
    };
    joinRooms();

    const EVENT_NAMES = [
      "tower_arena_state",
      "tower_arena_turn_started",
      "tower_arena_resource_update",
      "tower_arena_reserve_phase",
      "tower_arena_block_placed",
      "tower_arena_collapse",
      "tower_arena_player_eliminated",
      "tower_arena_resource_refill",
      "tower_arena_match_finished",
      "tower-arena:lobby:updated",
    ];
    EVENT_NAMES.forEach((name) => socket.on(name, refresh));

    // Fires on first connect AND every auto-reconnect; re-establishes room
    // membership (Socket.IO drops rooms server-side on disconnect) and pulls
    // the fresh authoritative snapshot immediately.
    socket.on("connect", joinRooms);
    socket.on("connect", refresh);

    return () => {
      EVENT_NAMES.forEach((name) => socket.off(name, refresh));
      socket.off("connect", joinRooms);
      socket.off("connect", refresh);
      socket.emit("leave_room", { roomId: lobbyRoom });
      socket.emit("leave_room", { roomId: matchRoom });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, matchId]);

  // Audio for finish
  useEffect(() => {
    if (match?.status === "finished") {
      const won = match.winnerId === me?.userId;
      if (won) playVictory();
      else playDefeat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.status]);

  const isFinished = match?.status === "finished";
  const activePlayers = players.filter((p) => p.status === "active");
  const isFinalDuel = isFinished ? false : activePlayers.length === 2;

  useEffect(() => {
    if (isFinished && !showResults) setShowResults(true);
  }, [isFinished, showResults]);

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

  // ── Derivation for the active board ──────────────────────────────
  const isActive = match?.status === "active";
  const phase = match?.phase; // "reserve" | "placement"
  const isMyTurn = isActive && phase === "placement" && match?.currentTurnPlayerId === me?.userId && me?.status !== "eliminated";

  const myHeldReserve = me?.reservedBlock || null; // { blockId, shape }

  const shapeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of match?.resourcePool || []) c[p.shape] = (c[p.shape] || 0) + 1;
    return c;
  }, [match?.resourcePool]);

  const ghostBlock = useMemo(() => {
    if (!isMyTurn || !selectedShape) return undefined;
    const extent = footprintFor(selectedShape, rotation);
    if (!fitsInGrid(extent, positionX, 0)) return undefined;
    try {
      return applyPlacementBlock(match.towerState || [], {
        shape: selectedShape,
        x: positionX,
        depth: centerDepthFor(selectedShape, rotation),
        rotation,
        blockId: "ghost",
        placedByUserId: me?.userId,
        turnNumber: match.turnNumber + 1,
      });
    } catch {
      return undefined;
    }
  }, [isMyTurn, selectedShape, rotation, positionX, match, me]);

  const countdown = useServerCountdown(match?.turnDeadline ?? null);
  const countdownUrgent = isActive && countdown <= 3.5;

  // ── Handlers ─────────────────────────────────────────────────────

  const clampX = (shape: BlockShape, rot: number, x: number) => {
    const extent = footprintFor(shape, rot);
    const maxX = GRID_WIDTH - Math.max(...extent.map(([a]) => a)) - 1;
    return Math.max(0, Math.min(x, maxX));
  };

  const selectShape = (shape: BlockShape) => {
    setSelectedShape(shape);
    setRotation(0);
    setPositionX(clampX(shape, 0, Math.floor(GRID_WIDTH / 2)));
  };

  const rotate = () => {
    if (!selectedShape) return;
    const nr = (rotation + 1) % 4;
    setRotation(nr);
    setPositionX(clampX(selectedShape, nr, positionX));
  };

  const nudgeX = (dir: number) => {
    if (!selectedShape) return;
    setPositionX(clampX(selectedShape, rotation, positionX + dir));
  };

  // Core submit — takes explicit shape/rotation/x so the reserved-block path
  // (which currently re-renders) never reads stale state. The server consumes
  // a held reservation whenever the placed shape matches the reserved shape.
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
      load();
    }
    setPlacing(false);
  };

  const drop = async () => {
    if (!isMyTurn || !selectedShape) return;
    await place(selectedShape, positionX, rotation);
  };

  const reserveBlock = async () => {
    if (reserving || !reserveTargetId) return;
    setReserving(true);
    try {
      const res = await fetch("/api/tower-arena/reserve-block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId, blockId: reserveTargetId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) setReserveTargetId(null);
      load();
    } finally {
      setReserving(false);
    }
  };

  const useReserve = async () => {
    if (!isMyTurn || !myHeldReserve || placing) return;
    // Visual preview, then submit with explicit args (independent of the
    // pending re-render so the hold is always placed).
    const rot = 0;
    const x = clampX(myHeldReserve.shape, 0, Math.floor(GRID_WIDTH / 2));
    setSelectedShape(myHeldReserve.shape);
    setRotation(rot);
    setPositionX(x);
    await place(myHeldReserve.shape, x, rot);
  };

  // Keyboard controls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMyTurn || !selectedShape) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); nudgeX(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); nudgeX(1); }
      else if (e.key.toLowerCase() === "r" || e.key.toLowerCase() === " ") { e.preventDefault(); rotate(); }
      else if (e.key === "Enter" || e.key === "ArrowUp") { e.preventDefault(); drop(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyTurn, selectedShape]);

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

  // ── Waiting room ─────────────────────────────────────────────────
  if (!isActive && !isFinished && match?.status === "waiting") {
    return (
      <div className="min-h-screen bg-[#050512] px-3 pb-24 pt-20 text-white sm:px-6">
        <NavigationBar currentPath="/casino" />
        <div className="mx-auto mt-6 max-w-lg sm:mt-10">
          <div className="mb-6 text-center">
            <IconBuildingSkyscraper className="mx-auto h-12 w-12 text-cyan-400" />
            <h1 className="mt-3 bg-gradient-to-r from-cyan-300 to-cyan-500 bg-clip-text text-3xl font-black text-transparent">
              Tower Arena
            </h1>
            <p className="mt-1 text-sm text-white/60">Shared Tower Survival</p>
          </div>
          <div className="rounded-2xl border border-cyan-800 bg-black/30 p-6">
            <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3">
              {seats.map((seat) => (
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
                        <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-emerald-300">READY</span>
                      </div>
                    </>
                  ) : (
                    <p className="animate-pulse py-4 text-sm font-semibold text-white/40">Waiting…</p>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-6 text-center">
              <span className="text-2xl font-black text-cyan-300">
                {players.filter((p) => p.status === "active").length} / {match?.maxPlayers}
              </span>
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
              {players.filter((p) => p.status === "active").length < (match?.maxPlayers ?? 0)
                ? "Waiting for more players to join before the match starts…"
                : "Everyone’s here — the match is starting…"}
            </p>
            <div className="mt-6 flex items-center justify-center gap-2">
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
    return <ResultsView match={match} players={players} meUserId={me?.userId} onBack={() => router.replace("/casino/tower-arena")} />;
  }

  // ── Live board ───────────────────────────────────────────────────
  const turnHolder = players.find((p) => p.userId === match?.currentTurnPlayerId);
  const currentTurnName = me?.userId === turnHolder?.userId ? "You" : (turnHolder?.name ?? "…");
  const isReservePhase = isActive && phase === "reserve";
  const canReserve =
    isReservePhase &&
    me?.status !== "eliminated" &&
    !myHeldReserve &&
    Number(me?.reserveUsesRemaining ?? 0) > 0;

  // ── Creator Mode arrangement (normal rendering unchanged) ───────────
  // The recording viewport wraps the LIVE board only — the waiting room
  // and the results screen render before/after real gameplay, so nothing
  // is recorded on them. Portrait (9:16) uses the phone-style stacked
  // arrangement (compact header, tower centre stage, controls + players
  // pinned below); landscape (16:9) / square (1:1) reuse the standard
  // desktop grid inside the frame.

  // Tower stage: isometric tower + collapse banner (no turn controls).
  const towerInnerNode = (
    <div
      className="relative flex min-h-[340px] items-center justify-center overflow-hidden rounded-xl"
      style={{
        background:
          "radial-gradient(circle at 50% 60%, rgba(0,229,255,0.10), transparent 60%), repeating-linear-gradient(45deg, rgba(0,229,255,0.02) 0 2px, transparent 2px 18px)",
      }}
    >
      {/* StaticTower */}
      <div className="w-full max-h-[420px]">
        <TowerView tower={match?.towerState || []} ghost={ghostBlock} collapsedBlocks={collapsedBlockIds} />
      </div>
      {/* Collapse banner */}
      <AnimatePresence>
        {collapseBanner && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="rounded-2xl border-2 border-red-500/60 bg-red-950/80 px-8 py-6 text-center shadow-[0_0_40px_rgba(239,68,68,0.5)]">
              <p className="text-2xl font-black text-red-300">{collapseBanner.name.toUpperCase()}</p>
              <p className="mt-1 text-sm font-bold text-white">ELIMINATED</p>
              <p className="mt-1 text-xs text-red-200">
                {ordinal(collapseBanner.placement)} place
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  // Turn controls: reserve panel, placement controls, or the
  // "opponent placing" commentary (exactly as in the normal layout).
  const turnControlsNode = (
    <>
      {/* Reserve phase banner/controls */}
      {isReservePhase && (
        <ReservePanel
          pools={match?.resourcePool || []}
          canReserve={canReserve}
          myHeldReserve={myHeldReserve}
          reserveUsesRemaining={Number(me?.reserveUsesRemaining ?? 0)}
          targetId={reserveTargetId}
          setTargetId={setReserveTargetId}
          onReserve={reserveBlock}
          busy={reserving}
          countdown={countdown}
        />
      )}

      {/* Placement controls */}
      {isMyTurn && !isReservePhase && (
        <PlacementControls
          selectedShape={selectedShape}
          shapeCounts={shapeCounts}
          rotation={rotation}
          positionX={positionX}
          myHeldReserve={myHeldReserve}
          onSelect={selectShape}
          onRotate={rotate}
          onNudge={nudgeX}
          onDrop={drop}
          onUseReserve={useReserve}
          placing={placing}
        />
      )}
      {isActive && !isMyTurn && !isReservePhase && (
        <p className="mt-4 text-center text-sm text-white/60">
          {currentTurnName} is placing… {!turnHolder?.isAi && turnHolder?.userId !== me?.userId ? "(you may tap blocks to prep your next move)" : ""}
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
          <p className="text-sm font-bold text-cyan-200">{isReservePhase ? "Reserve Phase" : currentTurnName}</p>
        </div>
        <Timer countdown={countdown} urgent={countdownUrgent} isActive={Boolean(isActive)} />
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-widest text-white/50">Players</p>
          <p className="text-sm font-bold text-white">
            {activePlayers.length} / {match?.maxPlayers}
          </p>
        </div>
      </div>
    </div>
  );

  // Right: leaderboard + reserve visibility + resign.
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
                        ? "Placing…"
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

      {/* Reserve visibility */}
      <div className="mt-4 rounded-xl border border-cyan-700/30 bg-black/30 p-3 text-xs">
        <p className="mb-1 flex items-center gap-1.5 font-semibold text-cyan-200">
          <IconLock size={13} /> Reserves
        </p>
        <p className="text-white/50">
          {myHeldReserve ? (
            <>
              <span className="font-bold text-white">
                You hold {SHAPE_NAME[myHeldReserve.shape]}
              </span>{" "}
              (private).
            </>
          ) : (
            `${players.filter((p) => p.status === "active").length} active players · you have ${Number(me?.reserveUsesRemaining ?? 0)} use${
              Number(me?.reserveUsesRemaining ?? 0) === 1 ? "" : "s"
            } left`
          )}
        </p>
      </div>

      <button
        onClick={leave}
        disabled={leaving}
        className="mt-4 w-full rounded-lg border border-red-500/40 bg-red-500/15 px-4 py-2 text-xs font-bold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
      >
        {leaving ? "Leaving…" : "Resign"}
      </button>
    </div>
  );

  // Normal / landscape / square game body (unchanged from before).
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
            <Timer countdown={countdown} urgent={countdownUrgent} isActive={Boolean(isActive)} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] font-semibold">
          <span className="truncate text-cyan-200">
            {isReservePhase ? "Reserve Phase" : `${currentTurnName} placing…`}
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
    </div>
  );
}

// ── Timer ──────────────────────────────────────────────────────────────

function Timer({ countdown, urgent, isActive }: { countdown: number; urgent: boolean; isActive: boolean }) {
  const seconds = Math.max(0, Math.ceil(countdown));
  const tenths = Math.max(0, Math.floor((countdown - seconds + 1) * 10));
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
        {urgent ? `${seconds}.${tenths}` : `${Math.max(0, Math.ceil(countdown))}:00`}
      </span>
    </div>
  );
}

// ── Reserve panel ──────────────────────────────────────────────────────

function ReservePanel(props: any) {
  const {
    pools,
    canReserve,
    myHeldReserve,
    reserveUsesRemaining,
    targetId,
    setTargetId,
    onReserve,
    busy,
    countdown,
  } = props;
  // Aggregate by shape with count + represent a distinct reservable piece.
  const pieces = pools as { id: string; shape: BlockShape }[];
  return (
    <div className="mt-4 rounded-xl border border-cyan-700/40 bg-black/30 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-sm font-black text-cyan-200">Reserve a block</p>
          <p className="text-xs text-white/50">
            Your reserved block becomes private — visible only to you.
          </p>
        </div>
        <div className="rounded-lg bg-black/50 px-2 py-1 font-mono text-sm font-bold text-cyan-300">
          {Math.max(0, Math.ceil(countdown))}s
        </div>
      </div>

      {myHeldReserve ? (
        <p className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3 py-2 text-sm font-bold text-emerald-200">
          You hold {SHAPE_NAME[myHeldReserve.shape]} in your reserve.
        </p>
      ) : !canReserve ? (
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/50">
          {Number(reserveUsesRemaining) <= 0
            ? "No reserve uses remaining this match."
            : "The reserve window is open but you cannot reserve right now."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {pieces.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setTargetId(targetId === p.id ? null : p.id)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-bold transition ${
                  targetId === p.id
                    ? "border-cyan-400 bg-cyan-500/20 text-cyan-100"
                    : "border-white/15 bg-white/[0.03] text-white/80 hover:border-cyan-500/40"
                }`}
              >
                {SHAPE_LABEL[p.shape]} ×{/* each piece reservable */}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onReserve}
            disabled={!targetId || busy}
            className="mt-3 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Reserving…" : "Reserve selected"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Placement controls ─────────────────────────────────────────────────

function PlacementControls(props: any) {
  const {
    selectedShape,
    shapeCounts,
    rotation,
    positionX,
    myHeldReserve,
    onSelect,
    onRotate,
    onNudge,
    onDrop,
    onUseReserve,
    placing,
  } = props;

  const available = (BLOCK_SHAPES).filter((s) => (shapeCounts[s] || 0) > 0);

  return (
    <div className="mt-4 rounded-xl border border-cyan-700/40 bg-black/30 p-4">
      {/* Reserves */}
      {myHeldReserve && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-950/20 px-3 py-2">
          <span className="text-[10px] font-black uppercase tracking-wider text-emerald-300">Your Reserve</span>
          <button
            type="button"
            onClick={onUseReserve}
            disabled={placing}
            className="rounded border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-sm font-bold text-emerald-200 hover:bg-emerald-500/25"
          >
            Use {SHAPE_LABEL[myHeldReserve.shape]}
          </button>
        </div>
      )}

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
            <span className="text-white/40">×{shapeCounts[s]}</span>
          </button>
        ))}
      </div>

      {selectedShape ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-white">
            {SHAPE_NAME[selectedShape]} · x{positionX} · rot {rotation * 90}°
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onNudge(-1)} className="controlBtn" aria-label="Move left">
              <IconArrowsLeftRight className="h-4 w-4 scale-x-[-1]" />
            </button>
            <button type="button" onClick={() => onNudge(1)} className="controlBtn" aria-label="Move right">
              <IconArrowsLeftRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={onRotate} className="controlBtn" aria-label="Rotate">
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
        <p className="mt-3 text-sm text-white/50">Select a block above, then position it on the tower and drop.</p>
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
              const isWinner = r.placement === 1;
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