"use client";

import { useEffect, useState } from "react";
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

  useGamePresence({
    gameKey: "dots-and-boxes",
    gameId: Number(gameId),
    enabled: Boolean(gameId),
  });

  const fetchState = async () => {
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
      setStatusText("Match in progress");
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
    }
  };

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, gameId]);

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
          {/* Game Board Area */}
          <div className="casino-surface p-4 sm:p-6 rounded-2xl flex flex-col items-center justify-center border-[#f59e0b]/20">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2, duration: 0.5 }}
              className="w-full flex justify-center"
            >
              <DotsAndBoxesBoard
                interactive={false}
              />
            </motion.div>
            <p className="mt-4 text-center text-xs text-white/40">
              Gameplay is coming soon — the board is ready!
            </p>
          </div>

          {/* Sidebar */}
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

            {game?.status === "waiting" && game?.role === "host" ? (
              <button
                onClick={async () => {
                  if (!confirm("Cancel this game? Your wager will be refunded.")) return;
                  const res = await fetch("/api/dots-and-boxes/cancel", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ gameId: Number(gameId) }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    socket?.emit("room_event", {
                      roomId: "lobby:dots-and-boxes",
                      event: "lobby:updated",
                    });
                    router.push("/casino/dots-and-boxes");
                  } else {
                    alert(data.error || "Failed to cancel game");
                  }
                }}
                className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-500 font-bold hover-lift"
              >
                Cancel Game (Refund)
              </button>
            ) : (
              <button
                onClick={() => router.push("/casino/dots-and-boxes")}
                className="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-500 font-bold hover-lift"
              >
                Return to Lobby
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
