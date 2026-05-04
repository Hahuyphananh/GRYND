"use client";

import { useEffect, useMemo, useState } from "react";
import NavigationBar from "../../components/navigation-bar";
import { useTranslation } from "../../hooks/useTranslation";

const TABS = ["weekly", "all-time", "wins"];

export default function LeaderboardPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("weekly");
  const [category, setCategory] = useState("level");
  const [items, setItems] = useState([]);
  const [me, setMe] = useState(null);

  const endpoint = useMemo(() => {
    if (tab === "weekly") return "/api/leaderboard/weekly?limit=20";
    if (tab === "wins") return "/api/leaderboard/wins?limit=20";
    return `/api/leaderboard/all-time?limit=20&category=${category}`;
  }, [tab, category]);

  useEffect(() => {
    const load = async () => {
      const res = await fetch(endpoint);
      const data = await res.json();
      setItems(data.items || []);
      setMe(data.me || null);
    };
    load();
  }, [endpoint]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] text-white">
      <NavigationBar currentPath="/classement" />
      <div className="mx-auto max-w-5xl px-4 py-24">
        <h1 className="mb-6 text-4xl font-bold">{t("leaderboard.title")}</h1>

        <div className="mb-6 flex gap-2">
          {TABS.map((x) => <button key={x} onClick={() => setTab(x)} className={`rounded px-4 py-2 ${tab === x ? "bg-yellow-300 text-black" : "bg-blue-900"}`}>{x === "wins" ? "Wins 💥" : x === "all-time" ? "All-Time" : "Weekly"}</button>)}
        </div>

        {tab === "all-time" && (
          <div className="mb-4 flex gap-2">
            {["level", "total_wagered", "biggest_win", "best_streak"].map((x) => (
              <button key={x} onClick={() => setCategory(x)} className={`rounded px-3 py-1 text-sm ${category === x ? "bg-cyan-300 text-black" : "bg-slate-800"}`}>{x}</button>
            ))}
          </div>
        )}

        <div className="rounded-lg bg-black/30 p-4">
          {tab !== "wins" ? (
            <table className="w-full">
              <thead><tr><th>#</th><th>User</th><th>Value</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.clerk_id}-${item.rank}`}><td>{item.rank}</td><td>{item.name}</td><td>{tab === "weekly" ? Number(item.weekly_wagered).toLocaleString() : category === "level" ? item.level : Number(item[category]).toLocaleString()}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="space-y-2">
              {items.map((w) => (
                <div key={w.id} className="flex items-center justify-between rounded bg-slate-900 p-3">
                  <div>{w.username} • {w.game}</div>
                  <div><span className="animate-pulse rounded bg-yellow-400 px-2 py-1 font-bold text-black">{Number(w.multiplier).toFixed(1)}x 💥</span> {Number(w.win_amount).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {me && <p className="mt-4 text-cyan-200">You are #{me.rank}</p>}
      </div>
    </div>
  );
}
