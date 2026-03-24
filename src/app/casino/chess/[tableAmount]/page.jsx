"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function MatchmakingPage() {
  const { tableAmount } = useParams();
  const router = useRouter();
  const [statusText, setStatusText] = useState("Creating game...");
  const [gameId, setGameId] = useState(null);
  const [color, setColor] = useState("white");

  useEffect(() => {
    let pollId;

    const createOrJoin = async () => {
      try {
        const res = await fetch("/api/chess/create-game", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tableAmount: Number(tableAmount) }),
        });

        const data = await res.json();
        if (!res.ok) {
          setStatusText(data.error || "Unable to create game");
          return;
        }

        setGameId(data.gameId);
        setColor(data.color || "white");

        if (data.ready || data.status === "in_progress") {
          router.push(`/casino/chess-game/${data.gameId}?color=${data.color}`);
          return;
        }

        setStatusText("Waiting for opponent...");
        pollId = setInterval(async () => {
          const pollRes = await fetch(`/api/chess/game-state?gameId=${data.gameId}`, { cache: "no-store" });
          const pollData = await pollRes.json();
          if (!pollRes.ok) return;

          if (pollData.data.status === "in_progress" && pollData.data.blackPlayerId) {
            clearInterval(pollId);
            router.push(`/casino/chess-game/${data.gameId}?color=${data.color}`);
          }
        }, 2000);
      } catch (error) {
        console.error("Failed to create or join chess game", error);
        setStatusText("Unable to create game");
      }
    };

    createOrJoin();

    return () => {
      if (pollId) clearInterval(pollId);
    };
  }, [tableAmount, router]);

  return (
    <div className="min-h-screen bg-[#003366] text-white flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-[#FFD700] mb-4">{statusText}</h2>
        <p className="mb-2">Stake: ${tableAmount}</p>
        {gameId && <p className="text-sm opacity-80">Game #{gameId} · You are {color}</p>}
      </div>
    </div>
  );
}
