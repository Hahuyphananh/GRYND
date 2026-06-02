"use client";
import NavigationBar from "../components/navigation-bar";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation"; // ✅ For navigation
import { useSocket } from "../context/SocketProvider";
import ReportPlayerButton from "./ReportPlayerButton";

const HOUSE_EDGE = 0.98;
const FEE = 0.02;

export default function CoinFlipPage() {
  const [mode, setMode] = useState("solo");
  const router = useRouter();

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-start overflow-x-clip px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8"
      style={{
        backgroundImage:
          "linear-gradient(135deg, #020617 0%, #020617 40%, #0f172a 100%)",
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(168,85,247,0.15),transparent_70%)] pointer-events-none" />
      <NavigationBar currentPath="/casino" />
      <div className="mt-6 w-full max-w-2xl rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-4 text-white shadow-[0_0_24px_rgba(0,229,255,0.2)] sm:mt-10 sm:p-6">
        <h1 className="mb-6 text-center text-2xl font-extrabold tracking-wide text-[#00e5ff] sm:text-3xl">
          Coin Flip
        </h1>

        <div className="mb-6 grid grid-cols-2 gap-2 sm:flex sm:justify-center sm:space-x-4 sm:gap-0">
          <button
            className={`px-4 py-2 rounded ${
              mode === "solo"
                ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-[0_0_14px_rgba(236,72,153,0.5)]"
                : "bg-[#0d335f] hover:bg-[#144a85]"
            }`}
            onClick={() => setMode("solo")}
          >
            Solo vs House
          </button>
          <button
            className={`px-4 py-2 rounded ${
              mode === "pvp"
                ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-[0_0_14px_rgba(236,72,153,0.5)]"
                : "bg-[#0d335f] hover:bg-[#144a85]"
            }`}
            onClick={() => setMode("pvp")}
          >
            PvP
          </button>
        </div>

        {mode === "solo" ? <SoloCoinFlip /> : <PvPCoinFlip />}

        <style jsx>{`
          .perspective {
            perspective: 1000px;
          }

          @keyframes coin-flip {
            0% {
              transform: rotateY(0deg) rotateX(0deg);
            }
            100% {
              transform: rotateY(1440deg) rotateX(720deg);
            }
          }

          .animate-coin-flip {
            animation: coin-flip 1s cubic-bezier(0.19, 1, 0.22, 1) forwards;
            transform-style: preserve-3d;
            backface-visibility: hidden;
          }
        `}</style>
      </div>
    </div>
  );
}

