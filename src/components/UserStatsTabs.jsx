"use client";

import { useState } from "react";

// Tabbed stat panel for the profile pages. Mirrors the leaderboard boards:
//   - Record: games won/lost, win rate, games played, net wins, W/L ratio,
//     PvP wins, biggest win and win streaks (all-time categories)
//   - Weekly: the weekly equivalents (no weekly PvP counter exists)
//   - Streaks: daily / weekly login streaks (the leaderboard streak tabs)
//
// `record` is the leaderboard-style record returned by the profile API
// routes (same source the leaderboard boards read: user_stats + users).
const TABS = [
  { key: "record", label: "Record" },
  { key: "weekly", label: "Weekly" },
  { key: "streaks", label: "Streaks" },
];

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function StatTile({ label, value, valueClass = "text-white" }) {
  return (
    <div className="rounded-lg border border-[#00e5ff]/30 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-wider text-gray-300">{label}</p>
      <p className={`mt-1 text-xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function recordTiles(record) {
  const wins = Number(record.wins || 0);
  const losses = Number(record.losses || 0);
  const netWins = wins - losses;
  const ratio =
    losses > 0
      ? `${(wins / losses).toFixed(1)}:1`
      : wins > 0
        ? `${wins}:0`
        : "0:0";

  return [
    { label: "Games Won", value: formatNumber(wins), valueClass: "text-green-300" },
    { label: "Games Lost", value: formatNumber(losses), valueClass: "text-red-300/90" },
    { label: "Win Rate", value: `${Number(record.winRate || 0).toFixed(1)}%` },
    { label: "Games Played", value: formatNumber(record.games) },
    {
      label: "Net Wins",
      value: netWins > 0 ? `+${formatNumber(netWins)}` : formatNumber(netWins),
      valueClass: netWins >= 0 ? "text-green-300" : "text-red-300/90",
    },
    { label: "W/L Ratio", value: ratio },
    { label: "PvP Wins", value: formatNumber(record.pvpWins) },
    { label: "Biggest Win", value: formatNumber(record.biggestWin) },
    { label: "Best Win Streak", value: formatNumber(record.bestStreak), valueClass: "text-[#f5ff3b]" },
    { label: "Current Streak", value: formatNumber(record.currentStreak), valueClass: "text-[#f5ff3b]" },
  ];
}

function weeklyTiles(record) {
  const wins = Number(record.weeklyWins || 0);
  const losses = Number(record.weeklyLosses || 0);
  const netWins = wins - losses;
  const ratio =
    losses > 0
      ? `${(wins / losses).toFixed(1)}:1`
      : wins > 0
        ? `${wins}:0`
        : "0:0";

  return [
    { label: "Weekly Wins", value: formatNumber(wins), valueClass: "text-green-300" },
    { label: "Weekly Losses", value: formatNumber(losses), valueClass: "text-red-300/90" },
    { label: "Weekly Win Rate", value: `${Number(record.weeklyWinRate || 0).toFixed(1)}%` },
    { label: "Weekly Games", value: formatNumber(wins + losses) },
    {
      label: "Weekly Net Wins",
      value: netWins > 0 ? `+${formatNumber(netWins)}` : formatNumber(netWins),
      valueClass: netWins >= 0 ? "text-green-300" : "text-red-300/90",
    },
    { label: "Weekly W/L Ratio", value: ratio },
    { label: "Weekly Best Streak", value: formatNumber(record.weeklyBestStreak), valueClass: "text-[#f5ff3b]" },
    { label: "Weekly Current Streak", value: formatNumber(record.weeklyCurrentStreak), valueClass: "text-[#f5ff3b]" },
    { label: "Weekly Biggest Win", value: formatNumber(record.weeklyBiggestWin) },
  ];
}

function streakTiles(record) {
  return [
    { label: "Daily Streak", value: `${formatNumber(record.dailyStreakCurrent)} days`, valueClass: "text-amber-300" },
    { label: "Daily Best", value: `${formatNumber(record.dailyStreakBest)} days`, valueClass: "text-amber-300" },
    { label: "Weekly Streak", value: `${formatNumber(record.weeklyStreakCurrent)} days`, valueClass: "text-[#00e5ff]" },
    { label: "Weekly Best", value: `${formatNumber(record.weeklyStreakBest)} days`, valueClass: "text-[#00e5ff]" },
  ];
}

export default function UserStatsTabs({ record }) {
  const [tab, setTab] = useState("record");

  if (!record) {
    return (
      <p className="py-4 text-center text-sm text-gray-400">
        No stats yet — play some games to build your record.
      </p>
    );
  }

  const tiles =
    tab === "record"
      ? recordTiles(record)
      : tab === "weekly"
        ? weeklyTiles(record)
        : streakTiles(record);

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-4 py-1.5 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b224f] ${
              tab === t.key
                ? "bg-[#f5ff3b] text-[#06152c]"
                : "bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </div>

      {record.favoriteGame && record.favoriteGame !== "N/A" && (
        <p className="mt-4 text-center text-xs text-gray-400">
          Favorite game:{" "}
          <span className="font-semibold text-[#00e5ff]">{record.favoriteGame}</span>
        </p>
      )}
    </div>
  );
}
