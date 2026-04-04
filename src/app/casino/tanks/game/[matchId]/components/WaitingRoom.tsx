"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../../../../../../context/SocketProvider";

type WaitingRoomProps = {
  gameId: string;
  onReady: () => void;
  minPlayersToStart: number;
  maxPlayers: number;
  gameMode: "duel" | "battle_royale";
};

export default function WaitingRoom({ gameId, onReady, minPlayersToStart, maxPlayers, gameMode }: WaitingRoomProps) {
  const [playerCount, setPlayerCount] = useState(1);
  const [status, setStatus] = useState("Waiting for players...");
  const [isReady, setIsReady] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const [countdownLeft, setCountdownLeft] = useState<number | null>(null);

  const router = useRouter();
  const { user } = useUser();
  const { socket } = useSocket();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const checkPlayers = async () => {
      try {
        if (!gameId) return;

        const res = await fetch(`/api/tanks/get-match?matchId=${gameId}`);
        const data = await res.json();

        if (!res.ok) {
          setStatus(data?.error || "Match unavailable");
          return;
        }

        const count = Number(data.currentPlayers ?? 1);
        setPlayerCount(count);

        if (data?.gameStarted) {
          setStatus("Match found! Starting game...");
          onReady();
          if (intervalRef.current) clearInterval(intervalRef.current);
          return;
        }

        if (gameMode === "battle_royale") {
          const players = Array.isArray(data.players) ? data.players : [];
          const readyPlayers = Array.isArray(data?.settings?.readyPlayers) ? data.settings.readyPlayers : [];
          const computedReadyCount = players.filter((id: string) => readyPlayers.includes(id)).length;
          const meReady = user?.id ? readyPlayers.includes(user.id) : false;
          setReadyCount(computedReadyCount);
          setIsReady(Boolean(meReady));

          const countdownEndsAt = Number(data?.settings?.countdownEndsAt ?? 0);
          if (countdownEndsAt > 0) {
            const left = Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
            setCountdownLeft(left);
            setStatus(left <= 3 ? "All players ready! Fast start..." : "Players are getting ready...");
          } else {
            setCountdownLeft(null);
            if (computedReadyCount >= minPlayersToStart) {
              setStatus("At least 2 players are ready. Start countdown pending...");
            } else {
              setStatus("Waiting for players to click ready...");
            }
          }
        } else if (count >= minPlayersToStart) {
          setStatus("Match found! Starting game...");
          onReady();
          if (intervalRef.current) clearInterval(intervalRef.current);
        }
      } catch (err) {
        console.error("Error checking players:", err);
      }
    };

    checkPlayers();
    intervalRef.current = setInterval(checkPlayers, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [gameId, minPlayersToStart, onReady, gameMode, user?.id]);

  const handleToggleReady = async () => {
    try {
      const nextReady = !isReady;
      const res = await fetch("/api/tanks/toggle-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: gameId, ready: nextReady }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || "Unable to update ready status");
        return;
      }
      setIsReady(nextReady);
      setReadyCount(Number(data.readyCount ?? 0));
      socket?.emit("room_event", { roomId: `match:tanks:${gameId}`, event: "match:updated" });
    } catch (err) {
      console.error("Failed toggling ready:", err);
    }
  };

  const handleCancel = async () => {
    try {
      await fetch("/api/tanks/leave-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
    } catch (err) {
      console.error("Failed to leave match:", err);
    }

    if (intervalRef.current) clearInterval(intervalRef.current);
    socket?.emit("room_event", { roomId: `match:tanks:${gameId}`, event: "match:updated" });
    router.push("/casino/tanks");
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-black text-white">
      <div className="relative mb-6">
        <div className="w-20 h-20 border-4 border-gray-700 border-t-green-500 rounded-full animate-spin" />
      </div>

      <h1 className="text-3xl font-bold mb-2">{isReady ? "🚀 Get Ready!" : "Matchmaking"}</h1>
      <p className="text-gray-400 mb-2">{status}</p>

      {countdownLeft !== null && (
        <p className="text-yellow-300 text-lg font-bold mb-2">Game starts in {countdownLeft}s</p>
      )}

      <div className="bg-gray-900 px-6 py-3 rounded-2xl border border-gray-700 mb-3">
        Players joined:
        <span className="text-green-400 font-bold ml-2">{playerCount}/{maxPlayers}</span>
      </div>

      {gameMode === "battle_royale" && (
        <div className="bg-gray-900 px-6 py-3 rounded-2xl border border-gray-700 mb-6">
          Ready players:
          <span className="text-purple-300 font-bold ml-2">{readyCount}/{playerCount}</span>
        </div>
      )}

      {!isReady && gameMode === "battle_royale" && (
        <button onClick={handleToggleReady} className="px-6 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 font-bold transition mb-3">
          Ready Up
        </button>
      )}

      {isReady && gameMode === "battle_royale" && (
        <button onClick={handleToggleReady} className="px-6 py-2 rounded-xl bg-gray-700 hover:bg-gray-600 font-bold transition mb-3">
          Unready
        </button>
      )}

      <button onClick={handleCancel} className="px-6 py-2 rounded-xl bg-red-600 hover:bg-red-700 font-bold transition">
        Cancel
      </button>
    </div>
  );
}
