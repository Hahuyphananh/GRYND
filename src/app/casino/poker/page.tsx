"use client";

import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";

// Landing page for /casino/poker. The previous 5-card Showdown ("Confrontation")
// mode has been removed; only Texas Hold'em (multiplayer) remains.
export default function PokerLandingPage() {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const [userTokens, setUserTokens] = useState(0);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (!cancelled && data?.success) setUserTokens(data.data.balance);
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#020108] via-[#0a0a1a] to-[#050510] pb-24 pt-20 md:pb-8 relative">
      <div
        className="fixed inset-0 pointer-events-none z-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,215,0,0.15) 2px, rgba(255,215,0,0.15) 4px)",
        }}
      />
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-4xl px-3 py-6 sm:px-4 sm:py-8 relative z-10">
        <h1 className="text-3xl sm:text-5xl font-black tracking-widest uppercase text-transparent bg-clip-text bg-gradient-to-r from-[#ffd700] via-amber-400 to-[#ffd700] text-center mb-2 drop-shadow-[0_0_12px_rgba(255,215,0,0.5)]">
          ♠ Poker Royale ♠
        </h1>
        <p className="text-sm text-[#ffd700]/60 text-center mb-4">
          Texas Hold'em Multiplayer
        </p>

        {isSignedIn && (
          <div className="flex items-center justify-center gap-2 mb-8">
            <span className="text-[#ffd700]/70 text-sm">🪙 Jetons :</span>
            <span className="text-lg font-bold text-[#ffd700] drop-shadow-[0_0_8px_rgba(255,215,0,0.4)]">
              {userTokens.toLocaleString()}
            </span>
          </div>
        )}

        <div className="flex justify-center mt-2 px-4">
          <button
            onClick={() => router.push("/casino/poker/multi")}
            className="w-full max-w-md rounded-2xl border-2 border-[#ff00cc]/40 bg-gradient-to-br from-[#ff00cc]/20 via-[#0d0020]/60 to-[#00e5ff]/15 px-6 py-6 text-lg font-black uppercase tracking-widest text-[#ffb0ff] hover:from-[#ff00cc]/35 hover:to-[#00e5ff]/30 active:scale-95 transition shadow-[0_0_30px_rgba(255,0,204,0.45)]"
          >
            Texas Hold'em ♦️
          </button>
        </div>

        <p className="text-center text-xs text-[#b0b0ff]/50 mt-6 max-w-md mx-auto">
          Affrontez jusqu'à 5 autres joueurs ou IA en parties privées ou publiques,
          avec classements et prix en jetons.
        </p>
      </div>
      <Footer />
    </div>
  );
}
