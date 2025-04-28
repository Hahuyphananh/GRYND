import React from "react";

export default function PlayerList({ hasBet, betAmount, cashedOut, multiplier }) {
  return (
    <div className="bg-gray-800 p-6 rounded-lg flex flex-col gap-4 w-full md:w-100%">
      <h2 className="text-2xl font-bold mb-2">My Bet</h2>
      {!hasBet ? (
        <div className="text-gray-400">No active bets</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div>💵 Bet Amount: ${betAmount}</div>
          <div>
            {cashedOut ? (
              <span className="text-green-400">
                ✅ Cashed out at {multiplier.toFixed(2)}x
              </span>
            ) : (
              <span className="text-yellow-400">Waiting...</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
