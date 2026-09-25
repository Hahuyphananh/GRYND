"use client";

import { useMemo, useState } from "react";

// Tabbed stat panel for the profile pages. Mirrors the leaderboard boards:
//   - Record: games won/lost, win rate, games played, net wins, W/L ratio,
//     PvP wins and win streaks (the all-time leaderboard categories)
//   - Game Ratings: this player's per-game Elo, one independent rating per
//     game (the same numbers the per-game leaderboards rank by)
//   - Weekly: the weekly equivalents (no weekly PvP counter exists)
//   - Streaks: daily / weekly login streaks (the leaderboard streak tabs)
//
// `record` is the leaderboard-style record returned by the profile API
// routes (same source the leaderboard boards read: user_stats + users).
// `ratings` is the per-game Elo map (`gameKey → rating`); a game the player
// has never been rated in is simply absent and is not shown. `overall` is the
// server-computed Overall Elo aggregate (mean of the established game ratings
// above), shown alongside — never instead of — the individual ratings.
// There is no token/currency metric on any tab, and Overall Elo is an
// aggregate with no rating system of its own (it has no K-factor or results).
const TABS = [
  { key: "record", label: "Record" },
  { key: "ratings", label: "Game Ratings" },
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
  ];
}

function TabBar({ tabs, tab, setTab }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {tabs.map((t) => (
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
  );
}

function streakTiles(record) {
  return [
    { label: "Daily Streak", value: `${formatNumber(record.dailyStreakCurrent)} days`, valueClass: "text-amber-300" },
    { label: "Daily Best", value: `${formatNumber(record.dailyStreakBest)} days`, valueClass: "text-amber-300" },
    { label: "Weekly Streak", value: `${formatNumber(record.weeklyStreakCurrent)} days`, valueClass: "text-[#00e5ff]" },
    { label: "Weekly Best", value: `${formatNumber(record.weeklyStreakBest)} days`, valueClass: "text-[#00e5ff]" },
  ];
}

/** One game-specific Elo row: player's rating for that game only. */
function RatingRow({ entry }) {
  const provisional = Boolean(entry.provisional);
  const draws = Number(entry.draws || 0);
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[#00e5ff]/30 bg-white/5 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[#c9f7ff]">
          {entry.label || entry.gameKey}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-300">
          <span className="font-semibold text-green-300">{formatNumber(entry.wins)}W</span>{" "}
          <span className="font-semibold text-red-300/90">{formatNumber(entry.losses)}L</span>
          {draws > 0 ? ` · ${formatNumber(draws)}D` : ""}
          {Number(entry.gamesRated || 0) > 0
            ? ` · ${formatNumber(entry.gamesRated)} rated`
            : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-lg font-bold text-[#f5ff3b]">{formatNumber(entry.rating)}</p>
        <p className="text-[10px] uppercase tracking-wider text-cyan-200/70">Elo</p>
        {provisional && (
          <p className="mt-1 inline-block rounded-full border border-amber-400/60 bg-amber-400/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-amber-300">
            Provisional {Number(entry.provisionalGamesCompleted || 0)}/
            {Number(entry.provisionalGamesTotal || 0)}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The Overall Elo card: the aggregate of the player's established game
 * ratings, plus how many different games qualified. The value is the one the
 * server computed (`overall.overallElo`), never re-derived on the client, so
 * a client can never inflate it. Shows the unlock progress until the player
 * has established ratings in the required number of different games.
 */
function OverallEloCard({ overall }) {
  const value = overall?.overallElo;
  // Accept both the board row keys (eligibleGames/minGames) and the profile
  // API keys (overallEligibleGames/overallMinGames), so every caller can pass
  // whichever shape it already has.
  const eligibleGames = Number(
    overall?.eligibleGames ?? overall?.overallEligibleGames ?? 0,
  );
  const minGames = Number(overall?.overallMinGames ?? overall?.minGames ?? 3);
  const eligible = value !== null && value !== undefined;

  return (
    <div className="mb-4 rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 p-4 text-center">
      <p className="text-xs font-bold uppercase tracking-widest text-[#f5ff3b]">
        Overall Elo
      </p>
      {eligible ? (
        <>
          <p className="mt-1 text-3xl font-black text-[#f5ff3b]">
            {formatNumber(value)}
          </p>
          <p className="mt-1 text-xs uppercase tracking-wider text-cyan-200/80">
            Eligible Games{" "}
            <span className="font-bold text-[#c9f7ff]">{eligibleGames}</span>
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-cyan-200/80">
          Unlock Overall Elo by earning an established rating in{" "}
          <span className="font-bold text-[#f5ff3b]">{minGames} different games</span>.{" "}
          You have{" "}
          <span className="font-bold text-[#c9f7ff]">{eligibleGames}</span>. Provisional
          ratings do not count.
        </p>
      )}
    </div>
  );
}

/**
 * The Game Ratings panel: one independent Elo per game, highest first, and
 * the server-computed Overall Elo above them. Only games the player actually
 * has a rating for are listed, so a game they have never played is omitted
 * rather than shown as a placeholder 1000. Overall Elo never replaces the
 * individual ratings — both are shown.
 */
function RatingsPanel({ ratings, overall }) {
  const entries = useMemo(() => {
    return Object.values(ratings || {})
      .filter((r) => r && Number.isFinite(Number(r.rating)))
      .sort((a, b) => Number(b.rating) - Number(a.rating));
  }, [ratings]);

  if (entries.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-gray-400">
        No game ratings yet — finish a ranked match to earn your first Elo.
      </p>
    );
  }

  return (
    <div>
      {/* Overall Elo is an aggregate of the established games below — it is
          shown alongside them, never instead of them. */}
      <OverallEloCard overall={overall} />
      <p className="mb-2 text-xs font-bold uppercase tracking-widest text-[#00e5ff]">
        Game Ratings
      </p>
      <p className="mb-3 text-center text-xs text-gray-400">
        One independent Elo rating per game. Provisional ratings are still
        being placed and will settle after 10 ranked matches in that game.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <RatingRow key={entry.gameKey} entry={entry} />
        ))}
      </div>
    </div>
  );
}

export default function UserStatsTabs({ record, ratings = null, overall = null }) {
  const [tab, setTab] = useState("record");

  // The Ratings tab is available whenever the caller supplied the map — even
  // for a player with no rated matches yet, where it explains how to earn one.
  const hasRatings = ratings !== null && ratings !== undefined;
  const tabs = useMemo(
    () => TABS.filter((t) => t.key !== "ratings" || hasRatings),
    [hasRatings],
  );

  if (tab === "ratings" && hasRatings) {
    return (
      <div>
        <TabBar tabs={tabs} tab={tab} setTab={setTab} />
        <RatingsPanel ratings={ratings} overall={overall} />
      </div>
    );
  }

  if (!record) {
    return (
      <>
        <TabBar tabs={tabs} tab={tab} setTab={setTab} />
        <p className="py-4 text-center text-sm text-gray-400">
          No stats yet — play some games to build your record.
        </p>
      </>
    );
  }

  // `record` is guaranteed non-null past this point, so the remaining tabs are
  // the tile grids (Record / Weekly / Streaks). Tokens and winnings are not
  // among them — the boards rank skill only.
  const gridTiles =
    tab === "weekly"
      ? weeklyTiles(record)
      : tab === "streaks"
        ? streakTiles(record)
        : recordTiles(record);

  return (
    <div>
      <TabBar tabs={tabs} tab={tab} setTab={setTab} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {gridTiles.map((tile) => (
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
