"use client";
import { useState } from "react";

const HOUSE_EDGE = 0.98; // 2% house edge
const FEE = 0.02; // 2% casino cut

export default function CoinFlipPage() {
  const [mode, setMode] = useState("solo"); // solo or pvp

  return (
    <div className="max-w-2xl mx-auto mt-10 p-6 bg-gray-800 text-white rounded shadow-lg">
      <h1 className="text-3xl font-bold text-center mb-6">🪙 Coin Flip</h1>

      <div className="flex justify-center space-x-4 mb-6">
        <button
          className={`px-4 py-2 rounded ${
            mode === "solo" ? "bg-blue-600" : "bg-gray-600"
          }`}
          onClick={() => setMode("solo")}
        >
          Solo vs House
        </button>
        <button
          className={`px-4 py-2 rounded ${
            mode === "pvp" ? "bg-blue-600" : "bg-gray-600"
          }`}
          onClick={() => setMode("pvp")}
        >
          PvP
        </button>
      </div>

      {mode === "solo" ? <SoloCoinFlip /> : <PvPCoinFlip />}
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

  const flip = () => {
    if (bet <= 0) return setMessage("Enter a valid bet");

    setFlipping(true);
    setMessage("Flipping...");

    setTimeout(() => {
      const outcome = Math.random() < 0.5 ? "heads" : "tails";
      setResult(outcome);

      if (outcome === choice) {
        const winnings = bet * HOUSE_EDGE;
        setMessage(`You won $${winnings.toFixed(2)} 🎉`);
      } else {
        setMessage("You lost 💸");
      }

      setFlipping(false);
    }, 1200);
  };

  return (
    <>
      <div className="mb-4">
        <label className="block mb-1">Bet Amount ($)</label>
        <input
          type="number"
          className="w-full bg-gray-700 p-2 rounded"
          value={bet}
          onChange={(e) => setBet(parseFloat(e.target.value))}
        />
      </div>

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

      <button
        onClick={flip}
        disabled={flipping}
        className="w-full p-3 bg-yellow-500 rounded font-bold"
      >
        {flipping ? "Flipping..." : "Flip Coin"}
      </button>

      {result && (
        <p className="mt-4 text-center text-xl capitalize">Result: {result}</p>
      )}
      {message && <p className="text-center mt-2 text-blue-300">{message}</p>}
    </>
  );
}

// ------------------- PvP Coin Flip ------------------- //
function PvPCoinFlip() {
  const [player1, setPlayer1] = useState("");
  const [player2, setPlayer2] = useState("");
  const [bet, setBet] = useState(10);
  const [result, setResult] = useState("");
  const [message, setMessage] = useState("");
  const [flipping, setFlipping] = useState(false);

  const startMatch = () => {
    if (!player1 || !player2 || bet <= 0 || player1 === player2) {
      return setMessage("Please enter valid, different player names and bet");
    }

    setFlipping(true);
    setMessage("Flipping...");

    setTimeout(() => {
      const winner = Math.random() < 0.5 ? player1 : player2;
      const pot = bet * 2;
      const winnings = pot * (1 - FEE);

      setResult(winner);
      setMessage(`🏆 ${winner} wins $${winnings.toFixed(2)} (after 2% fee)`);
      setFlipping(false);
    }, 1300);
  };

  return (
    <>
      <div className="mb-3">
        <label className="block">Player 1</label>
        <input
          className="w-full p-2 bg-gray-700 rounded"
          value={player1}
          onChange={(e) => setPlayer1(e.target.value)}
        />
      </div>
      <div className="mb-3">
        <label className="block">Player 2</label>
        <input
          className="w-full p-2 bg-gray-700 rounded"
          value={player2}
          onChange={(e) => setPlayer2(e.target.value)}
        />
      </div>
      <div className="mb-3">
        <label className="block">Bet Amount ($)</label>
        <input
          type="number"
          className="w-full p-2 bg-gray-700 rounded"
          value={bet}
          onChange={(e) => setBet(parseFloat(e.target.value))}
        />
      </div>

      <button
        onClick={startMatch}
        disabled={flipping}
        className="w-full p-3 bg-purple-600 rounded font-bold"
      >
        {flipping ? "Flipping..." : "Start PvP Match"}
      </button>

      {result && (
        <p className="mt-4 text-center text-xl">Winner: {result}</p>
      )}
      {message && <p className="text-center mt-2 text-blue-300">{message}</p>}
    </>
  );
}
