"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function MatchmakingPage() {
  const { tableAmount } = useParams();
  const router = useRouter();
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    const joinQueue = async () => {
      const res = await fetch("/api/chess/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableAmount: Number(tableAmount) }),
      });

      const data = await res.json();

      if (data.gameId) {
        router.push(`/casino/chess-game/${data.gameId}?color=${data.color}`);
      } else {
        setTimeout(joinQueue, 3000);
      }
    };

    joinQueue();
  }, []);

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
