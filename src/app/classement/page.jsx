"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../components/navigation-bar";
import { useTranslation } from "../../hooks/useTranslation";

const TABS = ["weekly", "all-time", "wins"];

export default function LeaderboardPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("weekly");
  const [category, setCategory] = useState("level");
  const [items, setItems] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [myStats, setMyStats] = useState(null);

  const endpoint = useMemo(() => {
    if (tab === "weekly") return "/api/leaderboard/weekly?limit=50";
    if (tab === "wins") return "/api/leaderboard/wins?limit=50";
    return `/api/leaderboard/all-time?limit=50&category=${category}`;
  }, [tab, category]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetch("/api/get-bet-history");
      const [res, statsRes] = await Promise.all([fetch(endpoint), fetch("/api/user/stats")]);
      const data = await res.json();
      const statsData = await statsRes.json();
      setItems(data.items || []);
      setMe(data.me || null);
      setMyStats(statsData.userStats || null);
      setLoading(false);
    };
    load();
  }, [endpoint]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] text-[#c9f7ff]">
      <NavigationBar currentPath="/classement" />
      <div className="mx-auto max-w-6xl px-6 py-24">
        <h1 className="mb-6 text-center text-4xl font-bold text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)]">{t("leaderboard.title")}</h1>

        <div className="mb-6 flex flex-wrap justify-center gap-3">
          {TABS.map((x) => (
            <button key={x} onClick={() => setTab(x)} className={`rounded-lg border px-5 py-2 text-sm font-semibold transition-all ${tab === x ? "border-[#f5ff3b]/60 bg-[#f5ff3b] text-[#041125]" : "border-[#00e5ff]/50 bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"}`}>
              {x === "wins" ? "Wins 💥" : x === "all-time" ? "All-Time" : "Weekly"}
            </button>
          ))}
        </div>

        {tab === "all-time" && (
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            {["level", "total_wagered", "biggest_win", "best_streak", "win_rate"].map((x) => (
              <button key={x} onClick={() => setCategory(x)} className={`rounded-md px-4 py-2 text-xs font-semibold ${category === x ? "bg-[#f5ff3b] text-[#06152c]" : "bg-[#0a214d] text-[#00e5ff]"}`}>{x}</button>
            ))}
          </div>
        )}

        <div className="w-full overflow-hidden rounded-lg border border-[#00e5ff]/50 bg-[#08142f]/95 p-4 shadow-[0_0_28px_rgba(0,229,255,0.2)]">
          {loading ? <div className="py-8 text-center text-[#00e5ff]">{t("ui.loading")}</div> : (
            <AnimatePresence mode="wait">
              {tab !== "wins" ? (
                <motion.table key={`${tab}-${category}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-[#00e5ff]/50 text-[#f5ff3b]"><th className="px-3 py-2">#</th><th className="px-3 py-2">User</th><th className="px-3 py-2">Value</th></tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={`${item.clerk_id}-${item.rank}`} className={`border-b border-[#00e5ff]/20 ${i % 2 ? "bg-[#08142f]" : "bg-[#0b224f]"}`}>
                        <td className="px-3 py-3 font-bold text-[#00e5ff]">{item.rank}</td><td className="px-3 py-3 font-semibold">{item.name}</td>
                        <td className="px-3 py-3 text-green-300">{tab === "weekly" ? Number(item.weekly_wagered).toLocaleString() : category === "level" ? item.level : category === "win_rate" ? `${Number(item.win_rate || 0).toFixed(2)}%` : Number(item[category]).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </motion.table>
              ) : (
                <motion.div key="wins" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
                  {items.map((w) => (
                    <div key={w.id} className="flex items-center justify-between rounded-md border border-[#00e5ff]/30 bg-[#0b224f] p-3">
                      <div className="font-semibold text-gray-100">{w.username} • {w.game}</div>
                      <div className="text-right"><span className="animate-pulse rounded bg-[#f5ff3b] px-2 py-1 font-bold text-[#041125]">{Number(w.multiplier).toFixed(1)}x 💥</span><div className="mt-1 text-green-300">{Number(w.win_amount).toLocaleString()}</div></div>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>

        {me && <p className="mt-5 text-center text-[#00e5ff]">You are <span className="font-bold text-[#f5ff3b]">#{me.rank}</span></p>}
        {myStats && <p className="mt-2 text-center text-cyan-200 text-sm">Streak: {myStats.currentStreak} (best {myStats.bestStreak}) • Winrate: {Number(myStats.winRate || 0).toFixed(2)}%</p>}
      </div>
    </div>
  );
}
