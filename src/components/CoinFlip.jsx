"use client"; 
import NavigationBar from "../components/navigation-bar";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation"; // ✅ For navigation

const HOUSE_EDGE = 0.98;
const FEE = 0.02;

export default function CoinFlipPage() {
  const [mode, setMode] = useState("solo");
  const router = useRouter();

  return (
    <div className="min-h-screen flex flex-col items-center justify-start p-6 text-white relative"
         style={{ backgroundColor: "#1e3f5a" }}> {/* ✅ Marine blue bg */}
<NavigationBar currentPath="/casino" />
      <div className="max-w-2xl w-full mt-16 p-6 bg-gray-800 text-white rounded shadow-lg">
        <h1 className="text-3xl font-bold text-center mb-6">Coin Flip</h1>

        <div className="flex justify-center space-x-4 mb-6">
          <button
            className={`px-4 py-2 rounded ${mode === "solo" ? "bg-blue-600" : "bg-gray-600"}`}
            onClick={() => setMode("solo")}
          >
            Solo vs House
          </button>
          <button
            className={`px-4 py-2 rounded ${mode === "pvp" ? "bg-blue-600" : "bg-gray-600"}`}
            onClick={() => setMode("pvp")}
          >
            PvP
          </button>
        </div>

        {mode === "solo" ? <SoloCoinFlip /> : <PvPCoinFlip />}

        <style jsx global>{`
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
      const res = await fetch("/api/get-user-tokens", { method: "POST" });
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
      <div className="mb-4 flex justify-between items-center">
        <p className="text-yellow-400 font-bold">
          Balance: {userTokens !== null ? `${userTokens.toFixed(2)} 🪙` : "..."}
        </p>
        <div className="flex items-center gap-2">
          <label>Auto Delay (ms):</label>
          <input
            type="number"
            min="100"
            className="w-20 bg-gray-700 p-1 rounded"
            value={autoDelay}
            onChange={(e) => setAutoDelay(parseInt(e.target.value))}
          />
        </div>
      </div>

      <label className="block mb-1">Bet Amount ($)</label>
      <input
        type="number"
        className="w-full bg-gray-700 p-2 rounded mb-4"
        value={bet}
        onChange={(e) => setBet(parseFloat(e.target.value))}
      />

      <div className="flex justify-between mb-4">
        <button
          onClick={() => setChoice("heads")}
          className={`w-full mr-2 p-2 rounded ${
            choice === "heads" ? "bg-green-600" : "bg-gray-600"
          }`}
        >
          Heads
        </button>
        <button
          onClick={() => setChoice("tails")}
          className={`w-full ml-2 p-2 rounded ${
            choice === "tails" ? "bg-green-600" : "bg-gray-600"
          }`}
        >
          Tails
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => flip(false)}
          disabled={flipping}
          className="w-full p-3 bg-yellow-500 rounded font-bold"
        >
          {flipping ? "Flipping..." : "Flip Coin"}
        </button>
        <button
          onClick={() => setAutoBet((prev) => !prev)}
          className={`w-full p-3 rounded font-bold ${
            autoBet ? "bg-red-500" : "bg-blue-500"
          }`}
        >
          {autoBet ? "Stop Auto" : "Start Auto"}
        </button>
      </div>

      <div className="flex justify-center mt-6 h-28">
        <div className="relative w-24 h-24 perspective">
          <div
            key={flipKey}
            className={`w-full h-full rounded-full text-4xl flex items-center justify-center bg-yellow-300 text-black font-bold ${
              flipping ? "animate-coin-flip" : ""
            }`}
          >
            {result === "heads" ? "H" : result === "tails" ? "T" : "?"}
          </div>
        </div>
      </div>

      {message && <p className="text-center mt-4 text-blue-300">{message}</p>}
    </>
  );
}

// ------------------- PvP Coin Flip ------------------- //
function PvPCoinFlip() {
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
    if (!myGameId) return;

    const checkGame = async () => {
      const res = await fetch(`/api/coin-flip/pvp/status?gameId=${myGameId}`);
      const json = await res.json();
      if (!json.success) return;

      const game = json.data;
      setGameStatus(game.status);
      setChoiceDeadline(game.choiceDeadline || null);

      const opponent = game.player1Id === userId ? game.player2Id : game.player1Id;
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
      const seconds = Math.max(0, Math.ceil((new Date(choiceDeadline).getTime() - Date.now()) / 1000));
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
      setMessage("Choose heads or tails in 5 seconds.");
    } else {
      setMessage(json.error);
    }
  };

  const availableGames = games.filter((g) => g.player1Id !== userId && g.id !== myGameId);

  return (
    <>
      {!myGameId && (
        <>
          <label className="block mb-1">Bet Amount</label>
          <input
            type="number"
            className="w-full bg-gray-700 p-2 rounded mb-4"
            value={bet}
            onChange={(e) => setBet(parseFloat(e.target.value))}
          />

          <button
            onClick={createGame}
            className="w-full p-3 rounded font-bold text-lg 
                       bg-gradient-to-r from-yellow-400 to-yellow-600
                       hover:scale-105 transition transform
                       text-black shadow-lg"
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
      : "bg-blue-500 hover:bg-blue-600"
  }`}
>
  🔄 Refresh
</button>
</div>

            {availableGames.length === 0 && (
              <p className="text-center text-gray-400">No games available. Be the first to create one!</p>
            )}

            <div className="space-y-3">
              {availableGames.map((game) => (
                <div
                  key={game.id}
                  className="bg-gray-900 border border-gray-700 
                             rounded-lg p-4 flex justify-between items-center"
                >
                  <div>
                    <p className="font-bold">{game.player1Name || "Unknown Player"}</p>
                    <p className="text-gray-400 mt-1">Bet: {game.betAmount} 🪙</p>
                  </div>

                  <button
                    onClick={() => joinGame(game.id)}
                    className="px-4 py-2 rounded-lg font-bold
                               bg-green-600 hover:bg-green-500
                               transition"
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
              <p className="mt-2 text-yellow-400">Choice: {myChoice || "Not chosen"}</p>
            </div>

            <div className="bg-gray-800 p-4 rounded-lg">
              <p className="font-bold text-yellow-400">{opponentId ? "Opponent" : "Searching..."}</p>
              <p className="text-sm break-all">{opponentId || "..."}</p>
              <p className="mt-2 text-yellow-400">Choice: {opponentChoice || "Not chosen"}</p>
            </div>
          </div>

          {gameStatus === "matched" && (
            <div className="mb-4 text-center text-orange-300 font-semibold">Choice timer: {timeLeft}s</div>
          )}

          {!myChoice && gameStatus === "matched" && !flipping && (
            <div className="flex justify-between mb-6">
              <button
                onClick={() => submitChoice("heads")}
                disabled={opponentChoice === "heads"}
                className={`w-full mr-2 p-2 rounded ${
                  opponentChoice === "heads" ? "bg-gray-500 cursor-not-allowed" : "bg-gray-600 hover:bg-green-700"
                }`}
              >
                Heads
              </button>

              <button
                onClick={() => submitChoice("tails")}
                disabled={opponentChoice === "tails"}
                className={`w-full ml-2 p-2 rounded ${
                  opponentChoice === "tails" ? "bg-gray-500 cursor-not-allowed" : "bg-gray-600 hover:bg-green-700"
                }`}
              >
                Tails
              </button>
            </div>
          )}

          <div className="flex justify-center mb-6">
            <div className="relative w-24 h-24 perspective">
              <div
                key={flipKey}
                className={`w-full h-full rounded-full flex items-center justify-center 
          bg-yellow-300 text-black text-4xl font-bold
          ${flipping ? "animate-coin-flip" : ""}`}
              >
                {!result && "🪙"}
                {result === "heads" && "H"}
                {result === "tails" && "T"}
              </div>
            </div>
          </div>

          <p className="text-center text-gray-400 mb-4">Bet Locked: {myBet} 🪙</p>

          {message && <p className="text-center text-blue-300 mb-4">{message}</p>}

          {!flipping && !gameFinished && gameStatus !== "cancelled" && (
            <button
              onClick={cancelGame}
              className="mt-2 w-full p-3 rounded-lg font-bold
                   bg-red-600 hover:bg-red-500
                   transition transform hover:scale-105"
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
               bg-blue-600 hover:bg-blue-500"
            >
              Close
            </button>
          )}
        </div>
      )}
    </>
  );
}

