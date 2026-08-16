"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { useEffect, useState } from "react";
import { useSocket } from "../../../context/SocketProvider";
import {
  IconChess,
  IconRobot,
  IconPalette,
  IconClock,
} from "@tabler/icons-react";
const TABLES = [1, 5, 10, 20, 50, 100];

const AI_DIFFICULTY_LEVELS = [
  { level: 1, label: "Beginner", desc: "Easy opponent" },
  { level: 2, label: "Casual", desc: "Relaxed play" },
  { level: 3, label: "Intermediate", desc: "Moderate challenge" },
  { level: 4, label: "Advanced", desc: "Strong opponent" },
  { level: 5, label: "Expert", desc: "Very tough" },
];
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
  const [aiDifficulty, setAiDifficulty] = useState(3);
  const [aiTimer, setAiTimer] = useState("5min");
  const [aiColor, setAiColor] = useState("random");
  const [availableGames, setAvailableGames] = useState([]);
  const [isLoadingAvailableGames, setIsLoadingAvailableGames] = useState(false);
  const [joiningGameId, setJoiningGameId] = useState(null);
  const [creatingGame, setCreatingGame] = useState(false);
  const [selectedTable, setSelectedTable] = useState(null);
  const [selectedTimer, setSelectedTimer] = useState("");
  const [error, setError] = useState(null);
  const [aiGameLoading, setAiGameLoading] = useState(false);

  // Auto-clear errors after 5 seconds
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    fetchAvailableGames();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:chess";
    const handleLobbyUpdate = () => fetchAvailableGames();

    // Join room and re-join on reconnect
    const joinRoom = () => socket.emit("join_room", { roomId });
    joinRoom();
    socket.on("connect", joinRoom);
    socket.on("lobby:updated", handleLobbyUpdate);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("connect", joinRoom);
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

    setError(null);
    setCreatingGame(true);
    try {
      const res = await fetch("/api/chess/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableAmount: selectedTable,
          timerMode: selectedTimer,            timeLimit: selectedTimerObj?.time, // IMPORTANT FIX
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
          `/casino/chess-game/${data.gameId}?color=${data.color}&timer=${selectedTimer}`,
        );
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:chess",
        event: "lobby:updated",
      });
      router.push(
        `/casino/chess/${selectedTable}?gameId=${data.gameId}&color=${data.color}&timer=${selectedTimer}`,
      );
    } catch (error) {
      console.error("Failed to create chess game", error);
      setError("Unable to create game");
    } finally {
      setCreatingGame(false);
    }
  }

  async function joinSpecificGame(gameId) {
    setError(null);
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
        `/casino/chess-game/${gameId}?color=black&timer=${targetGame?.timerMode || "5min"}`,
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
          difficultyLevel: aiDifficulty,
        }),
      });

      if (!res.ok) throw new Error("Failed to create AI game");

      const data = await res.json();
      const timerObj = TIMER_OPTIONS.find((t) => t.id === aiTimer);
      router.push(`/casino/chess/ai?gameId=${data.gameId}&difficulty=${aiDifficulty}&timer=${timerObj?.time || 300}&color=${aiColor}`);
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
        <span className="inline-flex items-center gap-2"><IconChess size={28} /> Chess Arena — Challenge Players</span>
      </h1>

      <div className="max-w-4xl mx-auto bg-[#0b224f]/85 p-6 rounded-xl border border-[#00e5ff]/30 mb-8 shadow-[0_0_24px_rgba(0,229,255,0.18)]">
        <h2 className="text-2xl font-bold text-[#FFD700] mb-4">
          Create Multiplayer Game
        </h2>
        <p className="text-white/80 mb-5">
          Select a stake and timer, then create your game. Winner gets the pot minus 10% house fee.
        </p>

        <div className="mb-6">
          <h3 className="text-lg font-semibold text-left mb-3">
            1) Choose Stake
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
                ${amount} Stake
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

        {selectedTable && selectedTimer && (
          <div className="mb-4 bg-emerald-900/20 border border-emerald-400/30 text-emerald-300 p-2 rounded text-sm text-center">
            Pot: ${selectedTable * 2} · Winner gets ~${(selectedTable * 2 * 0.9).toFixed(2)} (after 10% house fee)
          </div>
        )}

        <button
          onClick={createGame}
          disabled={!selectedTable || !selectedTimer || creatingGame}
          className="bg-[#FFD700] text-[#030817] px-8 py-3 rounded-lg text-lg font-bold hover:bg-[#ffe14f] shadow-[0_0_16px_rgba(255,215,0,0.45)] disabled:bg-[#7f8520] disabled:text-[#c6c6c6] disabled:cursor-not-allowed"
        >
          {creatingGame ? "Creating..." : "Create Game"}
        </button>

        <div className="mt-6 pt-6 border-t border-[#00e5ff]/20">
          <h2 className="text-2xl font-bold text-[#FFD700] mb-3">
            Play vs AI
          </h2>
          <p className="text-white/80 mb-4">
            Challenge the computer for free — choose your difficulty.
          </p>
          <button
            onClick={() => setShowBetPopup(true)}
            className="bg-gradient-to-r from-purple-600 to-indigo-600 text-white px-8 py-3 rounded-lg text-lg font-bold hover:from-purple-500 hover:to-indigo-500 shadow-[0_0_16px_rgba(139,92,246,0.45)] transition-colors"
          >
            <span className="inline-flex items-center gap-2"><IconRobot size={18} /> Play vs AI</span>
          </button>
        </div>
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
          <div className="text-center py-8">
            <IconChess size={48} className="opacity-30" />
            <p className="text-white/60 mt-2">
              No open games right now. Create one from the options above.
            </p>
          </div>
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
                    Host: {game.hostName || "Player"} · Stake: $
                    {Number(game.betAmount)} · Timer:{" "}
                    {TIMER_OPTIONS.find((t) => t.id === game.timerMode)
                      ?.label || "Unknown"}
                    {game.createdAt && (
                      <> · Waiting {(() => {
                        const mins = Math.floor((Date.now() - new Date(game.createdAt).getTime()) / 60000);
                        return mins < 1 ? "<1m" : `${mins}m`;
                      })()}</>
                    )}
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
            <h2 className="text-2xl font-bold mb-2 text-center text-[#FFD700]">
              Choose AI Difficulty
            </h2>
            <p className="text-white/60 text-xs text-center mb-4">
              Free to play — no stakes!
            </p>

            {/* Color selection */}
            <h3 className="mb-2 flex items-center justify-center gap-1.5 text-sm font-semibold text-white/70"><IconPalette size={16} /> Play as:</h3>
            <div className="flex gap-2 justify-center mb-4">
              {[
                { key: "white", label: "♔ White", desc: "Move first" },
                { key: "black", label: "♚ Black", desc: "AI moves first" },
                { key: "random", label: "Random", desc: "Surprise me" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setAiColor(opt.key)}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border transition-all text-center ${
                    aiColor === opt.key
                      ? "bg-[#FFD700] text-[#030817] border-[#FFD700]"
                      : "bg-[#0a1a3a] text-white/70 border-[#00e5ff]/20 hover:border-[#00e5ff]/40"
                  }`}
                >
                  <div>{opt.label}</div>
                  <div className={`text-[10px] mt-0.5 ${aiColor === opt.key ? "text-[#030817]/60" : "text-white/30"}`}>{opt.desc}</div>
                </button>
              ))}
            </div>

            {/* Timer selection */}
            <h3 className="mb-2 flex items-center justify-center gap-1.5 text-sm font-semibold text-white/70"><IconClock size={16} /> Timer:</h3>
            <div className="flex flex-wrap gap-2 justify-center mb-4">
              {TIMER_OPTIONS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setAiTimer(t.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    aiTimer === t.id
                      ? "bg-[#FFD700] text-[#030817] border-[#FFD700]"
                      : "bg-[#0a1a3a] text-white/70 border-[#00e5ff]/20 hover:border-[#00e5ff]/40"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Difficulty levels */}
            <div className="flex flex-col gap-2 mb-4">
              {AI_DIFFICULTY_LEVELS.map((diff) => (
                <button
                  key={diff.level}
                  onClick={() => setAiDifficulty(diff.level)}
                  className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all ${
                    aiDifficulty === diff.level
                      ? "bg-[#FFD700] text-[#030817] border-[#FFD700] shadow-[0_0_14px_rgba(255,215,0,0.45)]"
                      : "bg-[#0a1a3a] text-white/80 border-[#00e5ff]/20 hover:bg-[#0d224f] hover:border-[#00e5ff]/40"
                  }`}
                >
                  <span className="font-bold">{diff.label}</span>
                  <span className={`ml-2 text-xs ${aiDifficulty === diff.level ? "text-[#030817]/70" : "text-white/40"}`}>
                    — {diff.desc}
                  </span>
                </button>
              ))}
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
                disabled={aiGameLoading}
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
