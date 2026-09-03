"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
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

const TABS = ["weekly", "all-time", "per-game", "daily-current", "daily-best", "weekly-streak", "weekly-best"];

// Per-game leaderboards (mirrors GAME_LEADERBOARD_KEYS in
// src/lib/leaderboardQueries.js).
const GAMES = [
  { key: "chess", label: "Chess" },
  { key: "four-in-a-row", label: "Four In A Row" },
  { key: "plinko", label: "Plinko" },
  { key: "roulette", label: "Roulette" },
  { key: "blackjack", label: "Blackjack" },
  { key: "mines", label: "Mines" },
  { key: "rps", label: "RPS" },
  { key: "uno", label: "UNO" },
  { key: "keno", label: "Keno" },
  { key: "crash", label: "Crash" },
  { key: "keno-duel", label: "Keno Duel" },
  { key: "mines-pvp", label: "Mines PvP" },
  { key: "lane-rush", label: "Lane Rush Duel" },
  { key: "memory-grid", label: "Memory Grid" },
  { key: "dice", label: "Dice" },
  { key: "pool", label: "Pool Masters" },
  { key: "hex-duel", label: "Hex Duel" },
  { key: "odds", label: "Odds" },
];

// Game-result categories the weekly/all-time boards rank by — tokens
// (wagered) and levels are intentionally dropped; the boards rank skill:
// games won/lost, win rate, volume, streaks and PvP wins.
const ALL_TIME_CATEGORIES = [
  "wins",
  "win_rate",
  "games",
  "best_streak",
  "pvp_wins",
  "net_wins",
  "win_loss_ratio",
  "current_streak",
  "biggest_win",
];
// No weekly PvP counter exists, so pvp_wins is all-time only.
const WEEKLY_CATEGORIES = ALL_TIME_CATEGORIES.filter((c) => c !== "pvp_wins");

const CATEGORY_LABELS = {
  wins: "Wins",
  win_rate: "Win Rate",
  games: "Games Played",
  best_streak: "Win Streak",
  pvp_wins: "PvP Wins",
  net_wins: "Net Wins",
  win_loss_ratio: "W/L Ratio",
  current_streak: "Current Streak",
  biggest_win: "Biggest Win",
};

// Win-rate boards only rank players with a real sample size (the query
// layer enforces the same floors).
const MIN_GAMES_FOR_WIN_RATE = { weekly: 5, "all-time": 10 };

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function isStreakTab(tab) {
  return (
    tab === "daily-current" ||
    tab === "daily-best" ||
    tab === "weekly-streak" ||
    tab === "weekly-best"
  );
}

function isPerGameTab(tab) {
  return tab === "per-game";
}

function getMetricValue(item, tab, category) {
  if (isStreakTab(tab)) {
    const field =
      tab === "daily-current"
        ? "daily_streak_current"
        : tab === "daily-best"
          ? "daily_streak_best"
          : tab === "weekly-streak"
            ? "weekly_streak_current"
            : "weekly_streak_best";
    return `${formatNumber(item[field])} days`;
  }

  const weekly = tab === "weekly";
  const field = (name) => item[weekly ? `weekly_${name}` : name];

  switch (category) {
    case "win_rate":
      return `${Number(field("win_rate") || 0).toFixed(2)}%`;
    case "wins":
      return formatNumber(field("wins"));
    case "games":
      return formatNumber(field("games"));
    case "best_streak":
      return formatNumber(field("best_streak"));
    case "pvp_wins":
      return formatNumber(item.pvp_wins);
    case "net_wins": {
      const v = Number(field("net_wins") || 0);
      return v > 0 ? `+${formatNumber(v)}` : formatNumber(v);
    }
    case "win_loss_ratio": {
      const wins = Number(field("wins") || 0);
      const losses = Number(field("losses") || 0);
      if (losses === 0) return `${wins}:0`;
      return `${(wins / losses).toFixed(1)}:1`;
    }
    case "current_streak":
      return formatNumber(field("current_streak"));
    case "biggest_win":
      return formatNumber(field("biggest_win"));
    default:
      return formatNumber(item[category]);
  }
}

/** Compact W-L record line shown under each player's name. */
function RecordLine({ item, weekly }) {
  const wins = Number(weekly ? item.weekly_wins : item.wins || 0);
  const losses = Number(weekly ? item.weekly_losses : item.losses || 0);
  const winRate = Number(weekly ? item.weekly_win_rate : item.win_rate || 0);
  const games = Number(weekly ? item.weekly_games : item.games || 0);
  const streak = Number(
    weekly ? item.weekly_current_streak : item.current_streak || 0,
  );
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-cyan-200/80">
      <span>
        <span className="font-semibold text-green-300">
          {formatNumber(wins)}W
        </span>{" "}
        <span className="font-semibold text-red-300/90">
          {formatNumber(losses)}L
        </span>
      </span>
      <span>{winRate.toFixed(0)}% win</span>
      <span>{formatNumber(games)} games</span>
      {streak > 0 && (
        <span className="text-[#f5ff3b]/90">
          <span aria-hidden>🔥</span> {formatNumber(streak)} streak
        </span>
      )}
    </div>
  );
}

