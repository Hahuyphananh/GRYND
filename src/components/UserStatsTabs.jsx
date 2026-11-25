"use client";

import { useMemo, useRef, useState } from "react";

import { StatTile, Surface, cx } from "./ui";

// Tabbed stat panel for the profile pages. Mirrors the leaderboard boards:
//   - Record: games won/lost, win rate, games played, net wins, W/L ratio,
//     PvP wins and win streaks (the all-time leaderboard categories)
//   - Trophies: this player's per-game trophy counts (the primary competitive
//     progression, and one of the two numbers ranked matchmaking matches on)
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
// There is no currency metric on any tab, and Overall Elo is an aggregate with
// no rating system of its own (it has no K-factor or results).
//
// Every surface here reads the semantic layer, so the panel is correct in both
// themes from one set of classes. The tab row keeps real tablist semantics
// (the panel below it swaps) rather than the segmented-control primitive.
const TABS = [
  { key: "record", label: "Record" },
  { key: "trophies", label: "Trophies" },
  { key: "ratings", label: "Game Ratings" },
  { key: "weekly", label: "Weekly" },
  { key: "streaks", label: "Streaks" },
];

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function ratioLabel(wins, losses) {
  return losses > 0
    ? `${(wins / losses).toFixed(1)}:1`
    : wins > 0
      ? `${wins}:0`
      : "0:0";
}

function recordTiles(record) {
  const wins = Number(record.wins || 0);
  const losses = Number(record.losses || 0);
  const netWins = wins - losses;

  return [
    { label: "Games Won", value: formatNumber(wins), tone: "win" },
    { label: "Games Lost", value: formatNumber(losses), tone: "loss" },
    { label: "Win Rate", value: `${Number(record.winRate || 0).toFixed(1)}%` },
    { label: "Games Played", value: formatNumber(record.games) },
    {
      label: "Net Wins",
      value: netWins > 0 ? `+${formatNumber(netWins)}` : formatNumber(netWins),
      tone: netWins >= 0 ? "win" : "loss",
    },
    { label: "W/L Ratio", value: ratioLabel(wins, losses) },
    { label: "PvP Wins", value: formatNumber(record.pvpWins) },
    { label: "Best Win Streak", value: formatNumber(record.bestStreak), tone: "gold" },
    { label: "Current Streak", value: formatNumber(record.currentStreak), tone: "gold" },
  ];
}

function weeklyTiles(record) {
  const wins = Number(record.weeklyWins || 0);
  const losses = Number(record.weeklyLosses || 0);
  const netWins = wins - losses;

  return [
    { label: "Weekly Wins", value: formatNumber(wins), tone: "win" },
    { label: "Weekly Losses", value: formatNumber(losses), tone: "loss" },
    { label: "Weekly Win Rate", value: `${Number(record.weeklyWinRate || 0).toFixed(1)}%` },
    { label: "Weekly Games", value: formatNumber(wins + losses) },
    {
      label: "Weekly Net Wins",
      value: netWins > 0 ? `+${formatNumber(netWins)}` : formatNumber(netWins),
      tone: netWins >= 0 ? "win" : "loss",
    },
    { label: "Weekly W/L Ratio", value: ratioLabel(wins, losses) },
    { label: "Weekly Best Streak", value: formatNumber(record.weeklyBestStreak), tone: "gold" },
    {
      label: "Weekly Current Streak",
      value: formatNumber(record.weeklyCurrentStreak),
      tone: "gold",
    },
  ];
}

function streakTiles(record) {
  return [
    {
      label: "Daily Streak",
      value: `${formatNumber(record.dailyStreakCurrent)} days`,
      tone: "gold",
    },
    {
      label: "Daily Best",
      value: `${formatNumber(record.dailyStreakBest)} days`,
      tone: "gold",
    },
    {
      label: "Weekly Streak",
      value: `${formatNumber(record.weeklyStreakCurrent)} days`,
      tone: "accent",
    },
    {
      label: "Weekly Best",
      value: `${formatNumber(record.weeklyStreakBest)} days`,
      tone: "accent",
    },
  ];
}

