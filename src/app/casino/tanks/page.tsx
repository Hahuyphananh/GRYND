"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../../../context/SocketProvider";
import NavigationBar from "../../../components/navigation-bar";

export default function TanksLobby() {
  const { isSignedIn, user } = useUser();
  const [wager, setWager] = useState(10);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [availableGames, setAvailableGames] = useState<any[]>([]);
  const [joiningMatchId, setJoiningMatchId] = useState<string | null>(null);
  const [showModePopup, setShowModePopup] = useState(false);
  const { socket } = useSocket();
  const router = useRouter();
  const [showTanksRules, setShowTanksRules] = useState(false);

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
      const res = await fetch("/api/tanks/available-games", {
        cache: "no-store",
      });
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
    if (!socket) return;
    const roomId = "lobby:tanks";
    const handleLobbyUpdate = () => fetchAvailableGames();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  async function joinGame(matchId?: string) {
    try {
      setLoading(true);
      if (matchId) setJoiningMatchId(matchId);

      const res = await fetch("/api/tanks/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(matchId ? { matchId } : {}),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to join game");
        return;
      }

      // Redirect to game with the returned matchId
      socket?.emit("room_event", {
        roomId: "lobby:tanks",
        event: "lobby:updated",
      });
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

      const res = await fetch(
        gameMode === "battle_royale"
          ? "/api/tanks/start-battle-royale"
          : "/api/tanks/start-match",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ betAmount: wager, gameMode }),
        },
      );

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to start match");
        return;
      }

      // Deduct wager from local balance
      setBalance((prev) => prev - wager);

      // Redirect to game with matchId
      socket?.emit("room_event", {
        roomId: "lobby:tanks",
        event: "lobby:updated",
      });
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
    <div className="w-full min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] flex flex-col items-center justify-center text-white p-6 relative">
      <NavigationBar currentPath="/casino" />

      <motion.div
        className="p-8 bg-[#0b224f]/85 rounded-2xl shadow-[0_0_28px_rgba(0,229,255,0.2)] border border-[#00e5ff]/30 w-full max-w-md"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h1 className="text-3xl font-bold mb-4 text-center text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.55)]">
          TANKS — Battle Lobby
        </h1>

        <div className="mb-2 text-center text-[#a8f4ff] font-medium">
          {loading
            ? "Loading..."
            : `Your Balance: ${balance.toFixed(2)} tokens`}
        </div>

        {error && <div className="text-red-500 text-sm mb-2">{error}</div>}

        <div className="mb-4">
          <label className="text-sm text-[#a8f4ff]">Your Wager</label>
          <input
            type="number"
            value={wager}
            onChange={(e) => setWager(Number(e.target.value))}
            className="w-full p-3 mt-1 rounded bg-[#08142f] border border-[#00e5ff]/40 text-white shadow-[0_0_10px_rgba(0,229,255,0.15)]"
            min={1}
            max={balance}
          />
        </div>

        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={() => setShowModePopup(true)}
          disabled={loading || wager > balance}
          className="block text-center w-full p-3 bg-[#FFD700] hover:bg-[#ffe14f] text-[#030817] rounded-xl font-bold cursor-pointer shadow-[0_0_16px_rgba(255,215,0,0.45)] disabled:bg-[#7f8520] disabled:text-[#c6c6c6]"
        >
          {loading ? "Starting..." : "Start Game"}
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={() => joinGame()}
          disabled={loading}
          className="block text-center w-full p-3 mt-3 bg-[#00e5ff] hover:bg-[#49eeff] text-[#001933] rounded-xl font-bold cursor-pointer shadow-[0_0_16px_rgba(0,229,255,0.45)] disabled:bg-[#246874] disabled:text-[#c6c6c6]"
        >
          {loading ? "Joining..." : "Quick Join"}
        </motion.button>

        <div className="mt-4 bg-[#08142f]/90 border border-[#00e5ff]/30 rounded-xl p-3 shadow-[0_0_16px_rgba(0,229,255,0.12)]">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">Available Public Matches</h2>
            <button
              onClick={fetchAvailableGames}
              className="text-xs px-2 py-1 rounded bg-[#00e5ff] text-[#001933] font-semibold hover:bg-[#49eeff] shadow-[0_0_12px_rgba(0,229,255,0.35)]"
            >
              Refresh
            </button>
          </div>

          {availableGames.length === 0 ? (
            <p className="text-sm text-[#9ac1d3]">
              No public match is open right now.
            </p>
          ) : (
            <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
              {availableGames.map((game) => (
                <div
                  key={game.matchId}
                  className="flex items-center justify-between bg-[#0a1c40]/80 border border-[#00e5ff]/20 rounded-lg px-2 py-2"
                >
                  <div className="text-xs">
                    <p className="font-semibold">
                      {game.hostName || "Host"} · {game.matchId}
                    </p>
                    <p className="text-[#9ac1d3]">
                      {game?.settings?.mode === "battle_royale"
                        ? "Battle Royale"
                        : "1v1"}{" "}
                      · Bet: {Number(game.bounty || 0).toFixed(2)} ·{" "}
                      {game.currentPlayers}/{game.maxPlayers}
                    </p>
                  </div>
                  <button
                    onClick={() => joinGame(game.matchId)}
                    disabled={loading || joiningMatchId === game.matchId}
                    className="px-2 py-1 rounded bg-[#00e5ff] hover:bg-[#49eeff] disabled:bg-[#246874] text-[#001933] text-xs font-bold shadow-[0_0_10px_rgba(0,229,255,0.4)]"
                  >
                    {joiningMatchId === game.matchId ? "Joining..." : "Join"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Game Rules (Collapsible) */}
        <div className="mt-4 bg-[#08142f]/90 border border-[#00e5ff]/30 rounded-xl p-3 shadow-[0_0_16px_rgba(0,229,255,0.12)]">
          <button
            onClick={() => setShowTanksRules(!showTanksRules)}
            className="w-full flex justify-between items-center font-semibold text-[#FFD700]"
          >
            📜 Game Rules
            <span>{showTanksRules ? "▲" : "▼"}</span>
          </button>

          {showTanksRules && (
            <div className="mt-3 text-sm text-[#c4e8ff] space-y-3 leading-relaxed">
              <p>
                🚗 <strong>Objective:</strong> Destroy other players and survive
                the arena to win tokens.
              </p>

              <p>
                🎯 <strong>How to Play:</strong>
                <br />• Enter a wager (your entry stake) • Start or join a match
                • Control your tank and fight other players • Last player
                standing wins
              </p>

              <p>
                💥 <strong>Combat:</strong>
                <br />• Shooting or hitting enemies eliminates them • Eliminated
                players drop their bounty • You gain tokens from players you
                eliminate
              </p>

              <p>
                💰 <strong>Bounties:</strong>
                <br />• Each player contributes a wager to the pool • Winning
                players earn from the total pool • The longer you survive, the
                more you can earn
              </p>

              <p>
                🏆 <strong>Win Conditions:</strong>
                <br />• Be the last player alive • Or survive long enough (5s+
                depending on mode) to cash out
              </p>

              <p>
                ⚔️ <strong>Game Modes:</strong>
                <br />• 1v1 Duel → Fast-paced small map • Battle Royale → Up to
                10 players, last one standing wins
              </p>

              <p>
                ⚠️ <strong>Important:</strong>
                <br />• You must have enough tokens to start a match • Leaving a
                match may forfeit your wager • Skill + strategy + survival
                determine winnings
              </p>
            </div>
          )}
        </div>
      </motion.div>

      {showModePopup && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-20">
          <div className="bg-[#08142f] border border-[#00e5ff]/40 rounded-2xl p-5 w-full max-w-sm shadow-[0_0_18px_rgba(0,229,255,0.22)]">
            <h3 className="text-xl font-bold mb-3">Choose game mode</h3>
            <div className="space-y-2">
              <button
                onClick={() => startMatch("duel")}
                disabled={loading}
                className="w-full p-3 rounded-lg bg-[#FFD700] hover:bg-[#ffe14f] text-[#030817] font-bold disabled:bg-[#7f8520]"
              >
                1v1 (small map)
              </button>
              <button
                onClick={() => startMatch("battle_royale")}
                disabled={loading}
                className="w-full p-3 rounded-lg bg-[#00e5ff] hover:bg-[#49eeff] text-[#001933] font-bold disabled:bg-[#246874]"
              >
                Battle Royale (up to 10 players)
              </button>
              <button
                onClick={() => setShowModePopup(false)}
                disabled={loading}
                className="w-full p-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-semibold shadow-[0_0_12px_rgba(239,68,68,0.35)]"
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
