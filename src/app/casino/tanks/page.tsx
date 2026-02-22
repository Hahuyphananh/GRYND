"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

export default function TanksLobby() {
  const { isSignedIn, user } = useUser();
  const [wager, setWager] = useState(10);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const fetchUserTokens = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await response.json();
      if (data.success) {
        setBalance(Number(data.data.balance)); // ✅ use data.data.balance
      } else {
        throw new Error(data.error || "Unknown error");
      }
    } catch (err) {
      console.error("Error fetching tokens:", err);
      setError("Impossible de récupérer votre solde de tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSignedIn && user) fetchUserTokens();
  }, [isSignedIn, user]);

async function joinGame() {
  try {
    setLoading(true);

    const res = await fetch("/api/tanks/join-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Failed to join game");
      return;
    }

    // Redirect to game with the returned matchId
    router.push(`/casino/tanks/game/${data.matchId}`);
  } catch (err) {
    console.error("Join match error:", err);
    alert("Server error while joining match");
  } finally {
    setLoading(false);
  }
}

  async function startMatch() {
    if (wager > balance) {
      alert("You do not have enough tokens for this wager.");
      return;
    }

    try {
      setLoading(true);

      const res = await fetch("/api/tanks/start-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount: wager }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to start match");
        return;
      }

      // Deduct wager from local balance
      setBalance(prev => prev - wager);

      // Redirect to game with matchId
      router.push(`/casino/tanks/game/${data.matchId}`);
    } catch (err) {
      console.error("Start match error:", err);
      alert("Server error while starting match");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full h-screen bg-gradient-to-br from-gray-900 to-black flex flex-col items-center justify-center text-white p-6 relative">
      <Link
        href="/casino"
        className="absolute top-4 left-4 px-4 py-2 bg-gray-700/80 hover:bg-gray-600 rounded-xl font-bold text-sm"
      >
        Return to Casino
      </Link>

      <motion.div
        className="p-8 bg-gray-800/50 rounded-2xl shadow-2xl w-full max-w-md"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h1 className="text-3xl font-bold mb-4 text-center">
          TANKS — Battle Lobby
        </h1>

        <div className="mb-2 text-center text-gray-300 font-medium">
          {loading ? "Loading..." : `Your Balance: ${balance.toFixed(2)} tokens`}
        </div>

        {error && <div className="text-red-500 text-sm mb-2">{error}</div>}

        <div className="mb-4">
          <label className="text-sm text-gray-300">Your Wager</label>
          <input
            type="number"
            value={wager}
            onChange={(e) => setWager(Number(e.target.value))}
            className="w-full p-3 mt-1 rounded bg-black/30 border border-gray-700"
            min={1}
            max={balance}
          />
        </div>

        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={startMatch}
          disabled={loading || wager > balance}
          className="block text-center w-full p-3 bg-green-600 hover:bg-green-700 rounded-xl font-bold cursor-pointer disabled:bg-green-900"
        >
          {loading ? "Starting..." : "Start Game"}
        </motion.button>
        <motion.button
  whileTap={{ scale: 0.96 }}
  onClick={joinGame}
  disabled={loading}
  className="block text-center w-full p-3 mt-3 bg-blue-600 hover:bg-blue-700 rounded-xl font-bold cursor-pointer disabled:bg-blue-900"
>
  {loading ? "Joining..." : "Join Game"}
</motion.button>


        <div className="mt-6 text-center text-gray-400 text-sm">
          Kill players → steal their bounty.<br />Survive 5s to cash out.
        </div>
      </motion.div>
    </div>
  );
}
