"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import { useEffect, useState } from "react";
import { useSocket } from "../../../context/SocketProvider";

const TABLES = [1, 5, 10, 20, 50, 100];
const TIMER_OPTIONS = [
  { id: "bullet", label: "Bullet", range: "1-2 min" },
  { id: "blitz", label: "Blitz", range: "3-5 min" },
  { id: "normal", label: "Normal", range: "10-30 min" },
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
      const res = await fetch("/api/chess/available-games", { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        setAvailableGames(data.data.games || []);
      }
    } catch (error) {
      console.error("Failed to load available chess games", error);
    }
    setIsLoadingAvailableGames(false);
  }

  async function createGame() {
    if (!selectedTable || !selectedTimer || creatingGame) return;

    setCreatingGame(true);
    try {
      const res = await fetch("/api/chess/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableAmount: selectedTable, timerMode: selectedTimer }),
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Unable to create game");
        return;
      }

      const timerParam = data.timerMode || selectedTimer;
      if (data.ready || data.status === "in_progress") {
        socket?.emit("room_event", { roomId: "lobby:chess", event: "lobby:updated" });
        router.push(`/casino/chess-game/${data.gameId}?color=${data.color}&timer=${timerParam}`);
        return;
      }

      socket?.emit("room_event", { roomId: "lobby:chess", event: "lobby:updated" });
      router.push(`/casino/chess/${selectedTable}?gameId=${data.gameId}&color=${data.color}&timer=${timerParam}`);
    } catch (error) {
      console.error("Failed to create chess game", error);
      alert("Unable to create game");
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
        alert(data.error || "Unable to join game");
        fetchAvailableGames();
        return;
      }

      socket?.emit("room_event", { roomId: "lobby:chess", event: "lobby:updated" });
      router.push(`/casino/chess-game/${gameId}?color=black&timer=${targetGame?.timerMode || "blitz"}`);
    } catch (error) {
      console.error("Failed to join chess game", error);
      alert("Unable to join game");
    } finally {
      setJoiningGameId(null);
    }
  }

  async function startAIGame() {
    try {
      const res = await fetch("/api/chess/create-ai-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    }
  }

  return (
    <div className="min-h-screen bg-[#030817] text-white p-6 text-center">
      <NavigationBar currentPath="/casino" />
      <h1 className="text-4xl font-bold text-[#FFD700] mb-8 mt-12">♟️ Chess Tables</h1>

      <div className="max-w-4xl mx-auto bg-[#002147] p-6 rounded-xl border border-[#FFD700]/40 mb-8">
        <h2 className="text-2xl font-bold text-[#FFD700] mb-4">Create Multiplayer Game</h2>
        <p className="text-white/80 mb-5">Select exactly 1 table and 1 timer, then create your game.</p>

        <div className="mb-6">
          <h3 className="text-lg font-semibold text-left mb-3">1) Choose Table</h3>
          <div className="flex flex-wrap justify-center gap-4">
            {TABLES.map((amount) => (
              <button
                key={amount}
                onClick={() => setSelectedTable(amount)}
                className={`px-6 py-4 rounded-lg text-xl font-semibold border-2 ${
                  selectedTable === amount
                    ? "bg-[#FFD700] text-[#030817] border-[#FFD700]"
                    : "bg-[#030817] text-[#FFD700] border-[#FFD700]/40 hover:bg-[#081a3d]"
                }`}
              >
                ${amount} Table
              </button>
            ))}
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-lg font-semibold text-left mb-3">2) Choose Timer</h3>
          <div className="flex flex-wrap justify-center gap-4">
            {TIMER_OPTIONS.map((timer) => (
              <button
                key={timer.id}
                onClick={() => setSelectedTimer(timer.id)}
                className={`px-6 py-4 rounded-lg text-xl font-semibold border-2 min-w-[190px] ${
                  selectedTimer === timer.id
                    ? "bg-[#FFD700] text-[#030817] border-[#FFD700]"
                    : "bg-[#030817] text-[#FFD700] border-[#FFD700]/40 hover:bg-[#081a3d]"
                }`}
              >
                <div>{timer.label}</div>
                <div className="text-sm opacity-80">{timer.range}</div>
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={createGame}
          disabled={!selectedTable || !selectedTimer || creatingGame}
          className="bg-green-600 text-white px-8 py-3 rounded-lg text-lg font-bold hover:bg-green-500 disabled:bg-green-900 disabled:cursor-not-allowed"
        >
          {creatingGame ? "Creating..." : "Create Game"}
        </button>
      </div>

      <div className="flex justify-center mb-8">
        <button
          onClick={() => setShowBetPopup(true)}
          className="bg-green-500 text-white px-6 py-4 rounded-lg text-xl font-semibold hover:bg-green-400"
        >
          Play vs AI 🤖
        </button>
      </div>

      <div className="max-w-3xl mx-auto mt-10 bg-[#002147] p-5 rounded-xl border border-[#FFD700]/40 text-left">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-[#FFD700]">Available Games</h2>
          <button
            onClick={fetchAvailableGames}
            className="bg-[#FFD700] text-[#030817] px-4 py-2 rounded-lg font-semibold hover:bg-[#FFD700]/80"
          >
            {isLoadingAvailableGames ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {availableGames.length === 0 ? (
          <p className="text-white/80">No open games right now. Create one from the options above.</p>
        ) : (
          <div className="space-y-3">
            {availableGames.map((game) => (
              <div key={game.id} className="flex items-center justify-between bg-[#030817] rounded-lg p-3">
                <div>
                  <p className="font-semibold">Game #{game.id}</p>
                  <p className="text-sm text-white/80">
                    Host: {game.hostName || "Player"} · Bet: ${Number(game.betAmount)} · Timer: {game.timerMode}
                  </p>
                </div>
                <button
                  onClick={() => joinSpecificGame(game.id)}
                  disabled={joiningGameId === game.id}
                  className="bg-green-600 px-4 py-2 rounded-lg font-bold hover:bg-green-700 disabled:bg-green-800"
                >
                  {joiningGameId === game.id ? "Joining..." : "Join"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showBetPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-white text-black p-8 rounded-lg w-96 shadow-lg">
            <h2 className="text-2xl font-bold mb-4 text-center">Enter Your Bet Amount</h2>

            <input
              type="number"
              min="1"
              value={betAmount}
              onChange={(e) => setBetAmount(e.target.value)}
              className="w-full border px-3 py-2 mb-4 rounded"
              placeholder="Bet amount"
            />

            <div className="flex justify-between">
              <button
                onClick={() => setShowBetPopup(false)}
                className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
              >
                Cancel
              </button>

              <button
                onClick={startAIGame}
                disabled={!betAmount}
                className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 disabled:bg-green-300"
              >
                Start Game
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