// ------------------- Solo Coin Flip ------------------- //
function SoloCoinFlip() {
  const [bet, setBet] = useState(10);
  const [choice, setChoice] = useState("heads");
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");
  const [flipping, setFlipping] = useState(false);
  const [userTokens, setUserTokens] = useState(null);
  const [flipKey, setFlipKey] = useState(0);

  const [autoBet, setAutoBet] = useState(false);
  const [autoDelay, setAutoDelay] = useState(1000); // ms

  useEffect(() => {
    fetchTokens();
  }, []);

  useEffect(() => {
    let interval;
    if (autoBet && userTokens >= bet) {
      interval = setInterval(() => {
        flip(true);
      }, autoDelay);
    }
    return () => clearInterval(interval);
  }, [autoBet, autoDelay, bet, choice, userTokens]);

  const fetchTokens = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (json.success) setUserTokens(parseFloat(json.data.balance));
    } catch {
      setMessage("Failed to load balance");
    }
  };

  const flip = async (isAuto = false) => {
    if (bet <= 0 || !["heads", "tails"].includes(choice)) {
      return setMessage("Enter a valid bet and choice.");
    }
    if (userTokens === null || userTokens < bet) {
      if (isAuto) setAutoBet(false);
      return setMessage("Insufficient balance.");
    }

    setFlipping(true);
    setResult(null);
    setFlipKey((prev) => prev + 1);
    setUserTokens((prev) => prev - bet); // Deduct bet instantly

    const audio = new Audio("/sounds/coin-flip.mp3");
    audio.play().catch(console.error);

    try {
      const res = await fetch("/api/coin-flip/solo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bet, choice }),
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Error occurred");

      const { outcome, won, payout, newBalance } = json.data;

      setFlipping(false);
      setResult(outcome);
      setUserTokens(parseFloat(newBalance));
      setMessage(won ? `✅ You won $${payout.toFixed(2)}!` : "❌ You lost.");
    } catch {
      setFlipping(false);
      setMessage("Server error during flip.");
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-[#FFD700] font-bold">
          Balance: {userTokens !== null ? `${userTokens.toFixed(2)} 🪙` : "..."}
        </p>
        <div className="flex items-center gap-2">
          <label>Auto Delay (ms):</label>
          <input
            type="number"
            min="100"
            className="w-20 bg-[#08142f] border border-[#00e5ff]/30 p-1 rounded"
            value={autoDelay}
            onChange={(e) => setAutoDelay(parseInt(e.target.value))}
          />
        </div>
      </div>

      <label className="block mb-1">Bet Amount ($)</label>
      <input
        type="number"
        className="w-full bg-[#08142f] border border-[#00e5ff]/30 p-2 rounded mb-4"
        value={bet}
        onChange={(e) => setBet(parseFloat(e.target.value))}
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:justify-between">
        <button
          onClick={() => setChoice("heads")}
            className={`w-full rounded p-3 text-base ${
            choice === "heads"
              ? "bg-gradient-to-r from-cyan-400 to-emerald-400 text-black shadow-[0_0_12px_rgba(16,185,129,0.6)]"
              : "bg-[#0d335f] hover:bg-[#144a85]"
          }`}
        >
          Heads ⚡
        </button>
        <button
          onClick={() => setChoice("tails")}
            className={`w-full rounded p-3 text-base ${
            choice === "tails"
              ? "bg-gradient-to-r from-cyan-400 to-emerald-400 text-black shadow-[0_0_12px_rgba(16,185,129,0.6)]"
              : "bg-[#0d335f] hover:bg-[#144a85]"
          }`}
        >
          Tails 💠
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <button
          onClick={() => flip(false)}
          disabled={flipping}
          className="w-full p-3 bg-gradient-to-r from-purple-500 to-pink-500 
hover:scale-105 transition transform 
shadow-[0_0_18px_rgba(236,72,153,0.6)] text-[#030817] rounded font-bold shadow-[0_0_14px_rgba(255,215,0,0.45)]"
        >
          {flipping ? "Flipping..." : "Flip Coin"}
        </button>
        <button
          onClick={() => setAutoBet((prev) => !prev)}
          className={`w-full p-3 rounded font-bold ${
            autoBet
              ? "bg-gradient-to-r from-red-500 to-orange-500 shadow-[0_0_12px_rgba(239,68,68,0.6)]"
              : "bg-gradient-to-r from-cyan-400 to-emerald-400 text-black shadow-[0_0_12px_rgba(16,185,129,0.6)]"
          }`}
        >
          {autoBet ? "Stop Auto" : "Start Auto"}
        </button>
      </div>

      <div className="flex justify-center mt-6 h-28">
        <div className="relative w-24 h-24 perspective">
          <div
            key={flipKey}
            className={`w-full h-full rounded-full text-4xl flex items-center justify-center 
bg-gradient-to-br from-purple-500 via-pink-500 to-indigo-500
text-white font-bold
shadow-[0_0_25px_rgba(168,85,247,0.8),inset_0_0_20px_rgba(255,255,255,0.2)]
border border-pink-400/40
${flipping ? "animate-coin-flip" : ""}`}
          >
            {result === "heads" ? "⚡" : result === "tails" ? "💠" : "?"}
          </div>
        </div>
      </div>

      {message && <p className="text-center mt-4 text-[#7cefff]">{message}</p>}
    </>
  );
}

// ------------------- PvP Coin Flip ------------------- //
function PvPCoinFlip() {
  const { socket } = useSocket();
  const [bet, setBet] = useState(10);
  const [flipping, setFlipping] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);
  const [flipKey, setFlipKey] = useState(0);

  const [games, setGames] = useState([]);
  const [myGameId, setMyGameId] = useState(null);
  const [myBet, setMyBet] = useState(null);
  const [userId, setUserId] = useState(null);
  const [opponentId, setOpponentId] = useState(null);
  const [myChoice, setMyChoice] = useState(null);
  const [opponentChoice, setOpponentChoice] = useState(null);
  const [gameFinished, setGameFinished] = useState(false);
  const [gameStatus, setGameStatus] = useState(null);
  const [choiceDeadline, setChoiceDeadline] = useState(null);
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    const getUser = async () => {
      const res = await fetch("/api/get-user");
      const json = await res.json();
      if (json.success) setUserId(json.data.userId);
    };

    getUser();
  }, []);

  const fetchGames = async () => {
    try {
      const res = await fetch("/api/coin-flip/pvp/available");
      const json = await res.json();
      if (json.success) {
        setGames(json.data.games);
      }
    } catch (err) {
      console.error("Error fetching games:", err);
    }
  };

  useEffect(() => {
    fetchGames(); // load once
  }, []);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:coin-flip";
    const handleLobbyUpdate = () => fetchGames();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  useEffect(() => {
    if (!myGameId) return;

    const checkGame = async () => {
      const res = await fetch(`/api/coin-flip/pvp/status?gameId=${myGameId}`);
      const json = await res.json();
      if (!json.success) return;

      const game = json.data;
      setGameStatus(game.status);
      setChoiceDeadline(game.choiceDeadline || null);

      const opponent =
        game.player1Id === userId ? game.player2Id : game.player1Id;
      setOpponentId(opponent || null);

      if (game.player1Id === userId) {
        setMyChoice(game.player1Choice || null);
        setOpponentChoice(game.player2Choice || null);
      } else {
        setMyChoice(game.player2Choice || null);
        setOpponentChoice(game.player1Choice || null);
      }

      if (game.status === "matched") {
        setMessage("Choose heads or tails before the timer ends.");
      }

      if (game.status === "cancelled") {
        setFlipping(false);
        setMessage("Game cancelled: choice timer expired. Bets refunded.");
      }

      if (game.status === "finished" && !gameFinished) {
        setFlipping(true);
        setMessage("Flipping coin...");
        setFlipKey((k) => k + 1);

        setTimeout(() => {
          setResult(game.outcome);
          setFlipping(false);
          setMessage(game.winner === "you" ? "✅ You won!" : "❌ You lost.");
          setGameFinished(true);
        }, 1200);
      }
    };

    checkGame();
    const interval = setInterval(checkGame, 1000);
    return () => clearInterval(interval);
  }, [myGameId, userId, gameFinished]);

  useEffect(() => {
    if (!choiceDeadline || gameStatus !== "matched") {
      setTimeLeft(0);
      return;
    }

    const update = () => {
      const seconds = Math.max(
        0,
        Math.ceil((new Date(choiceDeadline).getTime() - Date.now()) / 1000),
      );
      setTimeLeft(seconds);
    };

    update();
    const interval = setInterval(update, 250);
    return () => clearInterval(interval);
  }, [choiceDeadline, gameStatus]);

  const createGame = async () => {
    setMessage("Creating game...");
    setResult(null);
    setFlipping(false);
    setGameFinished(false);
    setGameStatus("active");
    setMyChoice(null);
    setOpponentChoice(null);

    const res = await fetch("/api/coin-flip/pvp/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ betAmount: bet }),
    });

    const json = await res.json();

    if (json.success) {
      setMyGameId(json.data.gameId);
      setMyBet(json.data.betAmount);
      setMessage("Waiting for opponent...");
      socket?.emit("room_event", {
        roomId: "lobby:coin-flip",
        event: "lobby:updated",
      });
    } else {
      setMessage(json.error);
    }
  };

  const submitChoice = async (choice) => {
    if (!myGameId || gameStatus !== "matched" || myChoice) return;

    const res = await fetch("/api/coin-flip/pvp/choose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: myGameId, choice }),
    });

    const json = await res.json();

    if (!json.success) {
      setMessage(json.error || "Failed to save choice");
      return;
    }

    setMyChoice(choice);
    setMessage("Choice locked. Waiting for opponent...");
  };

  const cancelGame = async () => {
    setMessage("Cancelling game...");

    const res = await fetch("/api/coin-flip/pvp/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: myGameId }),
    });

    const json = await res.json();

    if (json.success) {
      setMyGameId(null);
      setMyBet(null);
      setChoiceDeadline(null);
      setGameStatus(null);
      setGames((prev) => prev.filter((g) => g.id !== myGameId));
      setMessage("Game cancelled.");
      socket?.emit("room_event", {
        roomId: "lobby:coin-flip",
        event: "lobby:updated",
      });
    } else {
      setMessage(json.error);
    }
  };

  const joinGame = async (gameId) => {
    if (gameId === myGameId) return;

    setResult(null);
    setFlipping(false);
    setGameFinished(false);
    setMessage("Joining game...");

    const res = await fetch("/api/coin-flip/pvp/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId }),
    });

    const json = await res.json();

    if (json.success) {
      setMyGameId(gameId);
      setChoiceDeadline(json.data.choiceDeadline || null);
      setGameStatus("matched");
      setMessage("Choose heads or tails in 10 seconds.");
      socket?.emit("room_event", {
        roomId: "lobby:coin-flip",
        event: "lobby:updated",
      });
    } else {
      setMessage(json.error);
    }
  };

  const availableGames = games.filter(
    (g) => g.player1Id !== userId && g.id !== myGameId,
  );

  return (
    <>
      {!myGameId && (
        <>
          <label className="block mb-1">Bet Amount</label>
          <input
            type="number"
            className="w-full bg-[#08142f] border border-[#00e5ff]/30 p-2 rounded mb-4"
            value={bet}
            onChange={(e) => setBet(parseFloat(e.target.value))}
          />

          <button
            onClick={createGame}
            className="w-full p-3 rounded font-bold text-lg 
                       bg-gradient-to-r from-purple-500 to-pink-500 
hover:scale-105 
shadow-[0_0_18px_rgba(236,72,153,0.6)]
text-white"
          >
            🎲 Create PvP Game
          </button>

          <div className="mt-8">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-xl font-bold">Available Games</h2>
              <button
                onClick={fetchGames}
                disabled={!!myGameId}
                className={`px-3 py-1 rounded text-sm font-semibold ${
                  myGameId
                    ? "bg-gray-500 cursor-not-allowed"
                    : "bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.4)] hover:bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.4)]"
                }`}
              >
                🔄 Refresh
              </button>
            </div>

            {availableGames.length === 0 && (
              <p className="text-center text-gray-400">
                No games available. Be the first to create one!
              </p>
            )}

            <div className="space-y-3">
              {availableGames.map((game) => (
                <div
                  key={game.id}
                  className="bg-gray-900 border border-gray-700 
                             rounded-lg p-4 flex justify-between items-center"
                >
                  <div>
                    <p className="font-bold">
                      {game.player1Name || "Unknown Player"}
                    </p>
                    <p className="text-gray-400 mt-1">
                      Bet: {game.betAmount} 🪙
                    </p>
                  </div>

                  <button
                    onClick={() => joinGame(game.id)}
                    className="px-4 py-2 rounded-lg font-bold
                               bg-gradient-to-r from-cyan-400 to-emerald-400 
text-black 
shadow-[0_0_12px_rgba(16,185,129,0.6)]"
                  >
                    Join
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {myGameId && (
        <div className="mt-6 bg-gray-900 rounded-xl p-6 shadow-xl border border-gray-700">
          <h2 className="text-center text-xl font-bold mb-6">Coin Flip PvP</h2>

          <div className="grid grid-cols-2 gap-6 text-center mb-6">
            <div className="bg-gray-800 p-4 rounded-lg">
              <p className="font-bold text-green-400">You</p>
              <p className="text-sm break-all">{userId}</p>
              <p className="mt-2 text-yellow-400">
                Choice: {myChoice || "Not chosen"}
              </p>
            </div>

            <div className="bg-gray-800 p-4 rounded-lg">
              <p className="font-bold text-yellow-400">
                {opponentId ? "Opponent" : "Searching..."}
                {opponentId && (
                  <ReportPlayerButton reportedClerkId={opponentId} reportedName="Opponent" gameKey="coin-flip" gameId={myGameId} className="ml-2" />
                )}
              </p>
              <p className="text-sm break-all">{opponentId || "..."}</p>
              <p className="mt-2 text-yellow-400">
                Choice: {opponentChoice || "Not chosen"}
              </p>
            </div>
          </div>

          {gameStatus === "matched" && (
            <div className="mb-4 text-center text-orange-300 font-semibold">
              Choice timer: {timeLeft}s
            </div>
          )}

          {!myChoice && gameStatus === "matched" && !flipping && (
            <div className="flex justify-between mb-6">
              <button
                onClick={() => submitChoice("heads")}
                disabled={opponentChoice === "heads"}
                className={`w-full mr-2 p-2 rounded ${
                  opponentChoice === "heads"
                    ? "bg-gray-500 cursor-not-allowed"
                    : "bg-[#0d335f] hover:bg-green-700"
                }`}
              >
                Heads ⚡
              </button>

              <button
                onClick={() => submitChoice("tails")}
                disabled={opponentChoice === "tails"}
                className={`w-full ml-2 p-2 rounded ${
                  opponentChoice === "tails"
                    ? "bg-gray-500 cursor-not-allowed"
                    : "bg-[#0d335f] hover:bg-green-700"
                }`}
              >
                Tails 💠
              </button>
            </div>
          )}

          <div className="flex justify-center mb-6">
            <div className="relative w-24 h-24 perspective">
              <div
                key={flipKey}
                className={`w-full h-full rounded-full text-4xl flex items-center justify-center 
bg-gradient-to-br from-purple-500 via-pink-500 to-indigo-500
text-white font-bold
shadow-[0_0_25px_rgba(168,85,247,0.8),inset_0_0_20px_rgba(255,255,255,0.2)]
border border-pink-400/40
${flipping ? "animate-coin-flip" : ""}`}
              >
                {!result && "🪙"}
                {result === "heads" && "H"}
                {result === "tails" && "T"}
              </div>
            </div>
          </div>

          <p className="text-center text-gray-400 mb-4">
            Bet Locked: {myBet} 🪙
          </p>

          {message && (
            <p className="text-center text-[#7cefff] mb-4">{message}</p>
          )}

          {!flipping && !gameFinished && gameStatus !== "cancelled" && (
            <button
              onClick={cancelGame}
              className="mt-2 w-full p-3 rounded-lg font-bold
                   bg-gradient-to-r from-red-500 to-orange-500 
shadow-[0_0_12px_rgba(239,68,68,0.6)]"
            >
              Cancel Game
            </button>
          )}
          {(gameFinished || gameStatus === "cancelled") && (
            <button
              onClick={() => {
                setGameFinished(false);
                setMyGameId(null);
                setMyBet(null);
                setOpponentId(null);
                setMyChoice(null);
                setOpponentChoice(null);
                setResult(null);
                setChoiceDeadline(null);
                setGameStatus(null);
                setMessage("");
              }}
              className="mt-2 w-full p-3 rounded-lg font-bold
               bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.4)] hover:bg-[#00e5ff] text-[#001933] shadow-[0_0_10px_rgba(0,229,255,0.4)]"
            >
              Close
            </button>
          )}
        </div>
      )}
    </>
  );
}
