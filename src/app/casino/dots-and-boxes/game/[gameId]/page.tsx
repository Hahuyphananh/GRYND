"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useSocket } from "../../../../../context/SocketProvider";
import useGamePresence from "../../../../../hooks/useGamePresence";
import DotsAndBoxesBoard from "../../../../../components/DotsAndBoxesBoard";

// ─── Module-level empty defaults (shared reference across renders) ─
// Mutable types so passing into the board component (typed
// `Set<string>` / `string[]`) doesn't trigger a covariant mismatch.
const EMPTY_EDGES: string[] = [];
const EMPTY_BOX_OWNERS: Record<string, "host" | "guest"> = {};
const EMPTY_SCORES = { host: 0, guest: 0 };

// ─── Active poll interval — slower when finished so we let the user
//      read the result without burning CPU/DB on stale polls. ────────
const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;

export default function DotsAndBoxesGamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const router = useRouter();
  const { socket } = useSocket();

  const [game, setGame] = useState<any>(null);
  const [statusText, setStatusText] = useState("Loading game...");
  const [drawing, setDrawing] = useState(false);
  const drawingRef = useRef(false);
  // Visual-only countdown. Source of truth is the server's moveDeadlineAt.
  const [now, setNow] = useState<number>(() => Date.now());

  // AbortController ref so each new poll/request cancels the previous
  // in-flight fetch. Prevents stale responses from clobbering newer
  // state when the network is slow.
  const abortRef = useRef<AbortController | null>(null);

  useGamePresence({
    gameKey: "dots-and-boxes",
    gameId: Number(gameId),
    enabled: Boolean(gameId),
  });

  // ─── fetchState: cancellable, ref-equality guarded ────────────────
  const fetchState = useCallback(
    async (opts?: { signal?: AbortSignal }) => {
      try {
        const res = await fetch(
          `/api/dots-and-boxes/game-state?gameId=${gameId}`,
          { cache: "no-store", signal: opts?.signal },
        );
        // Server returned "no-change" sentinel — nothing to render.
        if (res.status === 304) return;
        const data = await res.json();
        if (opts?.signal?.aborted) return;
        if (!res.ok) {
          setStatusText(data.error || "Unable to load game");
          return;
        }
        const gameData = data.data;

        // ── Ref-equality guard ────────────────────────────────
        // Skip the setGame call entirely if every gameplay field is
        // byte-identical to the current state. This prevents React
        // from re-running derived useMemos each poll when nothing
        // actually changed (e.g., during opponent's deliberation
        // the server returns the same deadline + score + edges).
        setGame((prev) => (gameStateUnchanged(prev, gameData) ? prev : gameData));

        setStatusText(computeStatusText(gameData));
      } catch (err) {
        if (err?.name === "AbortError") return;
        console.error("dots-and-boxes fetch failed", err);
      }
    },
    [gameId],
  );

  // ─── Polling with adaptive interval + abort ───────────────────────
  // - 1.5s while in_progress, 5s once finished/cancelled (so we still
  //   pick up any late payout writes but don't burn CPU).
  // - Cancel stale fetches when a new one fires.
  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (cancelled) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      void fetchState({ signal: ac.signal });
      const delay =
        game?.status === "finished" || game?.status === "cancelled"
          ? IDLE_POLL_MS
          : ACTIVE_POLL_MS;
      intervalId = setTimeout(tick, delay);
    };

    // Initial fetch, then schedule.
    tick();

    return () => {
      cancelled = true;
      if (intervalId) clearTimeout(intervalId);
      abortRef.current?.abort();
    };
    // game?.status is included so the interval adapts when the match ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchState, game?.status]);

  // ─── Visual countdown — server is source of truth, this just renders
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  // ─── Socket sync ───────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const roomId = `dots-and-boxes:${gameId}`;
    const refresh = () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      void fetchState({ signal: ac.signal });
    };
    socket.emit("join_room", { roomId });
    socket.on("match:updated", refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("match:updated", refresh);
    };
  }, [socket, gameId, fetchState]);

  // ─── Derived board props ────────────────────────────────────────────
  // Memoize against the raw game state so an unchanged set won't
  // recompute, and so the Set/Array references are stable across
  // renders (which the memoed board relies on for skip-render).
  const gameState = game?.gameState ?? null;
  const edgesKey = useMemo(() => {
    if (!gameState || !Array.isArray(gameState.edges)) return "";
    // Hash content order doesn't matter; canonicalize so equal sets
    // produce equal signatures regardless of insertion order.
    return [...(gameState.edges as string[])].sort().join("|");
  }, [gameState?.edges]);

  const {
    drawnH,
    drawnV,
    isMyTurn,
    currentTurn,
    scores,
    isFinished,
    remainingMs,
    remainingSeconds,
    timerSeconds,
    boardLocked,
    boxesForBoard,
    boxOwnersForBoard,
  } = useMemo(() => {
    const gs = game?.gameState;
    if (!gs || !Array.isArray(gs.edges)) {
      return {
        drawnH: new Set<string>(),
        drawnV: new Set<string>(),
        isMyTurn: false,
        currentTurn: null as "host" | "guest" | null,
        scores: EMPTY_SCORES,
        isFinished: false,
        remainingMs: 0,
        remainingSeconds: 0,
        timerSeconds: 10,
        boardLocked: true,
        boxesForBoard: EMPTY_EDGES,
        boxOwnersForBoard: EMPTY_BOX_OWNERS,
      };
    }

    const hSet = new Set<string>();
    const vSet = new Set<string>();
    for (const e of gs.edges as string[]) {
      const idx = e.indexOf(":");
      if (idx < 0) continue;
      const type = e.slice(0, idx);
      const coords = e.slice(idx + 1);
      if (type === "h") hSet.add(coords);
      else if (type === "v") vSet.add(coords);
    }

    const finished =
      game.status === "finished" || game.status === "cancelled";
    const myTurn =
      !finished &&
      game.status === "in_progress" &&
      game.role === gs.currentTurn;

    const deadline = game.moveDeadlineAt
      ? new Date(game.moveDeadlineAt).getTime()
      : 0;
    const ms = deadline ? Math.max(0, deadline - now) : 0;
    const seconds = Math.ceil(ms / 1000);

    return {
      drawnH: hSet,
      drawnV: vSet,
      isMyTurn: myTurn,
      currentTurn: gs.currentTurn as "host" | "guest" | null,
      scores: gs.scores || EMPTY_SCORES,
      isFinished: finished,
      remainingMs: ms,
      remainingSeconds: seconds,
      timerSeconds: game.timerSeconds || 10,
      boardLocked: finished,
      boxesForBoard: (gs.boxes as string[]) ?? EMPTY_EDGES,
      boxOwnersForBoard:
        (gs.boxOwners as Record<string, "host" | "guest">) ??
        EMPTY_BOX_OWNERS,
    };
    // The only deps we need: the canonical edges key, status, role,
    // currentTurn, deadline, and now. Splitting this way means a
    // field like `payout` (which we never read here) won't recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    edgesKey,
    game?.status,
    game?.role,
    game?.moveDeadlineAt,
    gameState?.currentTurn,
    gameState?.scores,
    gameState?.boxes,
    gameState?.boxOwners,
    now,
  ]);

  // ─── Edge drawing ───────────────────────────────────────────────────

  const drawEdge = useCallback(
    async (type: "h" | "v", row: number, col: number) => {
      if (drawingRef.current) return;
      drawingRef.current = true;
      setDrawing(true);

      try {
        const res = await fetch("/api/dots-and-boxes/draw-edge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: Number(gameId), type, row, col }),
        });
        const data = await res.json();

        if (!data.success) {
          // Refresh state to resync on error (e.g. stale turn)
          abortRef.current?.abort();
          const ac = new AbortController();
          abortRef.current = ac;
          await fetchState({ signal: ac.signal });
          return;
        }

        socket?.emit("room_event", {
          roomId: `dots-and-boxes:${gameId}`,
          event: "match:updated",
          payload: { gameId: Number(gameId) },
        });
        setNow(Date.now());
      } finally {
        drawingRef.current = false;
        setDrawing(false);
      }
    },
    [socket, gameId, fetchState],
  );

  // ─── Cancel/forfeit handler ─────────────────────────────────────────

  const cancelGame = useCallback(async () => {
    if (
      !confirm(
        "Cancel or forfeit this game? Tokens will be refunded or opponent credited.",
      )
    )
      return;
    const res = await fetch("/api/dots-and-boxes/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: Number(gameId) }),
    });
    const data = await res.json();
    if (data.success) {
      socket?.emit("room_event", {
        roomId: `dots-and-boxes:${gameId}`,
        event: "match:updated",
        payload: { gameId: Number(gameId) },
      });
      socket?.emit("room_event", {
        roomId: "lobby:dots-and-boxes",
        event: "lobby:updated",
      });
      // Re-sync state via a fresh fetch
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      await fetchState({ signal: ac.signal });
    } else {
      alert(data.error || "Failed to cancel game");
    }
  }, [socket, gameId, fetchState]);

  // ─── Render helpers ─────────────────────────────────────────────────

  const timerUrgent = remainingSeconds > 0 && remainingSeconds <= 3;
  const timerExpired =
    game?.status === "in_progress" && remainingMs <= 0;

  const timerPct =
    timerSeconds > 0
      ? Math.max(0, Math.min(100, (remainingMs / (timerSeconds * 1000)) * 100))
      : 0;

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
    >
      <div className="max-w-5xl mx-auto relative overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-orange-400 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]">
              Dots &amp; Boxes — Match #{gameId}
            </h1>
          </div>
          <button
            onClick={() => router.push("/casino/dots-and-boxes")}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 hover-lift"
          >
            Back to Lobby
          </button>
        </div>

        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          {/* ─── Game Board Area ────────────────────────────────────── */}
          <div className="casino-surface p-4 sm:p-6 rounded-2xl flex flex-col items-center justify-center border-[#f59e0b]/20">
            {/* Turn & timer */}
            {game?.status === "in_progress" && (
              <div className="mb-3 w-full max-w-[560px] flex flex-col items-center gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-3 w-3 rounded-full ${
                      isMyTurn ? "bg-green-400 animate-pulse" : "bg-white/30"
                    }`}
                  />
                  <span
                    className={`text-sm font-semibold ${
                      isMyTurn ? "text-green-300" : "text-white/60"
                    }`}
                  >
                    {isMyTurn
                      ? "Your turn — draw an edge!"
                      : timerExpired
                        ? "Time expired — drawing for opponent…"
                        : "Opponent is thinking…"}
                  </span>
                  {drawing && (
                    <span className="text-xs text-amber-400 animate-pulse ml-1">
                      Drawing…
                    </span>
                  )}
                </div>

                {/* Timer bar */}
                <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ease-linear ${
                      timerUrgent
                        ? "bg-red-400"
                        : isMyTurn
                          ? "bg-amber-400"
                          : "bg-white/40"
                    }`}
                    style={{
                      width: `${timerPct}%`,
                      transform: "translateZ(0)", // GPU layer
                    }}
                  />
                </div>
                <span
                  className={`text-xs font-mono ${
                    timerUrgent
                      ? "text-red-300"
                      : timerExpired
                        ? "text-red-400/80"
                        : "text-white/50"
                  }`}
                >
                  {remainingSeconds}s remaining
                </span>
              </div>
            )}

            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2, duration: 0.5 }}
              className="w-full flex justify-center"
            >
              <DotsAndBoxesBoard
                drawnH={drawnH}
                drawnV={drawnV}
                boxes={boxesForBoard}
                boxOwners={boxOwnersForBoard}
                player1Color="#f59e0b"
                player2Color="#f97316"
                interactive={isMyTurn && !drawing && !boardLocked}
                onEdgeHClick={drawEdge.bind(null, "h")}
                onEdgeVClick={drawEdge.bind(null, "v")}
              />
            </motion.div>
          </div>

          {/* ─── Sidebar ───────────────────────────────────────────── */}
          <div className="casino-surface p-4 rounded-2xl border-[#f59e0b]/20">
            <h2 className="text-base font-bold text-amber-300 mb-3 flex items-center gap-2 uppercase tracking-wider">
              <span aria-hidden>📐</span>
              <span>Match Details</span>
            </h2>

            <div className="mb-3 flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/50">
                Status
              </span>
              <span className="text-sm font-semibold text-white">
                {statusText}
              </span>
            </div>

            <div className="mb-3 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/50">
                Role
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  game?.role === "host"
                    ? "bg-amber-500/15 text-amber-300 border border-amber-400/30"
                    : game?.role === "guest"
                      ? "bg-orange-500/15 text-orange-300 border border-orange-400/30"
                      : "bg-white/5 text-white/60 border border-white/10"
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    game?.role === "host"
                      ? "bg-amber-400"
                      : game?.role === "guest"
                        ? "bg-orange-400"
                        : "bg-white/40"
                  }`}
                />
                {game?.role === "host"
                  ? "Host"
                  : game?.role === "guest"
                    ? "Guest"
                    : "—"}
              </span>
            </div>

            {/* Scores */}
            {game?.status !== "waiting" && (
              <div className="mb-4 p-3 rounded-xl bg-white/5 border border-white/10">
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-2 text-center">
                  Score
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div
                    className={`flex flex-col items-center flex-1 rounded-lg px-3 py-2 transition-transform ${
                      currentTurn === "host"
                        ? "bg-amber-500/15 border border-amber-400/40 scale-[1.02]"
                        : "bg-transparent"
                    }`}
                  >
                    <span className="text-xs text-amber-300 font-medium">
                      {game?.hostName || "Host"}
                    </span>
                    <span className="text-3xl font-extrabold text-amber-400 tabular-nums">
                      {scores.host}
                    </span>
                  </div>
                  <span className="text-white/30 text-sm font-bold">vs</span>
                  <div
                    className={`flex flex-col items-center flex-1 rounded-lg px-3 py-2 transition-transform ${
                      currentTurn === "guest"
                        ? "bg-orange-500/15 border border-orange-400/40 scale-[1.02]"
                        : "bg-transparent"
                    }`}
                  >
                    <span className="text-xs text-orange-300 font-medium">
                      {game?.guestName || "Guest"}
                    </span>
                    <span className="text-3xl font-extrabold text-orange-400 tabular-nums">
                      {scores.guest}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="mb-2 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">Host</span>
              <span className="font-semibold text-white">
                {game?.hostName || "—"}
              </span>
            </div>
            <div className="mb-2 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">Guest</span>
              <span className="font-semibold text-white">
                {game?.guestName || "Waiting..."}
              </span>
            </div>
            <div className="mb-4 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/50">Bet</span>
              <span className="font-mono font-semibold text-yellow-300">
                {Number(game?.betAmount || 0).toFixed(2)} tokens each
              </span>
            </div>

            {game?.remainingEdges !== undefined && !isFinished && (
              <div className="mb-4 flex items-center justify-between gap-2 text-xs">
                <span className="text-white/50">Edges Left</span>
                <span className="font-mono font-semibold text-white">
                  {game.remainingEdges} / 84
                </span>
              </div>
            )}

            {/* End-game summary */}
            {isFinished && (
              <div className="mb-4 p-3 rounded-xl bg-white/5 border border-white/10">
                <div className="text-[10px] uppercase tracking-wider text-white/50 mb-1 text-center">
                  Result
                </div>
                <div className="text-center text-sm font-semibold text-white">
                  {statusText}
                </div>
                {game?.payout !== null &&
                  game?.payout !== undefined &&
                  Number(game.payout) > 0 && (
                    <div className="text-center text-xs text-yellow-300 mt-1">
                      Payout: {Number(game.payout).toFixed(2)} tokens
                    </div>
                  )}
              </div>
            )}

            {/* Forfeit / Cancel */}
            {game?.status === "waiting" && game?.role === "host" ? (
              <button
                onClick={cancelGame}
                className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold hover-lift mb-2"
              >
                Cancel Game (Refund)
              </button>
            ) : game?.status === "in_progress" &&
              game?.role &&
              game.role !== "spectator" ? (
              <button
                onClick={cancelGame}
                className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold hover-lift mb-2"
              >
                Forfeit Match
              </button>
            ) : null}

            <button
              onClick={() => router.push("/casino/dots-and-boxes")}
              className={`w-full py-2 rounded-lg font-bold hover-lift ${
                isFinished
                  ? "bg-amber-600 hover:bg-amber-500"
                  : "bg-white/10 hover:bg-white/20"
              }`}
            >
              {isFinished ? "Return to Lobby" : "Back to Lobby"}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Helpers (module-level) ────────────────────────────────────────────

/** Cheap deep-ish equality check for the gameplay fields we render
 *  from. Skips parent.setGame when polled state hasn't changed. */
function gameStateUnchanged(prev: any, next: any): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.status !== next.status) return false;

  const a = prev.gameState || {};
  const b = next.gameState || {};

  if ((a.edges?.length ?? 0) !== (b.edges?.length ?? 0)) return false;
  if ((a.boxes?.length ?? 0) !== (b.boxes?.length ?? 0)) return false;
  if (a.currentTurn !== b.currentTurn) return false;
  if (a.scores?.host !== b.scores?.host) return false;
  if (a.scores?.guest !== b.scores?.guest) return false;
  if (prev.moveDeadlineAt !== next.moveDeadlineAt) return false;
  if (prev.result !== next.result) return false;
  if (prev.winnerClerkId !== next.winnerClerkId) return false;
  if (prev.payout !== next.payout) return false;

  // Edge-level content equality (cheap when lengths already match).
  const ae = a.edges as string[] | undefined;
  const be = b.edges as string[] | undefined;
  if (ae && be) {
    const aeSorted = ae.slice().sort();
    const beSorted = be.slice().sort();
    for (let i = 0; i < aeSorted.length; i++) {
      if (aeSorted[i] !== beSorted[i]) return false;
    }
  }

  // Box owners
  const aBo = (a.boxOwners as Record<string, string> | undefined) || {};
  const bBo = (b.boxOwners as Record<string, string> | undefined) || {};
  const aKeys = Object.keys(aBo);
  const bKeys = Object.keys(bBo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (aBo[k] !== bBo[k]) return false;
  }

  return true;
}

function computeStatusText(gameData: any): string {
  if (gameData.status === "waiting") {
    return "Waiting for opponent to join...";
  }
  if (gameData.status === "cancelled") {
    return "Match cancelled.";
  }
  if (gameData.status === "in_progress") {
    const gs = gameData.gameState;
    if (gameData.role === gs?.currentTurn) {
      return "Your turn — draw an edge!";
    }
    if (gameData.remainingSeconds === 0) {
      return "Opponent's turn expired — auto-playing...";
    }
    return "Opponent's turn...";
  }
  if (gameData.status === "finished") {
    if (gameData.result === "draw") return "Draw game.";
    const won =
      gameData.winnerClerkId &&
      ((gameData.role === "host" &&
        gameData.winnerClerkId === gameData.hostClerkId) ||
        (gameData.role === "guest" &&
          gameData.winnerClerkId === gameData.guestClerkId));
    return won ? "You won!" : "You lost.";
  }
  return "";
}
