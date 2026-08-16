"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../components/navigation-bar";
import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";
import { PoolBallIcon } from "../icons/CustomIcons";

export default function PoolMastersClient() {
  const router = useRouter();
  const posthog = usePostHog();

  useEffect(() => {
    posthog?.capture("pool_masters_lobby_viewed");
  }, []);
  return (
    <div className="mx-auto max-w-5xl rounded-2xl border border-cyan-400/40 bg-black/30 p-6 shadow-[0_0_30px_rgba(34,211,238,.25)]">
      <NavigationBar currentPath="/casino" />
      <h2 className="mt-3 flex items-center justify-center gap-3 text-4xl font-black text-fuchsia-300">
        <PoolBallIcon size={32} className="text-cyan-300" /> Pool Masters
      </h2>
      <p className="mt-2 text-cyan-100">
        Play multiplayer or challenge the AI in a full pool-table experience.
      </p>
      <div className="mt-6 rounded-xl border border-cyan-500/40 bg-[#021a14] p-5">
        <h3 className="text-xl font-bold">Lobby</h3>
        <p className="mt-1 text-sm text-cyan-100/90">
          Create or join a game before jumping into the table.
        </p>
        <button
          onClick={() => router.push("/casino/pool-masters")}
          className="mt-4 rounded bg-fuchsia-500 px-4 py-2 font-bold text-black"
        >
          Open Pool Lobby
        </button>
      </div>
    </div>
  );
}
