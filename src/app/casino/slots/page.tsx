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
];

const glowBySlot: Record<string, string> = {
  fruit: "shadow-[0_0_10px_rgba(255,215,0,0.6)]",
};

export default function SlotsLobby() {
  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/slots" />

      {/* Title */}
      <h1 className="mb-8 mt-4 text-center text-3xl font-extrabold text-yellow-400 drop-shadow-[0_0_12px_gold] sm:mb-12 sm:text-4xl">
        🎰 SLOT MACHINE LOBBY 🎰
      </h1>

      {/* Single Slot Card */}
      <div className="max-w-xl mx-auto">
        {slotGames.map((slot) => (
          <Link key={slot.id} href={slot.path}>
            <div className="group cursor-pointer bg-[#0b224f]/85 border-2 border-[#00e5ff]/40 rounded-2xl p-8 shadow-[0_0_25px_rgba(0,229,255,0.2)] hover:scale-105 transition-transform">
              {/* Preview */}
              <div className="flex justify-center gap-3 mb-5">
                {slot.preview.map((icon, i) => (
                  <div
                    key={i}
                    className={`w-16 h-16 flex items-center justify-center text-4xl bg-[#081a3d] border-2 border-yellow-300 rounded-lg transition-all duration-300 group-hover:shadow-[0_0_18px_rgba(255,255,255,0.9)] ${glowBySlot[slot.id]} group-hover:scale-110`}
                  >
                    {icon}
                  </div>
                ))}
              </div>

              <h2 className="text-3xl font-bold text-yellow-400 text-center mb-3">
                {slot.name}
              </h2>

              <p className="text-center text-gray-200 mb-6">
                {slot.description}
              </p>

              <div className="flex justify-center">
                <button className="bg-[#FFD700] text-[#030817] font-bold px-8 py-3 rounded-full shadow-[0_0_16px_rgba(255,215,0,0.45)] hover:bg-[#ffe14f] animate-pulse">
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
