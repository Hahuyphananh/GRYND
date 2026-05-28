"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { useTranslation } from "../../hooks/useTranslation";

function getNextMondayReset() {
  const now = new Date();
  const day = now.getUTCDay();
  // Days until next Monday (Monday = 1, so if today is Monday it's 7 days, otherwise days until Monday)
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const nextMonday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntilMonday,
    0, 0, 0, 0
  ));
  return nextMonday;
}

function useWeeklyCountdown() {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function update() {
      const now = Date.now();
      const reset = getNextMondayReset().getTime();
      const diff = reset - now;

      if (diff <= 0) {
        setTimeLeft("Resetting...");
        return;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      const parts = [];
      if (days > 0) parts.push(`${days}d`);
      parts.push(`${String(hours).padStart(2, "0")}h`);
      parts.push(`${String(minutes).padStart(2, "0")}m`);
      parts.push(`${String(seconds).padStart(2, "0")}s`);
      setTimeLeft(parts.join(" "));
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  return timeLeft;
}

const TABS = ["weekly", "all-time", "daily-current", "daily-best", "weekly-streak", "weekly-best", "wins"];
const LEADERBOARD_CATEGORIES = [
  "level",
  "total_wagered",
  "biggest_win",
  "best_streak",
  "win_rate",
];

function getMetricValue(item, tab, category) {
  if (tab === "weekly") {
    if (category === "level")
      return Number(item.weekly_level_gain || 0).toLocaleString();
    if (category === "win_rate")
      return `${Number(item.weekly_win_rate || 0).toFixed(2)}%`;
    const weeklyMetric = `weekly_${category}`;
    return Number(item[weeklyMetric] || 0).toLocaleString();
  }

  if (tab === "daily-current") {
    return `${Number(item.daily_streak_current || 0).toLocaleString()} days 🔥`;
  }
  if (tab === "daily-best") {
    return `${Number(item.daily_streak_best || 0).toLocaleString()} days 🏆`;
  }
  if (tab === "weekly-streak") {
    return `${Number(item.weekly_streak_current || 0).toLocaleString()} days 📅`;
  }
  if (tab === "weekly-best") {
    return `${Number(item.weekly_streak_best || 0).toLocaleString()} days 🏆`;
  }

  if (category === "level")
    return `${Number(item.level || 0).toLocaleString()} (${Number(item.xp || 0).toLocaleString()} XP)`;
  if (category === "win_rate")
    return `${Number(item.win_rate || 0).toFixed(2)}%`;
  return Number(item[category] || 0).toLocaleString();
}

export default function LeaderboardPage() {
  const { t } = useTranslation();
  const weeklyCountdown = useWeeklyCountdown();
  const [tab, setTab] = useState("weekly");
  const [category, setCategory] = useState("level");
  const [items, setItems] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [myStats, setMyStats] = useState(null);
  const [error, setError] = useState(null);

  const endpoint = useMemo(() => {
    if (tab === "weekly")
      return `/api/leaderboard/weekly?limit=50&category=${category}`;
    if (tab === "daily-current")
      return `/api/leaderboard/daily-streak?type=current&limit=50`;
    if (tab === "daily-best")
      return `/api/leaderboard/daily-streak?type=best&limit=50`;
    if (tab === "weekly-streak")
      return `/api/leaderboard/daily-streak?type=weekly-current&limit=50`;
    if (tab === "weekly-best")
      return `/api/leaderboard/daily-streak?type=weekly-best&limit=50`;
    if (tab === "wins") return "/api/leaderboard/wins?limit=50";
    return `/api/leaderboard/all-time?limit=50&category=${category}`;
  }, [tab, category]);

  useEffect(() => {
    const safeJson = async (response) => {
      const text = await response.text();
      if (!text) return {};

      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    };

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        await fetch("/api/get-bet-history").catch(() => null);
        const [res, statsRes] = await Promise.all([
          fetch(endpoint),
          fetch("/api/user/stats"),
        ]);
        const [data, statsData] = await Promise.all([
          safeJson(res),
          safeJson(statsRes),
        ]);

        if (!res.ok) setError(data.error || t("leaderboard.load_error"));

        setItems(Array.isArray(data.items) ? data.items : []);
        setMe(data.me || null);
        setMyStats(statsData.userStats || null);
      } catch {
        setItems([]);
        setMe(null);
        setError(t("leaderboard.load_error"));
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [endpoint]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] text-[#c9f7ff]">
      <NavigationBar currentPath="/classement" />
      <div className="mx-auto max-w-6xl px-6 py-24">
        <h1 className="mb-6 text-center text-4xl font-bold text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)]">
          {t("leaderboard.title")}
        </h1>

        {tab === "weekly" && weeklyCountdown && (
          <div className="mb-4 flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-lg border border-[#f5ff3b]/40 bg-[#0a214d]/90 px-4 py-2 text-sm">
              <span className="text-[#00e5ff]">⏳</span>
              <span className="text-gray-300">Weekly reset in:</span>
              <span className="font-mono font-bold text-[#f5ff3b]">{weeklyCountdown}</span>
            </div>
          </div>
        )}

        <div className="mb-6 flex flex-wrap justify-center gap-3">
          {TABS.map((x) => (
            <button
              key={x}
              onClick={() => setTab(x)}
              className={`rounded-lg border px-5 py-2 text-sm font-semibold transition-all ${tab === x ? "border-[#f5ff3b]/60 bg-[#f5ff3b] text-[#041125]" : "border-[#00e5ff]/50 bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"}`}
            >                {x === "wins"
                ? "Wins 💥"
                : x === "all-time"
                  ? "All-Time"
                  : x === "daily-current"
                    ? "Daily Streak 🔥"
                    : x === "daily-best"
                      ? "Best Streak 🏆"
                      : x === "weekly-streak"
                        ? "Weekly Streak 📅"
                        : x === "weekly-best"
                          ? "Weekly Best 🏆"
                          : "Weekly"}
            </button>
          ))}
        </div>

        {tab !== "wins" && tab !== "daily-current" && tab !== "daily-best" && tab !== "weekly-streak" && tab !== "weekly-best" && (
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            {LEADERBOARD_CATEGORIES.map((x) => (
              <button
                key={x}
                onClick={() => setCategory(x)}
                className={`rounded-md px-4 py-2 text-xs font-semibold ${category === x ? "bg-[#f5ff3b] text-[#06152c]" : "bg-[#0a214d] text-[#00e5ff]"}`}
              >
                {x}
              </button>
            ))}
          </div>
        )}

        <div className="w-full overflow-hidden rounded-lg border border-[#00e5ff]/50 bg-[#08142f]/95 p-4 shadow-[0_0_28px_rgba(0,229,255,0.2)]">
          {error && (
            <div className="mb-4 rounded-md border border-red-400/40 bg-red-950/40 px-4 py-3 text-center text-sm text-red-200">
              {error}
            </div>
          )}
          {loading ? (
            <div className="py-8 text-center text-[#00e5ff]">
              {t("ui.loading")}
            </div>
          ) : (
            <AnimatePresence mode="wait">
              {tab !== "wins" ? (
                <motion.table
                  key={`${tab}-${category}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="w-full border-collapse text-left"
                >
                  <thead>
                    <tr className="border-b border-[#00e5ff]/50 text-[#f5ff3b]">
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">User</th>
                      <th className="px-3 py-2">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr
                        key={`${item.clerk_id}-${item.rank}`}
                        className={`border-b border-[#00e5ff]/20 ${i % 2 ? "bg-[#08142f]" : "bg-[#0b224f]"}`}
                      >
                        <td className="px-3 py-3 font-bold text-[#00e5ff]">
                          {item.rank}
                        </td>
                        <td className="px-3 py-3 font-semibold">
                          {item.user?.name || item.name}
                        </td>
                        <td className="px-3 py-3 text-green-300">
                          {getMetricValue(item, tab, category)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </motion.table>
              ) : (
                <motion.div
                  key="wins"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-2"
                >
                  {items.map((w) => (
                    <div
                      key={`${w.clerk_id}-${w.rank}`}
                      className="flex items-center justify-between rounded-md border border-[#00e5ff]/30 bg-[#0b224f] p-3"
                    >
                      <div className="font-semibold text-gray-100">
                        #{w.rank} • {w.user?.name || w.name}
                      </div>
                      <div className="text-right">
                        <span className="animate-pulse rounded bg-[#f5ff3b] px-2 py-1 font-bold text-[#041125]">
                          Gross Wins 💥
                        </span>
                        <div className="mt-1 text-green-300">
                          {Number(w.total_won || 0).toLocaleString()}
                        </div>
                        <div className="text-xs text-cyan-200">
                          {Number(w.wins || 0).toLocaleString()} wins
                        </div>
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>

        {me && (
          <p className="mt-5 text-center text-[#00e5ff]">
            You are <span className="font-bold text-[#f5ff3b]">#{me.rank}</span>
          </p>
        )}
        {myStats && (
          <p className="mt-2 text-center text-cyan-200 text-sm">
            Wagering Streak: {myStats.currentStreak} (best {myStats.bestStreak}) •
            Winrate: {Number(myStats.winRate || 0).toFixed(2)}%
          </p>
        )}
      </div>
      <Footer />
    </div>
  );
}
