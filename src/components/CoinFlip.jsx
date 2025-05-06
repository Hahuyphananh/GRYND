"use client";
import { useState } from "react";

const HOUSE_EDGE = 0.98; // 2% house edge

export default function CoinFlip() {
  const [betAmount, setBetAmount] = useState(10);
  const [selectedSide, setSelectedSide] = useState("heads");
  const [flipping, setFlipping] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");

  const flipCoin = () => {
    if (betAmount <= 0) {
      setMessage("Bet amount must be greater than 0");
      return;
    }

    setFlipping(true);
    setMessage("Flipping...");

    setTimeout(() => {
      const outcome = Math.random() < 0.5 ? "heads" : "tails";
      setResult(outcome);

      if (selectedSide === outcome) {
        const winnings = betAmount * HOUSE_EDGE;
        setMessage(`You won! 🪙 You get $${winnings.toFixed(2)}.`);
      } else {
        setMessage("You lost! 💸 Try again.");
      }

      setFlipping(false);
    }, 1500);
  };

  return (
    <div className="max-w-md mx-auto mt-10 bg-gray-800 p-6 rounded-lg shadow-md text-white">
      <h1 className="text-2xl font-bold mb-4 text-center">🪙 Coin Flip</h1>

      <div className="mb-4">
        <label className="block mb-1 font-semibold">Bet Amount ($)</label>
        <input
          type="number"
          value={betAmount}
          onChange={(e) => setBetAmount(parseFloat(e.target.value))}
          className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600"
        />
      </div>

      <div className="mb-4">
        <label className="block mb-1 font-semibold">Choose Side</label>
        <div className="flex space-x-4">
          <button
            className={`flex-1 p-2 rounded ${
              selectedSide === "heads" ? "bg-blue-600" : "bg-gray-600"
            }`}
            onClick={() => setSelectedSide("heads")}
          >
            Heads
          </button>
          <button
            className={`flex-1 p-2 rounded ${
              selectedSide === "tails" ? "bg-blue-600" : "bg-gray-600"
            }`}
            onClick={() => setSelectedSide("tails")}
          >
            Tails
          </button>
        </div>
      </div>

      <button
        onClick={flipCoin}
        disabled={flipping}
        className="w-full bg-green-600 hover:bg-green-700 p-3 rounded font-bold mt-4 disabled:opacity-50"
      >
        {flipping ? "Flipping..." : "Flip Coin"}
      </button>

      {result && (
        <div className="mt-4 text-center text-xl">
          Result: <strong className="capitalize">{result}</strong>
        </div>
      )}

      {message && (
        <p className="mt-2 text-center text-yellow-300 font-medium">
          {message}
        </p>
      )}
    </div>
  );
}
