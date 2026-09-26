"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import FrameAvatar from "../../components/FrameAvatar";
import { cosmeticEffectClass } from "../../lib/profileCosmetics";
import { useTranslation } from "../../hooks/useTranslation";
import { useApiResource } from "../../hooks/useApiResource";
import AsyncState from "../../components/states/AsyncState";
import UpgradeProButton from "../../components/UpgradeProButton";

const TABS = [
  "trophies",
  "all-time",
  "overall",
  "per-game",
  "daily-current",
  "daily-best",
  "weekly-streak",
  "weekly-best",
];

// Per-game leaderboards: one ELO board per rated game, sorted by that game's
// current rating. This is the first-paint mirror of RATED_GAMES in
// src/lib/rating.js; once the board loads, the authoritative list comes from
// the API response (`games`), so the tabs can never drift from the server.
const RATED_GAMES_FALLBACK = [
  { key: "chess", label: "Chess" },
  { key: "four-in-a-row", label: "Four In A Row" },
  { key: "dots-and-boxes", label: "Dots & Boxes" },
  { key: "pool", label: "Pool Masters" },
  { key: "memory-grid", label: "Memory Grid" },
  { key: "precision", label: "Precision" },
  { key: "mines-pvp", label: "Mines Duel" },
  { key: "keno-pvp", label: "Keno Duel" },
  { key: "plinko-pvp", label: "Plinko Duel" },
  { key: "lane-rush-duel", label: "Lane Rush Duel" },
  { key: "blackjack-pvp", label: "Blackjack" },
  { key: "dice-flush", label: "Dice Flush" },
  { key: "rps-pvp", label: "Rock Paper Scissors" },
  { key: "odds-pvp", label: "Odds" },
];

// Game-result categories the weekly/all-time boards rank by. Every
// token-derived metric (wagered, won, biggest win) and level is intentionally
// absent — those boards rank skill: games won/lost, win rate, volume, streaks
// and PvP wins. The game-specific boards below are Elo, not category-based.
const ALL_TIME_CATEGORIES = [
  "wins",
  "win_rate",
  "games",
  "best_streak",
  "pvp_wins",
  "net_wins",
  "win_loss_ratio",
  "current_streak",
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
};

/**
 * The casino lobby links here with its canonical `leaderboardKey`. Some of
 * those ids are not rated games at all (solo wager games have no Elo board),
 * and a few differ from the rating key, so they are mapped explicitly.
 */
const LOBBY_GAME_ALIASES = {
  "pool-masters": "pool",
  "lane-runner": "lane-rush-duel",
  rps: "rps-pvp",
  odds: "odds-pvp",
  yahtzee: "dice-flush",
};

/**
 * Resolve a `?game=` deep-link value to a rated game key, or null when that
 * game has no Elo board (the page then keeps its default board instead of
 * showing an invented one).
 */
function ratedGameFromParam(value) {
  if (!value) return null;
  const alias = LOBBY_GAME_ALIASES[value] || value;
  return RATED_GAMES_FALLBACK.some((g) => g.key === alias) ? alias : null;
}

/**
 * Clearly marks a rating that is still inside its placement window. A
 * provisional player is ranked by their real current Elo, but is labelled so
 * an unsettled rating is never mistaken for a settled one.
 */
