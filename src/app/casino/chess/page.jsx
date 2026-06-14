"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { useEffect, useState } from "react";
import { useSocket } from "../../../context/SocketProvider";
import { CHIP_VALUES } from "../../../lib/rouletteConfig";

const TABLES = [1, 5, 10, 20, 50, 100];
const TIMER_OPTIONS = [
  { id: "1min", label: "1 Min", time: 60 },
  { id: "2min", label: "2 Min", time: 120 },
  { id: "3min", label: "3 Min", time: 180 },
  { id: "5min", label: "5 Min", time: 300 },
  { id: "10min", label: "10 Min", time: 600 },
  { id: "30min", label: "30 Min", time: 1800 },
];

export default function ChessLobby() {
  const router = useRouter();
  const { socket } = useSocket();

  const [showBetPopup, setShowBetPopup] = useState(false);
  const [betAmount, setBetAmount] = useState("");
  const [availableGames, setAvailableGames] = useState([]);
  const [isLoadingAvailableGames, setIsLoadingAvailableGames] = useState(false);
  const [joiningGameId, setJoiningGameId] = useState(null);
  const [creatingGame, setCreatingGame] = useState(false);
  const [selectedTable, setSelectedTable] = useState(null);
  const [selectedTimer, setSelectedTimer] = useState("");
  const [error, setError] = useState(null);
  const [aiGameLoading, setAiGameLoading] = useState(false);

  useEffect(() => {
    fetchAvailableGames();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:chess";
    const handleLobbyUpdate = () => fetchAvailableGames();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  async function fetchAvailableGames() {
    setIsLoadingAvailableGames(true);
    try {
      const res = await fetch("/api/chess/available-games", {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) {
        setAvailableGames(data.data.games || []);
      }
    } catch (error) {
      console.error("Failed to load available chess games", error);
    }
    setIsLoadingAvailableGames(false);
  }

  const selectedTimerObj = TIMER_OPTIONS.find((t) => t.id === selectedTimer);

  async function createGame() {
    if (!selectedTable || !selectedTimer || creatingGame) return;

    setCreatingGame(true);
    try {
      const res = await fetch("/api/chess/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableAmount: selectedTable,
          timerMode: selectedTimer,
          timeLimit: selectedTimerObj?.time, // 👈 IMPORTANT FIX
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Unable to create game");
        return;
      }

      const timerObj = TIMER_OPTIONS.find(
        (t) => t.id === (data.timerMode || selectedTimer),
      );
      const timerParam = timerObj?.time;
      if (data.ready || data.status === "in_progress") {
        socket?.emit("room_event", {
          roomId: "lobby:chess",
          event: "lobby:updated",
        });
        router.push(
          `/casino/chess-game/${data.gameId}?color=${data.color}&timer=${timerParam}`,
        );
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:chess",
        event: "lobby:updated",
      });
      router.push(
        `/casino/chess/${selectedTable}?gameId=${data.gameId}&color=${data.color}&timer=${timerParam}`,
      );
    } catch (error) {
      console.error("Failed to create chess game", error);
      setError("Unable to create game");
    } finally {
      setCreatingGame(false);
    }
  }

  async function joinSpecificGame(gameId) {
    setJoiningGameId(gameId);
    try {
      const targetGame = availableGames.find((game) => game.id === gameId);
      const res = await fetch("/api/chess/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Unable to join game");
        fetchAvailableGames();
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:chess",
        event: "lobby:updated",
      });
      const joinTimer = TIMER_OPTIONS.find(
        (t) => t.id === targetGame?.timerMode,
      );

      router.push(
        `/casino/chess-game/${gameId}?color=black&timer=${joinTimer?.time || 300}`,
      );
    } catch (error) {
      console.error("Failed to join chess game", error);
      setError("Unable to join game");
    } finally {
      setJoiningGameId(null);
    }
  }

  async function startAIGame() {
    setAiGameLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/chess/create-ai-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ai_game: true,
          betAmount: Number(betAmount),
        }),
      });

      if (!res.ok) throw new Error("Failed to create AI game");

      const data = await res.json();
      router.push(`/casino/chess/ai?gameId=${data.gameId}&bet=${betAmount}`);
    } catch (error) {
      console.error("Error creating AI game:", error);
      setError("Failed to create AI game");
    } finally {
      setAiGameLoading(false);
    }
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-center text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <h1 className="mb-4 mt-4 text-3xl font-bold text-[#FFD700] drop-shadow-[0_0_12px_rgba(255,215,0,0.55)] sm:text-4xl">
        ♟️ Chess Tables
      </h1>

      <div className="max-w-4xl mx-auto bg-[#0b224f]/85 p-6 rounded-xl border border-[#00e5ff]/30 mb-8 shadow-[0_0_24px_rgba(0,229,255,0.18)]">
        <h2 className="text-2xl font-bold text-[#FFD700] mb-4">
          Create Multiplayer Game
        </h2>
        <p className="text-white/80 mb-5">
          Select exactly 1 table and 1 timer, then create your game.
        </p>

        <div className="mb-6">
          <h3 className="text-lg font-semibold text-left mb-3">
            1) Choose Table
          </h3>
          <div className="flex flex-wrap justify-center gap-4">
            {TABLES.map((amount) => (
              <button
                key={amount}
                onClick={() => setSelectedTable(amount)}
                className={`px-6 py-4 rounded-lg text-xl font-semibold border-2 ${
                  selectedTable === amount
                    ? "bg-[#FFD700] text-[#030817] border-[#FFD700] shadow-[0_0_14px_rgba(255,215,0,0.45)]"
                    : "bg-[#08142f] text-[#a8f4ff] border-[#00e5ff]/40 hover:bg-[#0d335f]"
                }`}
              >
                ${amount} Table
              </button>
            ))}
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-lg font-semibold text-left mb-3">
            2) Choose Timer
          </h3>
          <div className="flex flex-wrap justify-center gap-4">
            {TIMER_OPTIONS.map((timer) => (
              <button
                key={timer.id}
                onClick={() => setSelectedTimer(timer.id)}
                className={`px-6 py-4 rounded-lg text-xl font-semibold border-2 min-w-[190px] ${
                  selectedTimer === timer.id
                    ? "bg-[#FFD700] text-[#030817] border-[#FFD700] shadow-[0_0_14px_rgba(255,215,0,0.45)]"
                    : "bg-[#08142f] text-[#a8f4ff] border-[#00e5ff]/40 hover:bg-[#0d335f]"
                }`}
              >
                <div>{timer.label}</div>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-900/30 border border-red-400/40 text-red-300 p-2 rounded text-sm text-center">
            {error}
          </div>
        )}

        <button
          onClick={createGame}
          disabled={!selectedTable || !selectedTimer || creatingGame}
          className="bg-[#FFD700] text-[#030817] px-8 py-3 rounded-lg text-lg font-bold hover:bg-[#ffe14f] shadow-[0_0_16px_rgba(255,215,0,0.45)] disabled:bg-[#7f8520] disabled:text-[#c6c6c6] disabled:cursor-not-allowed"
        >
          {creatingGame ? "Creating..." : "Create Game"}
        </button>
      </div>

      <div className="max-w-3xl mx-auto mt-10 bg-[#0b224f]/85 p-5 rounded-xl border border-[#00e5ff]/30 text-left shadow-[0_0_24px_rgba(0,229,255,0.18)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-[#FFD700]">Available Games</h2>
          <button
            onClick={fetchAvailableGames}
            className="bg-[#00e5ff] text-[#001933] px-4 py-2 rounded-lg font-semibold hover:bg-[#49eeff] shadow-[0_0_10px_rgba(0,229,255,0.35)]"
          >
            {isLoadingAvailableGames ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {availableGames.length === 0 ? (
          <p className="text-white/80">
            No open games right now. Create one from the options above.
          </p>
        ) : (
          <div className="space-y-3">
            {availableGames.map((game) => (
              <div
                key={game.id}
                className="flex items-center justify-between bg-[#08142f] border border-[#00e5ff]/20 rounded-lg p-3"
              >
                <div>
                  <p className="font-semibold">Game #{game.id}</p>
                  <p className="text-sm text-white/80">
                    Host: {game.hostName || "Player"} · Bet: $
                    {Number(game.betAmount)} · Timer:{" "}
                    {TIMER_OPTIONS.find((t) => t.id === game.timerMode)
                      ?.label || "Unknown"}
                  </p>
                </div>
                <button
                  onClick={() => joinSpecificGame(game.id)}
                  disabled={joiningGameId === game.id}
                  className="bg-[#00e5ff] text-[#001933] px-4 py-2 rounded-lg font-bold hover:bg-[#49eeff] disabled:bg-[#246874]"
                >
                  {joiningGameId === game.id ? "Joining..." : "Join"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showBetPopup && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50">
          <div className="bg-[#08142f] text-white p-8 rounded-lg w-96 border border-[#00e5ff]/40 shadow-[0_0_22px_rgba(0,229,255,0.25)]">
            <h2 className="text-2xl font-bold mb-4 text-center text-[#FFD700]">
              Enter Your Bet Amount
            </h2>

            {/* Quick chips */}
            <div className="flex flex-wrap gap-1.5 justify-center mb-3">
              {CHIP_VALUES.map((val) => (
                <button
                  key={val}
                  onClick={() => setBetAmount(val.toString())}
                  className={`px-2 py-0.5 rounded-full text-xs font-bold border transition-all ${
                    Number(betAmount) === val
                      ? "bg-[#FFFF33] text-black border-[#FFFF33]"
                      : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30"
                  }`}
                >
                  {val}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 mb-2">
              <input
                type="number"
                min="0"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                onBlur={() => { if (!betAmount || Number(betAmount) < 1) setBetAmount(""); }}
                className="flex-1 border border-[#00e5ff]/40 bg-[#0d335f] px-3 py-2 rounded"
                placeholder="Bet amount"
              />
              <button
                onClick={() => setBetAmount("50")}
                className="px-2 py-2 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25"
              >
                ½
              </button>
              <button
                onClick={() => setBetAmount("100")}
                className="px-2 py-2 rounded text-xs font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25"
              >
                100
              </button>
            </div>

            {error && (
              <div className="mb-2 text-red-400 text-xs text-center">{error}</div>
            )}

            <div className="flex justify-between">
              <button
                onClick={() => setShowBetPopup(false)}
                className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.35)]"
              >
                Cancel
              </button>

              <button
                onClick={startAIGame}
                disabled={!betAmount || Number(betAmount) < 1 || aiGameLoading}
                className="bg-[#FFD700] text-[#030817] px-4 py-2 rounded hover:bg-[#ffe14f] disabled:bg-[#7f8520] disabled:text-[#c6c6c6]"
              >
                {aiGameLoading ? "Creating..." : "Start Game"}
              </button>
            </div>
          </div>
        </div>
      )}
      <Footer />
    </div>
  );
}
