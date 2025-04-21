"use client";
import React from "react";



export default function EventCard({ 
  team1, 
  team2, 
  date, 
  time, 
  odds1, 
  oddsDraw, 
  odds2, 
  onBetSelect 
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-transparent bg-[#004080] p-4 transition-all duration-300 hover:border-[#FFD700] hover:shadow-lg hover:shadow-[#FFD700]/20">
      <div className="mb-4 rounded-t-lg bg-gradient-to-r from-[#004080] to-[#002040] p-3">
        <div className="text-sm text-[#FFD700]">
          {date} - {time}
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="text-lg font-medium text-white">{team1}</div>
        <div className="text-sm text-[#FFD700]">vs</div>
        <div className="text-lg font-medium text-white">{team2}</div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => onBetSelect(team1, odds1)}
          className="rounded-lg bg-[#FFD700] px-4 py-2 text-center text-sm font-medium text-[#004080] transition-colors hover:bg-[#FFD700]/80"
        >
          {team1} ({odds1})
        </button>
        {oddsDraw && (
          <button
            onClick={() => onBetSelect("Match nul", oddsDraw)}
            className="rounded-lg bg-[#FFD700] px-4 py-2 text-center text-sm font-medium text-[#004080] transition-colors hover:bg-[#FFD700]/80"
          >
            Nul ({oddsDraw})
          </button>
        )}
        <button
          onClick={() => onBetSelect(team2, odds2)}
          className="rounded-lg bg-[#FFD700] px-4 py-2 text-center text-sm font-medium text-[#004080] transition-colors hover:bg-[#FFD700]/80"
        >
          {team2} ({odds2})
        </button>
      </div>
    </div>
  );
}

function StoryComponent() {
  const handleBetSelect = (team, odds) => {
    console.log(`Selected bet: ${team} with odds ${odds}`);
  };

  return (
    <div className="space-y-8 bg-gray-900 p-8">
      <div>
        <h2 className="mb-4 text-lg font-bold text-white">Football Match</h2>
        <MainComponent
          team1="PSG"
          team2="Marseille"
          date="15 Mars 2025"
          time="20:45"
          odds1="1.95"
          oddsDraw="3.40"
          odds2="3.80"
          onBetSelect={handleBetSelect}
        />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-bold text-white">Tennis Match</h2>
        <MainComponent
          team1="Nadal"
          team2="Djokovic"
          date="16 Mars 2025"
          time="15:00"
          odds1="2.10"
          odds2="1.75"
          onBetSelect={handleBetSelect}
        />
      </div>

      <style jsx global>{`
        @keyframes borderGlow {
          0% {
            box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
          }
          50% {
            box-shadow: 0 0 20px rgba(255, 215, 0, 0.2);
          }
          100% {
            box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
          }
        }

        .hover\:shadow-lg:hover {
          animation: borderGlow 2s infinite;
        }
      `}</style>
    </div>
  );
};
