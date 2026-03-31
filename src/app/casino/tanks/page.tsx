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
  const [availableGames, setAvailableGames] = useState<any[]>([]);
  const [joiningMatchId, setJoiningMatchId] = useState<string | null>(null);
  const [showModePopup, setShowModePopup] = useState(false);
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


  const fetchAvailableGames = async () => {
    try {
      const res = await fetch("/api/tanks/available-games", { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        setAvailableGames(data.games || []);
      }
    } catch (err) {
      console.error("Error fetching tanks matches:", err);
    }
  };

  useEffect(() => {
    if (isSignedIn && user) fetchUserTokens();
    fetchAvailableGames();
  }, [isSignedIn, user]);

  useEffect(() => {
    const interval = setInterval(fetchAvailableGames, 4000);
    return () => clearInterval(interval);
  }, []);

async function joinGame(matchId?: string) {
  try {
    setLoading(true);
    if (matchId) setJoiningMatchId(matchId);

    const res = await fetch("/api/tanks/join-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(matchId ? { matchId } : {}),
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
    setJoiningMatchId(null);
  }
}

  async function startMatch(gameMode: "duel" | "battle_royale") {
    if (wager > balance) {
      alert("You do not have enough tokens for this wager.");
      return;
    }

    try {
      setLoading(true);

      const res = await fetch(gameMode === "battle_royale" ? "/api/tanks/start-battle-royale" : "/api/tanks/start-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount: wager, gameMode }),
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
      setShowModePopup(false);
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
          onClick={() => setShowModePopup(true)}
          disabled={loading || wager > balance}
          className="block text-center w-full p-3 bg-green-600 hover:bg-green-700 rounded-xl font-bold cursor-pointer disabled:bg-green-900"
        >
          {loading ? "Starting..." : "Start Game"}
        </motion.button>
        <motion.button
  whileTap={{ scale: 0.96 }}
  onClick={() => joinGame()}
  disabled={loading}
  className="block text-center w-full p-3 mt-3 bg-blue-600 hover:bg-blue-700 rounded-xl font-bold cursor-pointer disabled:bg-blue-900"
>
  {loading ? "Joining..." : "Quick Join"}
</motion.button>

        <div className="mt-4 bg-black/30 border border-gray-700 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">Available Public Matches</h2>
            <button
              onClick={fetchAvailableGames}
              className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600"
            >
              Refresh
            </button>
          </div>

          {availableGames.length === 0 ? (
            <p className="text-sm text-gray-400">No public match is open right now.</p>
          ) : (
            <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
              {availableGames.map((game) => (
                <div key={game.matchId} className="flex items-center justify-between bg-gray-900/70 rounded-lg px-2 py-2">
                  <div className="text-xs">
                    <p className="font-semibold">{game.hostName || "Host"} · {game.matchId}</p>
                    <p className="text-gray-400">
                      {game?.settings?.mode === "battle_royale" ? "Battle Royale" : "1v1"} · Bet: {Number(game.bounty || 0).toFixed(2)} · {game.currentPlayers}/{game.maxPlayers}
                    </p>
                  </div>
                  <button
                    onClick={() => joinGame(game.matchId)}
                    disabled={loading || joiningMatchId === game.matchId}
                    className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 text-xs font-bold"
                  >
                    {joiningMatchId === game.matchId ? "Joining..." : "Join"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 text-center text-gray-400 text-sm">
          Kill players → steal their bounty.<br />Survive 5s to cash out.
        </div>
      </motion.div>

      {showModePopup && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-20">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 w-full max-w-sm">
            <h3 className="text-xl font-bold mb-3">Choose game mode</h3>
            <div className="space-y-2">
              <button
                onClick={() => startMatch("duel")}
                disabled={loading}
                className="w-full p-3 rounded-lg bg-green-600 hover:bg-green-700 font-bold disabled:bg-green-900"
              >
                1v1 (small map)
              </button>
              <button
                onClick={() => startMatch("battle_royale")}
                disabled={loading}
                className="w-full p-3 rounded-lg bg-purple-600 hover:bg-purple-700 font-bold disabled:bg-purple-900"
              >
                Battle Royale (up to 10 players)
              </button>
              <button
                onClick={() => setShowModePopup(false)}
                disabled={loading}
                className="w-full p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
