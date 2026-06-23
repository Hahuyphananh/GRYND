"use client";

// ── Casino-grid entry wrapper for the Precision game ────────────────────
//
// Mirrors PoolMastersClient.tsx so the casino can link into the game
// without the underlying lobby page having to mount on the casino index.

import { useRouter } from "next/navigation";
import NavigationBar from "../navigation-bar";
import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";

export default function PrecisionLobbyClient() {
  const router = useRouter();
  const posthog = usePostHog();

  useEffect(() => {
    posthog?.capture("precision_lobby_viewed");
  }, []);

  return (
    <div className="mx-auto max-w-5xl rounded-2xl border border-cyan-400/40 bg-black/30 p-6 shadow-[0_0_30px_rgba(34,211,238,.25)]">
      <NavigationBar currentPath="/casino" />
      <h2 className="mt-3 text-4xl font-black text-fuchsia-300">🎯 Precision</h2>
      <p className="mt-2 text-cyan-100">
        Wager tokens and face another player in a fast-paced precision duel.
      </p>
      <div className="mt-6 rounded-xl border border-cyan-500/40 bg-[#02141a] p-5">
        <h3 className="text-xl font-bold">Lobby</h3>
        <p className="mt-1 text-sm text-cyan-100/90">
          Create or join a game before stepping up to the duel.
        </p>
        <button
          onClick={() => router.push("/casino/precision")}
          className="mt-4 rounded bg-fuchsia-500 px-4 py-2 font-bold text-black"
        >
          Open Precision Lobby
        </button>
      </div>
    </div>
  );
}
