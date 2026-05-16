"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import { useTranslation } from "../../../hooks/useTranslation";

export default function TerritoriesLobbyPage() {
  const { t } = useTranslation();

  const tx = {
    balance: t("games.balance"),
    betAmount: t("games.bet_amount"),
    createGame: t("games.create_game"),
    playVsAi: t("games.play_vs_ai"),
    availableGames: t("games.available_games"),
    refresh: t("sports.refresh"),
    noOpenGames: t("games.no_open_games"),
    game: t("games.game_label"),
    bet: t("sports.stake"),
    join: t("games.join"),
  };
  const router = useRouter();
  const [wagerAmount, setWagerAmount] = useState(10);
  const [balance, setBalance] = useState(0);
  const [availableGames, setAvailableGames] = useState<any[]>([]);

  const fetchBalance = async () => {
    const res = await fetch("/api/get-user-tokens", { method: "POST", credentials: "include" });
    const data = await res.json();
    if (data?.success) setBalance(Number(data.data.balance || 0));
  };

  const fetchGames = async () => {
    const res = await fetch("/api/neon-territory/available-games", { cache: "no-store" });
    const data = await res.json();
    setAvailableGames(data.games || []);
  };

  useEffect(() => {
    fetchBalance();
    fetchGames();
    const id = setInterval(fetchGames, 3000);
    return () => clearInterval(id);
  }, []);

  const createGame = async () => {
    const res = await fetch("/api/neon-territory/create-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wagerAmount }),
    });
    const data = await res.json();
    if (data?.gameId) router.push(`/casino/territories/game/${data.gameId}`);
    else alert(data?.error || "Could not create game");
  };

  const playVsAI = async () => {
    router.push(`/casino/territories/game/ai?bet=${wagerAmount}`);
  };

  const joinGame = async (gameId: string) => {
    const res = await fetch("/api/neon-territory/join-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId }),
    });
    const data = await res.json();
    if (data?.gameId) router.push(`/casino/territories/game/${data.gameId}`);
    else alert(data?.error || "Could not join game");
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#020817] via-[#041430] to-[#02050f] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto max-w-5xl rounded-2xl border border-cyan-400/30 bg-[#07112c]/70 p-5 shadow-[0_0_30px_rgba(0,229,255,0.18)]">
        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-blue-500">{t("games.territories_name")}</h1>
        <p className="mt-1 text-cyan-100/90">{t("games.territories_desc")}</p>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-cyan-400/30 bg-black/25 p-4 md:col-span-1">
            <p>{tx.balance}: <span className="font-bold text-yellow-300">{balance.toFixed(2)}</span></p>
            <label className="mt-3 block text-sm">{tx.betAmount}</label>
            <input type="number" min={1} value={wagerAmount} onChange={(e) => setWagerAmount(Number(e.target.value))} className="mt-1 w-full rounded bg-slate-900 p-2" />
            <button onClick={createGame} className="mt-3 w-full rounded bg-gradient-to-r from-cyan-400 to-blue-500 p-2 font-bold text-black">{tx.createGame}</button>
            <button onClick={playVsAI} className="mt-2 w-full rounded bg-gradient-to-r from-fuchsia-400 to-blue-500 p-2 font-bold text-black">{tx.playVsAi}</button>
          </div>

          <div className="rounded-xl border border-cyan-400/30 bg-black/25 p-4 md:col-span-2">
            <div className="mb-2 flex items-center justify-between"><h2 className="text-xl font-bold">{tx.availableGames}</h2><button className="rounded bg-cyan-500 px-2 py-1 text-black" onClick={fetchGames}>{tx.refresh}</button></div>
            {availableGames.length === 0 ? <p className="text-slate-300">{tx.noOpenGames}</p> : (
              <div className="space-y-2">
                {availableGames.map((g) => (
                  <div key={g.id} className="flex items-center justify-between rounded border border-cyan-700/40 p-3">
                    <div><p>{tx.game} #{g.id.slice(0, 8)}</p><p className="text-xs text-slate-300">{tx.bet}: {g.wagerAmount}</p></div>
                    <button onClick={() => joinGame(g.id)} className="rounded bg-cyan-400 px-3 py-1 font-bold text-black">{tx.join}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
