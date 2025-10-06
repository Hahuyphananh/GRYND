"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function MatchmakingPage() {
  const { tableAmount } = useParams();
  const router = useRouter();
  const [waiting, setWaiting] = useState(true);
  const [gameId, setGameId] = useState(null);
  const [color, setColor] = useState(null);

  useEffect(() => {
    const joinQueue = async () => {
      const res = await fetch("/api/chess/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableAmount: Number(tableAmount) }),
      });

      const data = await res.json();

      if (data.error) {
        console.error(data.error);
        return;
      }

      setGameId(data.gameId);
      setColor(data.color);

      if (data.ready) {
        // Opponent found → redirect immediately
        router.push(`/casino/chess-game/${data.gameId}?color=${data.color}`);
      } else {
        // Still waiting → poll every 3s
        setTimeout(joinQueue, 3000);
      }
    };

    joinQueue();
  }, [tableAmount, router]);

  return (
    <div className="min-h-screen bg-[#003366] text-white flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-[#FFD700] mb-4">
          Waiting for opponent...
        </h2>
        <p>Stake: ${tableAmount}</p>
      </div>
    </div>
  );
}
