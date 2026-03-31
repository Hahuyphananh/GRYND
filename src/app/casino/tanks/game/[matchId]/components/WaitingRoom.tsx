"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";

type WaitingRoomProps = {
  gameId: string;
  onReady: () => void;
  minPlayersToStart: number;
  maxPlayers: number;
};

export default function WaitingRoom({ gameId, onReady, minPlayersToStart, maxPlayers }: WaitingRoomProps) {
  const [playerCount, setPlayerCount] = useState(1);
  const [status, setStatus] = useState("Waiting for players...");
  const [isReady, setIsReady] = useState(false);

  const router = useRouter();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const checkPlayers = async () => {
      try {
        if (!gameId) return;

        const res = await fetch(`/api/tanks/get-match?matchId=${gameId}`);
        const data = await res.json();

        const count = Number(data.currentPlayers ?? 1);
        setPlayerCount(count);

        if (count >= minPlayersToStart) {
          setStatus("Match found! Starting game...");
          setIsReady(true);
          onReady();

          if (intervalRef.current) {
            clearInterval(intervalRef.current);
          }
        }
      } catch (err) {
        console.error("Error checking players:", err);
      }
    };

    checkPlayers();
    intervalRef.current = setInterval(checkPlayers, 2000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [gameId, minPlayersToStart, onReady]);

  /* ✅ CANCEL MATCHMAKING */
  const handleCancel = async () => {
    try {
      // 🔥 HIGHLY recommended:
      // Tell your backend the player left
      await fetch("/api/tanks/leave-match", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ gameId }),
      });
    } catch (err) {
      console.error("Failed to leave match:", err);
    }

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    router.push("/casino/tanks");
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-black text-white">

      {/* Spinner */}
      <div className="relative mb-6">
        <div className="w-20 h-20 border-4 border-gray-700 border-t-green-500 rounded-full animate-spin" />
      </div>

      {/* Status */}
      <h1 className="text-3xl font-bold mb-2">
        {isReady ? "🚀 Get Ready!" : "Matchmaking"}
      </h1>

      <p className="text-gray-400 mb-4">{status}</p>

      {/* Player counter */}
      <div className="bg-gray-900 px-6 py-3 rounded-2xl border border-gray-700 mb-6">
        Players joined:
        <span className="text-green-400 font-bold ml-2">
          {playerCount}/{maxPlayers}
        </span>
      </div>

      {/* ✅ Cancel Button */}
      {!isReady && (
        <button
          onClick={handleCancel}
          className="px-6 py-2 rounded-xl bg-red-600 hover:bg-red-700 font-bold transition"
        >
          Cancel
        </button>
      )}

    </div>
  );
}
