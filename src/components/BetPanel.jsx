import React, { useState } from "react";

export default function BetPanel({ placeBet, hasBet, gameRunning, isCrashed }) {
  const [amount, setAmount] = useState("");
  const [autoCashout, setAutoCashout] = useState(2.0);

  const handlePlaceBet = () => {
    if (!amount || isNaN(amount)) return;
    placeBet(parseFloat(amount), parseFloat(autoCashout));
  };

  return (
    <div className="bg-gray-800 p-6 rounded-lg flex flex-col gap-4 w-full md:w-100%">
      <h2 className="text-2xl font-bold mb-2">Place Bet</h2>
      <input
        type="number"
        value={amount}
        onChange={e => setAmount(e.target.value)}
        placeholder="Bet Amount ($)"
        className="bg-gray-700 p-3 rounded text-white"
        disabled={gameRunning || hasBet}
      />
      <input
        type="number"
        value={autoCashout}
        step="0.1"
        onChange={e => setAutoCashout(e.target.value)}
        placeholder="Auto Cashout (e.g. 2.0x)"
        className="bg-gray-700 p-3 rounded text-white"
        disabled={gameRunning || hasBet}
      />
      <button
        onClick={handlePlaceBet}
        disabled={gameRunning || hasBet}
        className="bg-yellow-500 hover:bg-yellow-600 py-3 rounded-lg font-bold"
      >
        {hasBet ? "Bet Placed" : "Place Bet"}
      </button>
    </div>
  );
}
