"use client";

import React from "react";

const BetTracker = ({ currentBets, betHistory }) => {
  return (
    <div className="space-y-4">
      {/* CURRENT BETS */}
      <div className="rounded-xl border border-[#00e5ff]/40 bg-[#08142f]/95 p-4">
        <h2 className="text-lg font-bold text-[#f5ff3b] mb-2">Current Bets</h2>

        {currentBets.length === 0 ? (
          <p className="text-sm text-[#00e5ff]">No active bets</p>
        ) : (
          currentBets.map((bet) => (
            <div
              key={bet.id}
              className="mb-2 rounded-lg border border-[#00e5ff]/30 p-2 text-sm text-[#9dd8ff]"
            >
              <p>{bet.choice}</p>
              <p>Amount: {bet.amount}</p>
              <p>Odds: {bet.odds}</p>
            </div>
          ))
        )}
      </div>

      {/* BET HISTORY */}
      <div className="rounded-xl border border-[#f5ff3b]/40 bg-[#08142f]/95 p-4">
        <h2 className="text-lg font-bold text-[#f5ff3b] mb-2">Bet History</h2>

        {betHistory.length === 0 ? (
          <p className="text-sm text-[#00e5ff]">No past bets</p>
        ) : (
          betHistory.map((bet) => (
            <div
              key={bet.id}
              className={`mb-2 rounded-lg border p-2 text-sm ${
                bet.result === "win"
                  ? "border-green-400 text-green-300"
                  : "border-red-400 text-red-300"
              }`}
            >
              <p>{bet.choice}</p>
              <p>Amount: {bet.amount}</p>
              <p>Odds: {bet.odds}</p>
              <p>Result: {bet.result.toUpperCase()}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default BetTracker;