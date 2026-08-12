"use client";

// src/app/casino/slots-pvp/page.jsx
//
// REDIRECT — the standalone "Slots Duel" lobby was merged into the main
// Slots entry point. The multiplayer lobby now lives at /casino/slots
// (1v1 Fruit Fortune matchmaking); this route just forwards there so old
// bookmarks / links keep working.
//
// NOTE: the live match view at /casino/slots-pvp/[matchId] is unaffected
// and still renders the in-game board.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SlotsPvpLobbyRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/casino/slots");
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
      <p className="text-sm text-white/60 animate-pulse">
        Redirecting to the Slots lobby…
      </p>
    </div>
  );
}
