"use client";

import NavigationBar from "../../../components/navigation-bar";
import Link from "next/link";

const slotGames = [
  {
    id: "fruit",
    name: "🍒 Fruit Fortune",
    description: "Classic fruit slot with jackpots",
    path: "/casino/slots/fruits",
    preview: ["🍒", "🍋", "🍉"],
  },
  {
    id: "gems",
    name: "💎 Crystal Riches",
    description: "High-value gem symbols & big wins",
    path: "/casino/slots/gems",
    preview: ["💎", "🛡️", "👑"],
  },
  {
    id: "space",
    name: "🚀 Galaxy Slots",
    description: "Cosmic multipliers & sci-fi vibes",
    path: "/casino/slots/galaxy",
    preview: ["🌌", "🪐", "🚀"],
  },
];

const glowBySlot: Record<string, string> = {
  fruit: "shadow-[0_0_10px_rgba(255,215,0,0.6)]",
  gems: "shadow-[0_0_12px_rgba(255,255,255,0.75)]",
  space: "shadow-[0_0_14px_rgba(99,102,241,0.9)]",
};

export default function SlotsLobby() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#001A33] to-[#002B5B] text-white p-6">
      <NavigationBar currentPath="/slots" />

      {/* Title */}
      <h1 className="text-4xl font-extrabold text-yellow-400 text-center mt-24 mb-12 drop-shadow-[0_0_12px_gold]">
        🎰 SLOT MACHINE LOBBY 🎰
      </h1>

      {/* Slot Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
        {slotGames.map((slot) => (
          <Link key={slot.id} href={slot.path}>
            <div className="group cursor-pointer bg-[#030817] border-4 border-yellow-500 rounded-2xl p-6 shadow-[0_0_25px_gold] hover:scale-105 transition-transform">
              {/* Fake slot preview */}
              <div className="flex justify-center gap-2 mb-4">
               {slot.preview.map((icon, i) => (
  <div
    key={i}
    className={`w-14 h-14 flex items-center justify-center text-3xl bg-[#081a3d] border-2 border-yellow-300 rounded-lg transition-all duration-300 group-hover:shadow-[0_0_18px_rgba(255,255,255,0.9)]
${glowBySlot[slot.id]}
  group-hover:scale-110
`}

  >
    {icon}
  </div>
))}
              </div>

              <h2 className="text-2xl font-bold text-yellow-400 text-center mb-2">
                {slot.name}
              </h2>

              <p className="text-center text-sm text-gray-200 mb-4">
                {slot.description}
              </p>

              <div className="flex justify-center">
                <button className="bg-yellow-400 text-black font-bold px-6 py-2 rounded-full shadow hover:bg-yellow-500 animate-pulse">
                  PLAY
                </button>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
