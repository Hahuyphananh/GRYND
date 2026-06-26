"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useSocket } from "../../../../../context/SocketProvider";
import useGamePresence from "../../../../../hooks/useGamePresence";
import DotsAndBoxesBoard from "../../../../../components/DotsAndBoxesBoard";

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

  useGamePresence({
    gameKey: "dots-and-boxes",
    gameId: Number(gameId),
    enabled: Boolean(gameId),
  });

  const fetchState = useCallback(async () => {
    const res = await fetch(
      `/api/dots-and-boxes/game-state?gameId=${gameId}`,
      { cache: "no-store" },
    );
    const data = await res.json();
    if (!res.ok) {
      setStatusText(data.error || "Unable to load game");
      return;
    }

    const gameData = data.data;
    setGame(gameData);

    if (gameData.status === "waiting") {
      setStatusText("Waiting for opponent to join...");
    } else if (gameData.status === "in_progress") {
      const gs = gameData.gameState;
      if (gameData.role === gs?.currentTurn) {
        setStatusText("Your turn — draw an edge!");
      } else if (gameData.remainingSeconds === 0) {
        setStatusText(
          `Opponent's turn expired — auto-playing...`,
        );
      } else {
        setStatusText("Opponent's turn...");
      }
    } else if (gameData.status === "finished") {
      if (gameData.result === "draw") setStatusText("Draw game.");
      else if (
        gameData.winnerClerkId &&
        ((gameData.role === "host" &&
          gameData.winnerClerkId === gameData.hostClerkId) ||
          (gameData.role === "guest" &&
            gameData.winnerClerkId === gameData.guestClerkId))
      ) {
        setStatusText("You won!");
      } else {
        setStatusText("You lost.");
      }
    } else if (gameData.status === "cancelled") {
      setStatusText("Match cancelled.");
    }
  }, [gameId]);

  // Poll every 1.5s
  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 1500);
    return () => clearInterval(interval);
  }, [fetchState]);

  // Visual countdown — server is source of truth, this just renders the clock
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  // Socket sync
  useEffect(() => {
    if (!socket) return;
    const roomId = `dots-and-boxes:${gameId}`;
    const refresh = () => fetchState();
    socket.emit("join_room", { roomId });
    socket.on("match:updated", refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("match:updated", refresh);
    };
  }, [socket, gameId, fetchState]);

  // ─── Derived board props ────────────────────────────────────────────

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
  } = useMemo(() => {
    const gs = game?.gameState;
    if (!gs || !Array.isArray(gs.edges)) {
      return {
        drawnH: new Set<string>(),
        drawnV: new Set<string>(),
        isMyTurn: false,
        currentTurn: null as "host" | "guest" | null,
        scores: { host: 0, guest: 0 },
        isFinished: false,
        remainingMs: 0,
        remainingSeconds: 0,
        timerSeconds: 10,
        boardLocked: true,
      };
    }

    const hSet = new Set<string>();
    const vSet = new Set<string>();
    for (const e of gs.edges) {
      const parts = e.split(":");
      if (parts[0] === "h") hSet.add(parts[1]);
      else if (parts[0] === "v") vSet.add(parts[1]);
    }

    const finished = game.status === "finished" || game.status === "cancelled";
    const myTurn = !finished && game.status === "in_progress" && game.role === gs.currentTurn;

    const deadline = game.moveDeadlineAt ? new Date(game.moveDeadlineAt).getTime() : 0;
    const ms = deadline ? Math.max(0, deadline - now) : 0;
    const seconds = Math.ceil(ms / 1000);

    return {
      drawnH: hSet,
      drawnV: vSet,
      isMyTurn: myTurn,
      currentTurn: gs.currentTurn as "host" | "guest" | null,
      scores: gs.scores || { host: 0, guest: 0 },
      isFinished: finished,
      remainingMs: ms,
      remainingSeconds: seconds,
      timerSeconds: game.timerSeconds || 10,
      boardLocked: finished,
    };
  }, [game, now]);

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
          await fetchState();
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
    if (!confirm("Cancel or forfeit this game? Tokens will be refunded or opponent credited.")) return;
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
      await fetchState();
    } else {
      alert(data.error || "Failed to cancel game");
    }
  }, [socket, gameId, fetchState]);

  // ─── Render helpers ─────────────────────────────────────────────────

  const timerUrgent = remainingSeconds > 0 && remainingSeconds <= 3;
  const timerExpired = game?.status === "in_progress" && remainingMs <= 0;

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
                    style={{ width: `${timerPct}%` }}
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
                boxes={Array.isArray(game?.gameState?.boxes) ? game.gameState.boxes : []}
                boxOwners={game?.gameState?.boxOwners || {}}
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
                    className={`flex flex-col items-center flex-1 rounded-lg px-3 py-2 transition-all ${
                      currentTurn === "host"
                        ? "bg-amber-500/15 border border-amber-400/40"
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
                    className={`flex flex-col items-center flex-1 rounded-lg px-3 py-2 transition-all ${
                      currentTurn === "guest"
                        ? "bg-orange-500/15 border border-orange-400/40"
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
                {game?.payout !== null && game?.payout !== undefined && Number(game.payout) > 0 && (
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
            ) : game?.status === "in_progress" && game?.role && game.role !== "spectator" ? (
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
