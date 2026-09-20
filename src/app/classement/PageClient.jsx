"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import FrameAvatar from "../../components/FrameAvatar";
import { useTranslation } from "../../hooks/useTranslation";

const TABS = ["all-time", "per-game", "daily-current", "daily-best", "weekly-streak", "weekly-best"];

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

  const field = (name) => item[name];

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

/** Rank cell styling — medals for the podium, plain cyan below. */
function RankBadge({ rank }) {
  if (rank === 1)
    return (
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#f5ff3b]/60 bg-[#f5ff3b]/15 text-sm font-black text-[#f5ff3b] shadow-[0_0_12px_rgba(245,255,59,0.35)]">
        {rank}
      </span>
    );
  if (rank === 2)
    return (
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-300/50 bg-slate-300/10 text-sm font-black text-slate-200">
        {rank}
      </span>
    );
  if (rank === 3)
    return (
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-amber-600/60 bg-amber-700/20 text-sm font-black text-amber-400">
        {rank}
      </span>
    );
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#00e5ff]/30 bg-[#00e5ff]/10 text-sm font-bold text-[#00e5ff]">
      {rank}
    </span>
  );
}

/** Top-3 podium — real board data, never fabricated. */
function Podium({ items, myClerkId, tab, category }) {
  if (!items || items.length === 0) return null;
  const order = items.length === 1 ? [0] : items.length === 2 ? [1, 0] : [1, 0, 2];
  const metricLabel = isPerGameTab(tab)
    ? "Wins"
    : isStreakTab(tab)
      ? "Days"
      : CATEGORY_LABELS[category];

  return (
    <div className="mb-6 grid grid-cols-3 gap-2 sm:gap-3">
      {order.map((idx) => {
        const item = items[idx];
        if (!item) return <div key={`podium-empty-${idx}`} />;
        const isMe = myClerkId && item.clerk_id === myClerkId;
        const isFirst = item.rank === 1;
        return (
          <Link
            key={`${item.clerk_id}-${item.rank}`}
            href={`/profil/${encodeURIComponent(item.clerk_id)}`}
            className={`group relative flex flex-col items-center rounded-xl border px-2 py-3 text-center transition-all hover:bg-white/10 sm:px-3 sm:py-4 ${
              isFirst
                ? "border-[#f5ff3b]/50 bg-[#f5ff3b]/20 shadow-[0_0_20px_rgba(245,255,59,0.15)] sm:-translate-y-2"
                : item.rank === 2
                  ? "border-slate-300/30 bg-slate-300/10"
                  : "border-amber-600/30 bg-amber-700/10"
            } ${isMe ? "ring-2 ring-[#00e5ff]" : ""}`}
          >
            <span
              className={`mb-1 text-xs font-black ${
                isFirst
                  ? "text-[#f5ff3b]"
                  : item.rank === 2
                    ? "text-slate-200"
                    : "text-amber-400"
              }`}
            >
              #{item.rank}
            </span>
            <FrameAvatar
              frame={item.profileFrame}
              iconKey={item.icon_key || null}
              name={item.user?.name || item.name}
              size="h-10 w-10 sm:h-12 sm:w-12"
              className="border border-white/20"
            />
            <span className="mt-1.5 w-full truncate text-xs font-semibold text-[#c9f7ff] sm:text-sm">
              {item.user?.name || item.name}
            </span>
            {isMe && (
              <span className="mt-0.5 rounded-full bg-[#00e5ff] px-1.5 py-px text-[9px] font-black uppercase tracking-wider text-[#001933]">
                You
              </span>
            )}
            <span
              className={`mt-1 text-sm font-bold sm:text-base ${
                isFirst ? "text-[#f5ff3b]" : "text-green-300"
              }`}
            >
              {getMetricValue(item, tab, category)}
            </span>
            <span className="text-[9px] uppercase tracking-wider text-cyan-200/60 sm:text-[10px]">
              {metricLabel}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** Competitive copy telling the player exactly where they stand. */
function rankStatus(rank, t) {
  if (!rank) return null;
  if (rank === 1) return t("leaderboard.top_of_board");
  if (rank <= 10) return t("leaderboard.in_top_10");
  return t("leaderboard.spots_from_top_10", { n: rank - 10 });
}

export default function LeaderboardPage() {
  const { t } = useTranslation();
  const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
  const [tab, setTab] = useState("all-time");
  const [category, setCategory] = useState("wins");
  const [game, setGame] = useState("chess");
  const [reloadKey, setReloadKey] = useState(0);

  const selectTab = (next) => {
    setTab(next);
    // pvp_wins is all-time only — fall back to the headline metric on the
    // other tabs (which have no categories).
    if (next !== "all-time" && category === "pvp_wins") setCategory("wins");
  };
  // Per-game boards always rank by wins.
  const displayCategory = isPerGameTab(tab) ? "wins" : category;
  const [items, setItems] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [myStats, setMyStats] = useState(null);
  const [error, setError] = useState(null);

  const myClerkId = isSignedIn ? user?.id : null;

  const endpoint = useMemo(() => {
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
  }, [endpoint, reloadKey, t]);

  const showPodium =
    !loading && !error && items.length > 0 && !isStreakTab(tab);

  // Rank card — visible whenever we know something about the signed-in user
  // (their board rank, or their stats). Signed-out visitors see the board.
  const showRankCard = clerkLoaded && isSignedIn && (me || myStats);
  const statusLine = rankStatus(me?.rank, t);
  const climbCtaLabel =
    me?.rank && me.rank <= 10 ? t("leaderboard.defend_spot") : t("leaderboard.climb_ranks");

  return (
    <div className="relative min-h-screen text-[#c9f7ff]">
      <InteractiveCasinoBg variant="subtle" />
      {/* Fade the casino artwork back so the board reads clearly. Painted
          above the z-0 background but below the z-10 content. */}
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-[#030815]/60"
        aria-hidden="true"
      />

      <NavigationBar currentPath="/classement" />
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <header className="mb-6 text-center">
          <h1 className="text-3xl font-bold text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)] sm:text-4xl">
            {t("leaderboard.title")}
          </h1>
          <p className="mt-2 text-sm text-cyan-200/80 sm:text-base">
            {t("leaderboard.subtitle")}
          </p>
        </header>

        {/* Tab bar — scrolls horizontally on mobile instead of wrapping. */}
        <div className="mb-6 -mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          <div className="flex w-max min-w-full justify-start gap-2 sm:justify-center">
            {TABS.map((x) => (
              <button
                key={x}
                onClick={() => selectTab(x)}
                aria-pressed={tab === x}
                className={`shrink-0 whitespace-nowrap rounded-lg border px-4 py-2 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] ${tab === x ? "border-[#f5ff3b]/60 bg-[#f5ff3b] text-[#041125]" : "border-[#00e5ff]/50 bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"}`}
              >
                {x === "all-time"
                  ? "All-Time"
                  : x === "daily-current"
                    ? <span>Daily Streak <svg className="w-4 h-4 inline text-amber-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 23c-1.4 0-2.5-1.1-2.5-2.5 0-.5.1-.9.4-1.3-1.9-1-4.1-2.3-4.1-4.7 0-2.2 1.5-4 3.5-5.5C10 8.4 10.5 7.5 12 2c1.5 5.5 2 6.4 2.7 7 2 1.5 3.5 3.3 3.5 5.5 0 2.4-2.2 3.7-4.1 4.7.3.4.4.8.4 1.3 0 1.4-1.1 2.5-2.5 2.5z"/></svg></span>
                      : x === "daily-best"
                        ? <span>Best Streak <svg className="w-4 h-4 inline text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2Z"/></svg></span>
                        : x === "weekly-streak"
                          ? <span>Weekly Streak <svg className="w-4 h-4 inline text-[#00e5ff]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></span>
                          : <span>Weekly Best Streak <svg className="w-4 h-4 inline text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2Z"/></svg></span>}
              </button>
            ))}
          </div>
        </div>

        {isPerGameTab(tab) ? (
          <div className="mb-4 -mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            <div className="flex w-max min-w-full gap-2 sm:flex-wrap sm:justify-center">
              {GAMES.map((g) => (
                <button
                  key={g.key}
                  onClick={() => setGame(g.key)}
                  aria-pressed={game === g.key}
                  className={`shrink-0 whitespace-nowrap rounded-md px-4 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] ${game === g.key ? "bg-[#f5ff3b] text-[#06152c]" : "bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"}`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          !isStreakTab(tab) && (
            <div className="mb-4 -mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
              <div className="flex w-max min-w-full gap-2 sm:flex-wrap sm:justify-center">
                {ALL_TIME_CATEGORIES.map((x) => (
                  <button
                    key={x}
                    onClick={() => setCategory(x)}
                    aria-pressed={category === x}
                    className={`shrink-0 whitespace-nowrap rounded-md px-4 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] ${category === x ? "bg-[#f5ff3b] text-[#06152c]" : "bg-[#0a214d] text-[#00e5ff]"}`}
                  >
                    {CATEGORY_LABELS[x]}
                  </button>
                ))}
              </div>
            </div>
          )
        )}

        {!isStreakTab(tab) && !isPerGameTab(tab) && category === "win_rate" && (
          <p className="mb-4 text-center text-xs text-cyan-200/70">
            Win-rate board — players with at least{" "}
            <span className="font-bold text-[#f5ff3b]">10 games</span>{" "}
            played this season only.
          </p>
        )}

        {/* ── YOUR RANK — where you stand, always in view ─────────────── */}
        {showRankCard && (
          <div className="mx-auto mb-6 max-w-2xl rounded-lg border border-[#00e5ff]/50 bg-[#0a214d] p-4 shadow-[0_0_24px_rgba(0,229,255,0.15)] sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-[#f5ff3b]">
                <svg className="h-4 w-4 text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v9a5 5 0 01-10 0V4z"/><path d="M7 9h10"/><path d="M9 4V2M15 4V2"/></svg>
                {t("leaderboard.your_rank")}
              </h2>
              {me ? (
                <span className="rounded-md border border-[#f5ff3b]/50 bg-[#f5ff3b]/10 px-3 py-1 text-base font-black text-[#f5ff3b] shadow-[0_0_12px_rgba(245,255,59,0.25)]">
                  #{formatNumber(me.rank)}
                </span>
              ) : (
                <span className="rounded-md border border-cyan-200/40 bg-cyan-200/10 px-3 py-1 text-base font-black uppercase tracking-wider text-cyan-100">
                  {t("leaderboard.unranked")}
                </span>
              )}
            </div>

            {me ? (
              <>
                <p className="text-sm font-semibold text-cyan-100">
                  {me.user?.name || me.name || "You"}
                  {me.prestigeBadge && (
                    <span className="ml-2 rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-300">
                      {me.prestigeBadge}
                    </span>
                  )}
                </p>
                {/* Real board record (weekly/all-time/per-game/streak rows all
                    return it) */}
                <RecordLine item={me} />
                {statusLine && (
                  <p className="mt-2 inline-flex rounded-md border border-[#00e5ff]/40 bg-[#08142f] px-3 py-1.5 text-xs font-semibold text-[#00e5ff]">
                    {statusLine}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-cyan-200/80">
                {t("leaderboard.unranked_hint")}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Link
                href="/casino"
                className="rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-4 py-2 text-sm font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a214d]"
              >
                {me ? climbCtaLabel : "PLAY NOW"}
              </Link>
              <Link
                href="/profil"
                className="rounded-lg border border-[#00e5ff]/50 bg-[#0a214d] px-4 py-2 text-sm font-semibold text-[#00e5ff] transition-all hover:bg-[#123b82] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a214d]"
              >
                {t("leaderboard.my_profile")}
              </Link>
            </div>

            {myStats && (
              <>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
                  <div className="rounded-md bg-[#08142f] px-3 py-2 text-center">
                    <div className="text-lg font-bold text-green-300">
                      {formatNumber(myStats.gamesWon)}W{" "}
                      <span className="text-red-300/90">{formatNumber(myStats.gamesLost)}L</span>
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Games won / lost</div>
                  </div>
                  <div className="rounded-md bg-[#08142f] px-3 py-2 text-center">
                    <div className="text-lg font-bold text-[#00e5ff]">
                      {Number(myStats.gameWinRate || 0).toFixed(1)}%
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Win rate</div>
                  </div>
                  <div className="rounded-md bg-[#08142f] px-3 py-2 text-center">
                    <div className="text-lg font-bold">
                      {formatNumber(myStats.gamesPlayed)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Games played</div>
                  </div>
                  <div className="rounded-md bg-[#08142f] px-3 py-2 text-center">
                    <div className="text-lg font-bold text-[#f5ff3b]">
                      {formatNumber(myStats.currentStreak)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Current win streak</div>
                  </div>
                  <div className="rounded-md bg-[#08142f] px-3 py-2 text-center">
                    <div className="text-lg font-bold text-[#f5ff3b]">
                      {formatNumber(myStats.bestStreak)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-cyan-200/70">Best win streak</div>
                  </div>
                  <div className="rounded-md bg-[#08142f] px-3 py-2 text-center">
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
            )}
          </div>
        )}

        {showPodium && (
          <Podium
            items={items.slice(0, 3)}
            myClerkId={myClerkId}
            tab={tab}
            category={displayCategory}
          />
        )}

        <div className="w-full overflow-x-auto rounded-lg border border-[#00e5ff]/50 bg-[#08142f] p-4 shadow-[0_0_28px_rgba(0,229,255,0.2)]">
          {error && (
            <div className="mb-4 flex flex-col items-center gap-3 rounded-md border border-red-400/40 bg-red-950/40 px-4 py-3 text-center text-sm text-red-200 sm:flex-row sm:justify-between">
              <span>{error}</span>
              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="shrink-0 rounded-md border border-red-300/50 bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-100 transition-colors hover:bg-red-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
              >
                Try again
              </button>
            </div>
          )}

          {loading ? (
            <div className="space-y-2 py-2" aria-busy="true" aria-label="Loading leaderboard">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                <div key={i} className="flex animate-pulse items-center gap-3 rounded-md px-2 py-3">
                  <div className="h-8 w-8 shrink-0 rounded-full bg-white/10" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-2/5 rounded bg-white/10" />
                    <div className="h-2.5 w-1/3 rounded bg-white/5" />
                  </div>
                  <div className="h-4 w-12 shrink-0 rounded bg-white/10" />
                </div>
              ))}
            </div>
          ) : !error && items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <svg className="h-10 w-10 text-[#00e5ff]/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v9a5 5 0 01-10 0V4z"/><path d="M7 9h10"/></svg>
              <p className="text-lg font-bold text-[#f5ff3b]">
                {t("leaderboard.empty_title")}
              </p>
              <p className="max-w-sm text-sm text-cyan-200/80">
                {t("leaderboard.empty_hint")}
              </p>
              <Link
                href="/casino"
                className="mt-1 rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-5 py-2.5 text-sm font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
              >
                PLAY NOW
              </Link>
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
                    <th className="px-2 py-2 text-xs uppercase tracking-wider sm:px-3">#</th>
                    <th className="px-2 py-2 text-xs uppercase tracking-wider sm:px-3">Player</th>
                    <th className="px-2 py-2 text-right text-xs uppercase tracking-wider sm:px-3 sm:text-left">
                      {isStreakTab(tab)
                        ? "Days"
                        : isPerGameTab(tab)
                          ? "Wins"
                          : CATEGORY_LABELS[category]}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => {
                    const isMe = myClerkId && item.clerk_id === myClerkId;
                    return (
                      <tr
                        key={`${item.clerk_id}-${item.rank}`}
                        className={`border-b border-[#00e5ff]/20 transition-colors ${
                          isMe
                            ? "border-y-2 border-y-[#f5ff3b]/50 bg-[#f5ff3b]/10"
                            : i % 2
                              ? "bg-[#08142f]"
                              : "bg-[#0b224f]"
                        } ${isMe ? "" : "hover:bg-white/10"}`}
                      >
                        <td className="px-2 py-3 sm:px-3">
                          <RankBadge rank={item.rank} />
                        </td>
                        <td className="px-2 py-3 sm:px-3">
                          <div className="flex items-center gap-2.5">
                            <Link
                              href={`/profil/${encodeURIComponent(item.clerk_id)}`}
                              className="flex min-w-0 items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
                              title={`View ${item.user?.name || item.name}'s profile`}
                            >
                              <FrameAvatar
                                frame={item.profileFrame}
                                iconKey={item.icon_key || null}
                                name={item.user?.name || item.name}
                                size="h-9 w-9"
                                className="border border-white/20"
                              />
                              <span className="min-w-0">
                                <span className="block max-w-[9rem] truncate font-semibold text-[#c9f7ff] transition-colors hover:text-[#00e5ff] hover:underline sm:max-w-none">
                                  {item.user?.name || item.name}
                                  {item.prestigeBadge && (
                                    <span className="ml-1.5 rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-300">
                                      {item.prestigeBadge}
                                    </span>
                                  )}
                                </span>
                                <RecordLine item={item} />
                              </span>
                            </Link>
                            {isMe && (
                              <span className="shrink-0 rounded-full bg-[#f5ff3b] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#041125]">
                                You
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 text-right font-bold text-green-300 sm:px-3 sm:text-left">
                          {getMetricValue(item, tab, displayCategory)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </motion.table>
            </AnimatePresence>
          )}
        </div>

        {/* Competitive CTA — the board should make you want to play. */}
        {!loading && !error && (
          <div className="mx-auto mt-6 flex max-w-2xl flex-col items-center gap-4 rounded-lg border border-[#f5ff3b]/30 bg-gradient-to-br from-[#0a214d] to-[#08142f] p-6 text-center shadow-[0_0_24px_rgba(245,255,59,0.1)] sm:flex-row sm:justify-between sm:text-left">
            <div>
              <h2 className="text-lg font-bold uppercase tracking-wide text-[#f5ff3b]">
                {t("leaderboard.climb_ranks")}
              </h2>
              <p className="mt-1 text-sm text-cyan-200/80">
                Every win moves you up. Pick a game and start climbing.
              </p>
            </div>
            <Link
              href="/casino"
              className="shrink-0 rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff] px-5 py-2.5 text-sm font-bold text-[#001933] transition-all hover:bg-[#00e5ff]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
            >
              PLAY NOW
            </Link>
          </div>
        )}
      </div>
      <div className="relative z-10">
        <Footer />
      </div>
    </div>
  );
}