function TabBar({ tabs, tab, setTab }) {
  const refs = useRef([]);

  const onKeyDown = (event, index) => {
    const last = tabs.length - 1;
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    setTab(tabs[next].key);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label="Profile statistics" className="mb-4 flex flex-wrap gap-2">
      {tabs.map((item, index) => {
        const active = item.key === tab;
        return (
          <button
            key={item.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`profile-stats-tab-${item.key}`}
            aria-selected={active}
            aria-controls={`profile-stats-panel-${item.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => setTab(item.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              "rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors duration-fast ease-standard",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]",
              "motion-reduce:transition-none",
              active
                ? "border-[color:var(--accent)] bg-[color:var(--accent-fill)] text-[color:var(--accent-strong)]"
                : "border-[color:var(--border-strong)] text-[color:var(--text-secondary)] hover:bg-[color:var(--bg-panel)] hover:text-[color:var(--text-primary)]",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function Panel({ tab, children }) {
  return (
    <div
      role="tabpanel"
      id={`profile-stats-panel-${tab}`}
      aria-labelledby={`profile-stats-tab-${tab}`}
    >
      {children}
    </div>
  );
}

function Empty({ children }) {
  return (
    <p className="py-6 text-center text-sm text-[color:var(--text-secondary)]">{children}</p>
  );
}

/** One game-specific Elo row: player's rating for that game only. */
function RatingRow({ entry }) {
  const provisional = Boolean(entry.provisional);
  const draws = Number(entry.draws || 0);
  return (
    <Surface
      tone="panel"
      padding="sm"
      className="flex items-center justify-between gap-3"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
          {entry.label || entry.gameKey}
        </p>
        <p className="mt-0.5 text-[11px] text-[color:var(--text-muted)]">
          <span className="font-semibold text-[color:var(--state-win)]">
            {formatNumber(entry.wins)}W
          </span>{" "}
          <span className="font-semibold text-[color:var(--state-loss)]">
            {formatNumber(entry.losses)}L
          </span>
          {draws > 0 ? ` · ${formatNumber(draws)}D` : ""}
          {Number(entry.gamesRated || 0) > 0
            ? ` · ${formatNumber(entry.gamesRated)} rated`
            : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-lg font-bold tabular-nums text-[color:var(--state-gold)]">
          {formatNumber(entry.rating)}
        </p>
        <p className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)]">
          Elo
        </p>
        {provisional && (
          <p className="mt-1 inline-block rounded-full border border-[color:var(--border-warning)] px-1.5 py-px text-[11px] font-bold uppercase tracking-wider text-[color:var(--state-gold)]">
            Provisional {Number(entry.provisionalGamesCompleted || 0)}/
            {Number(entry.provisionalGamesTotal || 0)}
          </p>
        )}
      </div>
    </Surface>
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
    <Surface tone="warning" padding="sm" className="mb-4 text-center">
      <p className="text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--state-gold)]">
        Overall Elo
      </p>
      {eligible ? (
        <>
          <p className="mt-1 text-3xl font-black tabular-nums text-[color:var(--state-gold)]">
            {formatNumber(value)}
          </p>
          <p className="mt-1 text-xs uppercase tracking-wider text-[color:var(--text-secondary)]">
            Eligible Games{" "}
            <span className="font-bold text-[color:var(--text-primary)]">{eligibleGames}</span>
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-[color:var(--text-secondary)]">
          Unlock Overall Elo by earning an established rating in{" "}
          <span className="font-bold text-[color:var(--state-gold)]">
            {minGames} different games
          </span>
          . You have{" "}
          <span className="font-bold text-[color:var(--text-primary)]">{eligibleGames}</span>.
          Provisional ratings do not count.
        </p>
      )}
    </Surface>
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
      <Empty>No game ratings yet — finish a ranked match to earn your first Elo.</Empty>
    );
  }

  return (
    <div>
      {/* Overall Elo is an aggregate of the established games below — it is
          shown alongside them, never instead of them. */}
      <OverallEloCard overall={overall} />
      <p className="mb-2 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--text-secondary)]">
        Game Ratings
      </p>
      <p className="mb-3 text-center text-xs leading-relaxed text-[color:var(--text-muted)]">
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
        <Panel tab={tab}>
          <RatingsPanel ratings={ratings} overall={overall} />
        </Panel>
      </div>
    );
  }

  if (!record) {
    return (
      <div>
        <TabBar tabs={tabs} tab={tab} setTab={setTab} />
        <Panel tab={tab}>
          <Empty>No stats yet — play some games to build your record.</Empty>
        </Panel>
      </div>
    );
  }

  // `record` is guaranteed non-null past this point, so the remaining tabs are
  // the tile grids (Record / Weekly / Streaks). Currency and winnings are not
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

      <Panel tab={tab}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {gridTiles.map((tile) => (
            <StatTile key={tile.label} label={tile.label} value={tile.value} tone={tile.tone} />
          ))}
        </div>

        {record.favoriteGame && record.favoriteGame !== "N/A" && (
          <p className="mt-4 text-center text-xs text-[color:var(--text-muted)]">
            Favorite game:{" "}
            <span className="font-semibold text-[color:var(--text-secondary)]">
              {record.favoriteGame}
            </span>
          </p>
        )}
      </Panel>
    </div>
  );
}