function ProvisionalChip({ item, className = "" }) {
  if (!item?.provisional) return null;
  const done = Number(item.provisionalGamesCompleted || 0);
  const total = Number(item.provisionalGamesTotal || 0);
  return (
    <span
      className={`ml-1.5 inline-block rounded-full border border-amber-400/60 bg-amber-400/10 px-1.5 py-0.5 align-middle text-[9px] font-bold uppercase tracking-wider text-amber-300 ${className}`}
      title={`Provisional — ${done} of ${total} placement matches completed`}
    >
      Provisional {done}/{total}
    </span>
  );
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

/**
 * The Overall Elo badge shown next to a player's name. It is the cross-game
 * aggregate the server attaches to every board row — hidden unless the player
 * has enough different established games, and omitted on the Overall tab
 * itself (where it is already the metric, to avoid showing it twice).
 */
function OverallEloBadge({ item, className = "" }) {
  const elo = Number(item?.overallElo);
  if (!Number.isFinite(elo) || elo <= 0) return null;
  return (
    <span
      className={`ml-1.5 inline-block rounded-full border border-[#f5ff3b]/50 bg-[#f5ff3b]/10 px-1.5 py-0.5 align-middle text-[9px] font-bold uppercase tracking-wider text-[#f5ff3b] ${className}`}
      title={`Overall Elo ${formatNumber(elo)} across ${formatNumber(item.overallGames || 0)} games`}
    >
      Overall {formatNumber(elo)}
    </span>
  );
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

// The cross-game OVERALL ELO board: an aggregate of each player's established
// game ratings, only for players with at least OVERALL_MIN_GAMES games.
function isOverallTab(tab) {
  return tab === "overall";
}

// The cross-game OVERALL TROPHIES board — the headline competitive board. It
// ranks by the SUM of a player's per-game trophy counts (players need a trophy
// row in at least OVERALL_TROPHY_MIN_GAMES games). Derived on read; nothing is
// stored, so a trophy change shows up on the next load.
function isTrophyTab(tab) {
  return tab === "trophies";
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
    case "rating":
      // Game-specific Elo, exactly as the server ranked it. Never derived
      // from, or mixed with, any other game's rating.
      return formatNumber(field("rating"));
    case "trophies": {
      // The cross-game trophy total and how many different games contributed —
      // both server-computed; never a token/winnings metric.
      const trophies = formatNumber(item.overallTrophies ?? item.overall_trophies);
      const games = formatNumber(item.gamesPlayed ?? item.games_played);
      return `${trophies} Trophies · ${games} games`;
    }
    case "overall": {
      // The aggregate Elo and how many different games qualified for it —
      // both server-computed, never a token/winnings metric.
      const elo = formatNumber(item.overallElo ?? item.overall_elo);
      const games = formatNumber(item.eligibleGames ?? item.eligible_games);
      return `${elo} Elo · ${games} games`;
    }
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
  const metricLabel = isTrophyTab(tab)
    ? "Trophies"
    : isPerGameTab(tab)
      ? "Elo"
      : isOverallTab(tab)
        ? "Overall Elo"
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
            <span
              className={`mt-1.5 w-full truncate text-xs font-semibold text-[#c9f7ff] sm:text-sm ${cosmeticEffectClass(item.profileFrame?.usernameEffect?.visual) || ""}`}
            >
              {item.user?.name || item.name}
            </span>
            <ProvisionalChip item={item} className="mt-0.5" />
            {!isOverallTab(tab) && !isTrophyTab(tab) && (
              <OverallEloBadge item={item} className="mt-0.5" />
            )}
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

// `adSlot` is the server-rendered <AdSlot placement="leaderboard" /> from
// app/classement/page.jsx — above the footer, after the boards.
export default function LeaderboardPage({ adSlot = null }) {
  const { t } = useTranslation();
  const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
  const [tab, setTab] = useState("all-time");
  const [category, setCategory] = useState("wins");
  const [game, setGame] = useState("chess");

  // Deep link: the casino lobby's per-game shortcut
  // (/classement?game=<leaderboardKey>) opens that game's Elo board directly.
  // Ids without an Elo board are ignored, so a solo game's link never lands
  // on a fabricated board.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const requested = new URLSearchParams(window.location.search).get("game");
    const key = ratedGameFromParam(requested);
    if (!key) return;
    setGame(key);
    setTab("per-game");
  }, []);

  const selectTab = (next) => {
    setTab(next);
    // pvp_wins is all-time only — fall back to the headline metric on the
    // other tabs (which have no categories).
    if (next !== "all-time" && category === "pvp_wins") setCategory("wins");
  };
  // Per-game boards always rank by that game's current Elo; the Overall tab
  // ranks by the cross-game aggregate.
  const displayCategory = isPerGameTab(tab)
    ? "rating"
    : isTrophyTab(tab)
      ? "trophies"
      : isOverallTab(tab)
        ? "overall"
        : category;
  const myClerkId = isSignedIn ? user?.id : null;

  const endpoint = useMemo(() => {
    // The cross-game Overall Trophies board — the headline competitive board,
    // ranked by each player's summed per-game trophies.
    if (tab === "trophies") return `/api/leaderboard/trophy-overall?limit=50`;
    // The cross-game Overall Elo board — an aggregate of established game
    // ratings, restricted to players with enough different games.
    if (tab === "overall") return `/api/leaderboard/overall?limit=50`;
    // The game-specific Elo board — one independent ladder per game.
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

  // Cache-first: the board paints immediately from the persisted SWR cache
  // and refreshes in the background (and again automatically on reconnect).
  const board = useApiResource(endpoint);
  const statsResource = useApiResource(isSignedIn ? "/api/user/stats" : null);

  const items = Array.isArray(board.data?.items) ? board.data.items : [];
  const me = board.data?.me || null;
  // Authoritative game list from the API (falls back to the first-paint
  // mirror before the board loads), so the tabs can never drift from
  // RATED_GAMES on the server.
  const games =
    Array.isArray(board.data?.games) && board.data.games.length > 0
      ? board.data.games
      : RATED_GAMES_FALLBACK;
  const myStats = statsResource.data?.userStats || null;
  const loading = board.isLoading;
  const error = board.error
    ? board.error.message || t("leaderboard.load_error")
    : null;
  const refresh = board.refresh;

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

        {/* GRYND PRO — a browsing page, so the upgrade CTA is allowed here. */}
        <div className="mb-6 flex justify-center">
          <UpgradeProButton variant="compact" />
        </div>

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
                {x === "trophies"
                  ? "Trophies"
                  : x === "all-time"
                  ? "All-Time"
                  : x === "overall"
                    ? "Overall Elo"
                    : x === "per-game"
                      ? "Per-Game Elo"
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
              {games.map((g) => (
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
          !isStreakTab(tab) &&
          !isOverallTab(tab) &&
          !isTrophyTab(tab) && (
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

        {isTrophyTab(tab) && (
          <p className="mb-4 text-center text-xs text-cyan-200/70">
            Ranked by{" "}
            <span className="font-bold text-[#f5ff3b]">total trophies</span>{" "}
            — the sum of every rated game. A win is +30, a loss −30. Players
            need trophies in at least{" "}
            <span className="font-bold text-[#f5ff3b]">
              {Number(board.data?.minGames || 3)} different games
            </span>{" "}
            to qualify.
          </p>
        )}

        {isPerGameTab(tab) && (
          <p className="mb-4 text-center text-xs text-cyan-200/70">
            Ranked by current{" "}
            <span className="font-bold text-[#f5ff3b]">Elo for this game only</span>{" "}
            — every game has its own independent rating. Players still in
            placement are marked{" "}
            <span className="font-bold text-amber-300">Provisional</span>.
          </p>
        )}

        {isOverallTab(tab) && (
          <p className="mb-4 text-center text-xs text-cyan-200/70">
            The average of each player&apos;s{" "}
            <span className="font-bold text-[#f5ff3b]">established game ratings</span>{" "}
            across at least{" "}
            <span className="font-bold text-[#f5ff3b]">
              {Number(board.data?.minGames || 3)} different games
            </span>
            . Provisional ratings never count.
          </p>
        )}

        {!isStreakTab(tab) &&
          !isPerGameTab(tab) &&
          !isOverallTab(tab) &&
          category === "win_rate" && (
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
                    return it). The Overall tab shows the aggregate instead —
                    its rows carry no per-game win/loss record. */}
                {isTrophyTab(tab) ? (
                  <p className="mt-0.5 text-sm text-cyan-200/80">
                    <span className="font-bold text-[#f5ff3b]">
                      {formatNumber(me.overallTrophies)} Trophies
                    </span>
                    {" · "}
                    {formatNumber(me.gamesPlayed)}{" "}
                    {Number(me.gamesPlayed) === 1 ? "game" : "games"}
                  </p>
                ) : isOverallTab(tab) ? (
                  <p className="mt-0.5 text-sm text-cyan-200/80">
                    <span className="font-bold text-[#f5ff3b]">
                      {formatNumber(me.overallElo)} Overall Elo
                    </span>
                    {" · "}
                    {formatNumber(me.eligibleGames)}{" "}
                    {Number(me.eligibleGames) === 1 ? "game" : "games"}
                  </p>
                ) : (
                  <RecordLine item={me} />
                )}
                {isPerGameTab(tab) && me.provisional && (
                  <p className="mt-2 text-xs text-amber-300">
                    Provisional — {Number(me.provisionalGamesCompleted || 0)} of{" "}
                    {Number(me.provisionalGamesTotal || 0)} placement matches{" "}
                    completed in this game.
                  </p>
                )}
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
                {isPerGameTab(tab) && me && (
                  <p className="mt-3 text-center text-xs text-cyan-200/80">
                    Your {board.data?.label || "game"} rating:{" "}
                    <span className="font-bold text-[#f5ff3b]">
                      {formatNumber(me.rating)} Elo
                    </span>
                    <ProvisionalChip item={me} />
                  </p>
                )}
                {isOverallTab(tab) && me && (
                  <p className="mt-3 text-center text-xs text-cyan-200/80">
                    Your Overall Elo:{" "}
                    <span className="font-bold text-[#f5ff3b]">
                      {formatNumber(me.overallElo)}
                    </span>{" "}
                    across {formatNumber(me.eligibleGames)} games.
                  </p>
                )}
                {isTrophyTab(tab) && me && (
                  <p className="mt-3 text-center text-xs text-cyan-200/80">
                    Your total:{" "}
                    <span className="font-bold text-[#f5ff3b]">
                      {formatNumber(me.overallTrophies)} Trophies
                    </span>{" "}
                    across {formatNumber(me.gamesPlayed)} games.
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

        <AsyncState
          className="w-full overflow-x-auto rounded-lg border border-[#00e5ff]/50 bg-[#08142f] p-4 shadow-[0_0_28px_rgba(0,229,255,0.2)]"
          isLoading={loading}
          error={board.error}
          hasData={board.hasData}
          isEmpty={items.length === 0}
          onRetry={refresh}
          cachedAt={board.cachedAt}
          skeleton={
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
          }
          empty={
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
          }
        >
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
                      {isTrophyTab(tab)
                        ? "Trophies"
                        : isStreakTab(tab)
                          ? "Days"
                          : isPerGameTab(tab)
                            ? "Elo"
                            : isOverallTab(tab)
                              ? "Overall Elo"
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
                                <span
                                  className={`block max-w-[9rem] truncate font-semibold text-[#c9f7ff] transition-colors hover:text-[#00e5ff] hover:underline sm:max-w-none ${cosmeticEffectClass(item.profileFrame?.usernameEffect?.visual) || ""}`}
                                >
                                  {item.user?.name || item.name}
                                  {item.prestigeBadge && (
                                    <span className="ml-1.5 rounded-full border border-violet-400/70 bg-violet-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-300">
                                      {item.prestigeBadge}
                                    </span>
                                  )}
                                  <ProvisionalChip item={item} />
                                  {!isOverallTab(tab) && !isTrophyTab(tab) && (
                                    <OverallEloBadge item={item} />
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
        </AsyncState>

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
        {adSlot}
        <Footer />
      </div>
    </div>
  );
}