"use client";
import React from "react";
import { useRouter } from "next/navigation";

export default function EventCard({ team1, team2, date, time, odds1, oddsDraw, odds2, onBetSelect, matchId }) {
  const router = useRouter();

  const handleCardClick = () => {
    router.push(`/sports/match/${matchId}`);
  };

  return (
    <div onClick={handleCardClick} className="cursor-pointer">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-bold">{team1} vs {team2}</h3>
          <p className="text-sm text-gray-400">{date} — {time}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); onBetSelect(team1, odds1); }} className="bg-[#FFD700] text-[#003366] px-2 py-1 rounded">
            {odds1}
          </button>
          {oddsDraw && (
            <button onClick={(e) => { e.stopPropagation(); onBetSelect("Draw", oddsDraw); }} className="bg-[#FFD700] text-[#003366] px-2 py-1 rounded">
              {oddsDraw}
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onBetSelect(team2, odds2); }} className="bg-[#FFD700] text-[#003366] px-2 py-1 rounded">
            {odds2}
          </button>
        </div>
      </div>
    </div>
  );
}