export default function LeaderboardPage() {
  const { t } = useTranslation();
  const weeklyCountdown = useWeeklyCountdown();
  const [tab, setTab] = useState("weekly");
  const [category, setCategory] = useState("wins");
  const [game, setGame] = useState("chess");

  const selectTab = (next) => {
    setTab(next);
    // pvp_wins is all-time only — fall back to the headline metric on the
    // weekly board (and on tabs with no categories).
    if (next !== "all-time" && category === "pvp_wins") setCategory("wins");
  };
  // Per-game boards always rank by wins.
  const displayCategory = isPerGameTab(tab) ? "wins" : category;
  const [items, setItems] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [myStats, setMyStats] = useState(null);
  const [error, setError] = useState(null);

  const endpoint = useMemo(() => {
    if (tab === "weekly")
      return `/api/leaderboard/weekly?limit=50&category=${category}`;
    if (tab === "per-game")
      return `/api/leaderboard/game?game=${game}&limit=50`;
    if (tab === "daily-current")
      return `/api/leaderboard/daily-streak?type=current&limit=50`;
    if (tab === "daily-best")
      return `/api/leaderboard/daily-streak?type=best&limit=50`;
    if (tab === "weekly-streak")
      return `/api/leaderboard/daily-streak?type=weekly-current&limit=50`;
    if (tab === "weekly-best")
      return `/api/leaderboard/daily-streak?type=weekly-best&limit=50`;
    return `/api/leaderboard/all-time?limit=50&category=${category}`;
  }, [tab, category, game]);

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
    <div className="relative min-h-screen text-[#c9f7ff]">
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/classement" />
      <div className="mx-auto max-w-6xl px-6 py-24">
        <h1 className="mb-6 text-center text-4xl font-bold text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)]">
          {t("leaderboard.title")}
        </h1>

        {tab === "weekly" && weeklyCountdown && (
          <div className="mb-4 flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-lg border border-[#f5ff3b]/40 bg-[#0a214d]/90 px-4 py-2 text-sm">
              <svg className="w-4 h-4 inline text-[#00e5ff]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              <span className="text-gray-300">Weekly reset in:</span>
              <span className="font-mono font-bold text-[#f5ff3b]">{weeklyCountdown}</span>
            </div>
          </div>
        )}

        <div className="mb-6 flex flex-wrap justify-center gap-3">
          {TABS.map((x) => (
            <button
              key={x}
              onClick={() => selectTab(x)}
              className={`rounded-lg border px-5 py-2 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] ${tab === x ? "border-[#f5ff3b]/60 bg-[#f5ff3b] text-[#041125]" : "border-[#00e5ff]/50 bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"}`}
            >
              {x === "weekly"
                ? "Weekly"
                : x === "all-time"
                  ? "All-Time"
                  : x === "daily-current"
                    ? <span>Daily Streak <svg className="w-4 h-4 inline text-amber-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z"/></svg></span>
                    : x === "daily-best"
                      ? <span>Best Streak <svg className="w-4 h-4 inline text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2Z"/></svg></span>
                      : x === "weekly-streak"
                        ? <span>Weekly Streak <svg className="w-4 h-4 inline text-[#00e5ff]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></span>
                        : <span>Weekly Best <svg className="w-4 h-4 inline text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2Z"/></svg></span>}
            </button>
          ))}
        </div>

        {isPerGameTab(tab) ? (
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            {GAMES.map((g) => (
              <button
                key={g.key}
                onClick={() => setGame(g.key)}
                className={`rounded-md px-4 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] ${game === g.key ? "bg-[#f5ff3b] text-[#06152c]" : "bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        ) : (
          !isStreakTab(tab) && (
            <div className="mb-4 flex flex-wrap justify-center gap-2">
              {(tab === "weekly" ? WEEKLY_CATEGORIES : ALL_TIME_CATEGORIES).map((x) => (
                <button
                  key={x}
                  onClick={() => setCategory(x)}
                  className={`rounded-md px-4 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] ${category === x ? "bg-[#f5ff3b] text-[#06152c]" : "bg-[#0a214d] text-[#00e5ff]"}`}
                >
                  {CATEGORY_LABELS[x]}
                </button>
              ))}
            </div>
          )
        )}

        {!isStreakTab(tab) && !isPerGameTab(tab) && category === "win_rate" && (
          <p className="mb-4 text-center text-xs text-cyan-200/70">
            Win-rate board — players with at least{" "}
            <span className="font-bold text-[#f5ff3b]">
              {tab === "weekly" ? MIN_GAMES_FOR_WIN_RATE.weekly : MIN_GAMES_FOR_WIN_RATE["all-time"]} games
            </span>{" "}
            played this {tab === "weekly" ? "week" : "season"} only.
          </p>
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
              <motion.table
                key={isPerGameTab(tab) ? `${tab}-${game}` : `${tab}-${category}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="w-full border-collapse text-left"
              >
                <thead>
                  <tr className="border-b border-[#00e5ff]/50 text-[#f5ff3b]">
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">User</th>
                    <th className="px-3 py-2">
                      {isStreakTab(tab)
                        ? "Days"
                        : isPerGameTab(tab)
                          ? "Wins"
                          : CATEGORY_LABELS[category]}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr
                      key={`${item.clerk_id}-${item.rank}`}
                      className={`border-b border-[#00e5ff]/20 ${i % 2 ? "bg-[#08142f]" : "bg-[#0b224f]"} hover:bg-white/10 transition-colors`}
                    >
                      <td className="px-3 py-3 font-bold text-[#00e5ff]">
                        {item.rank}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-semibold">
                          <Link
                            href={`/profil/${encodeURIComponent(item.clerk_id)}`}
                            className="hover:text-[#00e5ff] hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] rounded"
                          >
                            {item.user?.name || item.name}
                          </Link>
                          {item.prestigeBadge && (
                            <span className="ml-2 rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-300">
                              {item.prestigeBadge}
                            </span>
                          )}
                        </div>
                        {/* W-L record line — weekly/all-time boards and the
                            streak tabs all return the mini stats. */}
                        <RecordLine
                          item={item}
                          weekly={tab === "weekly"}
                        />
                      </td>
                      <td className="px-3 py-3 text-right font-bold text-green-300 sm:text-left">
                        {getMetricValue(item, tab, displayCategory)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </motion.table>
            </AnimatePresence>
          )}
        </div>

        {(me || myStats) && (
          <div className="mx-auto mt-6 max-w-xl rounded-lg border border-[#00e5ff]/50 bg-[#0a214d]/90 p-5 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-[#f5ff3b]">
                Your stats
              </h2>
              {me && (
                <span className="rounded-md border border-[#f5ff3b]/50 bg-[#f5ff3b]/10 px-3 py-1 text-sm font-bold text-[#f5ff3b]">
                  Rank #{me.rank}
                </span>
              )}
            </div>

            {myStats ? (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="rounded-md bg-[#08142f]/80 px-3 py-2 text-center">
                    <div className="text-lg font-bold text-green-300">
                      {formatNumber(myStats.gamesWon)}W{" "}
                      <span className="text-red-300/90">{formatNumber(myStats.gamesLost)}L</span>
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Games won / lost</div>
                  </div>
                  <div className="rounded-md bg-[#08142f]/80 px-3 py-2 text-center">
                    <div className="text-lg font-bold text-[#00e5ff]">
                      {Number(myStats.gameWinRate || 0).toFixed(1)}%
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Win rate</div>
                  </div>
                  <div className="rounded-md bg-[#08142f]/80 px-3 py-2 text-center">
                    <div className="text-lg font-bold">
                      {formatNumber(myStats.gamesPlayed)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Games played</div>
                  </div>
                  <div className="rounded-md bg-[#08142f]/80 px-3 py-2 text-center">
                    <div className="text-lg font-bold text-[#f5ff3b]">
                      {formatNumber(myStats.currentStreak)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Current win streak</div>
                  </div>
                  <div className="rounded-md bg-[#08142f]/80 px-3 py-2 text-center">
                    <div className="text-lg font-bold text-[#f5ff3b]">
                      {formatNumber(myStats.bestStreak)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Best win streak</div>
                  </div>
                  <div className="rounded-md bg-[#08142f]/80 px-3 py-2 text-center">
                    <div className="truncate text-sm font-bold">
                      {myStats.favoriteGame || "N/A"}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Favorite game</div>
                  </div>
                </div>
                {Number(myStats.biggestWin || 0) > 0 && (
                  <p className="mt-3 text-center text-xs text-cyan-200/80">
                    Biggest win:{" "}
                    <span className="font-bold text-green-300">
                      {formatNumber(myStats.biggestWin)} tokens
                    </span>
                  </p>
                )}
              </>
            ) : (
              <p className="text-center text-sm text-cyan-200/70">
                Sign in to see your full stats.
              </p>
            )}
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}
