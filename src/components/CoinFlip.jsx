"use client"; 
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

      {/* ✅ Return to Casino Button */}
      <button
        onClick={() => router.push("/casino")}
        className="absolute top-4 left-4 bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded shadow"
      >
        ⬅ Return to Casino
      </button>

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
  const [bet, setBet] = useState(10), [choice, setChoice] = useState("heads");
  const [flipping, setFlipping] = useState(false), [message, setMessage] = useState("");
  const [result, setResult] = useState(null), [flipKey, setFlipKey] = useState(0);
  const [games, setGames] = useState([]), [myGameId, setMyGameId] = useState(null);

  useEffect(() => {
    async function fetchGames() {
      const res = await fetch("/api/coin-flip/pvp/available", { method: "POST" });
      const json = await res.json();
      if (json.success) setGames(json.data.games);
    }
    fetchGames();
  }, []);

  const createGame = async () => {
    setMessage("Creating...");
    const res = await fetch("/api/coin-flip/pvp/create", {
      method: "POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ betAmount: bet, choice })
    });
    const json = await res.json();
    if (json.success) {
      setMyGameId(json.data.gameId);
      setGames(prev => [...prev, json.data]);
      setMessage("Game created.");
    } else setMessage(json.error);
  };

  const joinGame = async (gameId) => {
    setFlipping(true); setMessage("Flipping...");
    const res = await fetch("/api/coin-flip/pvp/join", {
      method: "POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ gameId, choice })
    });
    const json = await res.json();
    setFlipping(false);
    if (json.success) {
      setResult(json.data.outcome);
      setMessage(json.data.winner === "you" ? "✅ You won!" : "❌ You lost.");
      setGames(prev => prev.filter(g => g.gameId !== gameId));
      setMyGameId(null);
      setFlipKey(k => k + 1);
    } else setMessage(json.error);
  };

  return (
    <>
      {!myGameId ? (
        <button onClick={createGame}>Create Game</button>
      ) : (
        <div>
          {games.filter(g=>g.gameId===myGameId).map(g=>(
            <button key={g.gameId} onClick={()=>joinGame(g.gameId)}>
              Join Game #{g.gameId}
            </button>
          ))}
        </div>
      )}
      <div className="perspective">
        <div key={flipKey} className={`w-24 h-24 rounded-full flex items-center justify-center bg-yellow-300 text-black text-4xl font-bold ${flipping?"animate-coin-flip":""}`}>
          {result==="heads"?"H":result==="tails"?"T":"?"}
        </div>
      </div>
      {message && <p>{message}</p>}
    </>
  );
}
