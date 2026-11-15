"use client";

import ShareLadderButton from "../../components/share/ShareLadderButton";

import { isGameAvailable } from "../../lib/gameAvailability";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import FrameAvatar from "../../components/FrameAvatar";
import ProBadge from "../../components/ProBadge";
import { cosmeticEffectClass } from "../../lib/profileCosmetics";
import { useTranslation } from "../../hooks/useTranslation";
import { useApiResource } from "../../hooks/useApiResource";
import AsyncState from "../../components/states/AsyncState";
import UpgradeProButton from "../../components/UpgradeProButton";
import ReportEntryButton from "../../components/reports/ReportEntryButton";
import PlayerLevelBadge from "../../components/player-level/PlayerLevelBadge";

// The five boards the page offers. `trophies` reads the ALL-TIME PEAK board —
// the label is "Trophies" but the number is the best total ever reached, by
// product decision. `all-time` ranks RANKED wins only, and the two streak tabs
// read the daily streak counters. There are no sub-categories: one tab, one
// ranking.
const TABS = ["trophies", "all-time", "daily-deal", "daily-current", "daily-best"];

const TAB_LABELS = {
  trophies: "Trophies",
  "all-time": "All-Time wins",
  "daily-deal": "Daily Deal best time",
  "daily-current": "Daily Streak",
  "daily-best": "Best Streak",
};

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
  { key: "lane-rush-duel", label: "Lane Rush Duel" },
  { key: "dice-flush", label: "Dice Flush" },
  { key: "rps-pvp", label: "Rock Paper Scissors" },
  { key: "odds-pvp", label: "Odds" },
  { key: "uno", label: "Neon Flush" },
  { key: "tower-arena", label: "Tower Arena" },
  { key: "hex-duel", label: "Hex Duel" },
  { key: "mini-golf", label: "Mini Golf" },
  { key: "speed-typing", label: "Speed Typing" },
  { key: "tic-tac-toe", label: "Ultimate Tic-Tac-Toe" },
  { key: "solitaire-duel", label: "Solitaire Duel" },
  { key: "sudoku-duel", label: "Sudoku Duel" },
  { key: "barricade", label: "Barrier Blitz" },
  { key: "dominoes", label: "Dominoes" },
  // Hillstrike joined the rated registry without being mirrored here, which
  // made the first-paint game list disagree with the server on load.
  { key: "hillstrike", label: "Hillstrike" },
  { key: "battleship", label: "Battleship" },
];

/** The first-paint mirror the UI offers: archived games keep their rows in
 *  the list above (so reactivation needs no edit here) but get no public tab. */
const AVAILABLE_RATED_GAMES = RATED_GAMES_FALLBACK.filter((game) =>
  isGameAvailable(game.key),
);

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function isStreakTab(tab) {
  return tab === "daily-current" || tab === "daily-best";
}

/** `m:ss` for a millisecond duration — what the Daily Deal board ranks by. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function getMetricValue(item, tab) {
  if (tab === "trophies") {
    // Peak trophies, under the "Trophies" label by product decision.
    const peak = formatNumber(item.peakTrophies ?? item.peak_trophies);
    const games = formatNumber(item.gamesPlayed ?? item.games_played);
    return `${peak} Trophies · ${games} games`;
  }
  if (tab === "all-time") return `${formatNumber(item.wins)} wins`;
  if (tab === "daily-deal") return formatDuration(item.best_ms ?? item.bestMs);
  const field = tab === "daily-current" ? "daily_streak_current" : "daily_streak_best";
  return `${formatNumber(item[field])} days`;
}

/**
 * Compact ranked W-L line shown under each player's name. No win rate: it is
 * a profile stat, not a leaderboard one.
 */
function RecordLine({ item }) {
  const wins = Number(item.wins || 0);
  const losses = Number(item.losses || 0);
  const streak = Number(item.current_streak || 0);
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

/**
 * The NUMBER a podium share names. `getMetricValue` returns display text
 * ("1,450 Trophies · 4 games"); a shared standing wants the figure itself, and
 * `null` for boards ranked by a percentage or a ratio, where "my 82.50%" would
 * be a different claim than a point total.
 */
function shareScoreForPodium(item, category) {
  const numeric = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  if (category === "trophies") {
    return numeric(item.peakTrophies ?? item.peak_trophies);
  }
  if (category === "all-time") return numeric(item.wins);
  // Streak boards and the time board share no comparable point total.
  return null;
}

/** Top-3 podium — real board data, never fabricated. */
function Podium({ items, myClerkId, tab, category }) {
  if (!items || items.length === 0) return null;
  const order = items.length === 1 ? [0] : items.length === 2 ? [1, 0] : [1, 0, 2];
  const metricLabel =
    tab === "trophies"
      ? "Trophies"
      : tab === "all-time"
        ? "Ranked wins"
        : tab === "daily-deal"
          ? "Best time"
          : "Days";

  return (
    <div className="mb-6 grid grid-cols-3 gap-2 sm:gap-3">
      {order.map((idx) => {
        const item = items[idx];
        if (!item) return <div key={`podium-empty-${idx}`} />;
        const isMe = myClerkId && item.clerk_id === myClerkId;
        const isFirst = item.rank === 1;
        return (
          // The card is a link to the profile, so the share entry sits BESIDE
          // it: a button may not nest inside an anchor.
          <div key={`${item.clerk_id}-${item.rank}`} className="relative flex flex-col">
          <Link
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
            {/* The membership is visible where it matters: on the ladder. */}
            {item.isPro && <ProBadge className="mt-1" />}
            {item.playerLevel && (
              <PlayerLevelBadge
                level={item.playerLevel.level}
                rankKey={item.playerLevel.rankKey}
                size="compact"
                className="mt-1"
              />
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
              {getMetricValue(item, tab)}
            </span>
            <span className="text-[9px] uppercase tracking-wider text-cyan-200/60 sm:text-[10px]">
              {metricLabel}
            </span>
          </Link>
          {/* Only the viewer's OWN card: sharing someone else's standing would
              put words in their mouth. Rank and score are the row the server
              ranked, never recomputed here. */}
          {isMe && (
            <div className="mt-1.5 flex justify-center">
              <ShareLadderButton
                rank={item.rank}
                score={shareScoreForPodium(item, category)}
                testId={`leaderboard-share-${item.rank}`}
              />
            </div>
          )}
          </div>
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
export default function LeaderboardPage({ adSlot = null, hilltopSlot = null }) {
  const { t } = useTranslation();
  const { isLoaded: clerkLoaded, isSignedIn, user } = useUser();
  const [tab, setTab] = useState("all-time");
  const myClerkId = isSignedIn ? user?.id : null;

  const endpoint = useMemo(() => {
    // Trophies = the all-time PEAK board: the label names the unit, the number
    // is the best total the player ever reached.
    if (tab === "trophies") return `/api/leaderboard/trophy-peak?limit=50`;
    // All-Time wins. The counters behind this board move only from settled
    // human-vs-human results (applyLeaderboardCounters has no solo, practice or
    // daily caller), so this is the ranked win count, not an every-mode total.
    if (tab === "all-time")
      return `/api/leaderboard/all-time?limit=50&category=wins`;
    // The fastest verified Daily Deal completion per player.
    if (tab === "daily-deal")
      return `/api/leaderboard/daily-deal-best-time?limit=50`;
    if (tab === "daily-current")
      return `/api/leaderboard/daily-streak?type=current&limit=50`;
    return `/api/leaderboard/daily-streak?type=best&limit=50`;
  }, [tab]);

  // Cache-first: the board paints immediately from the persisted SWR cache
  // and refreshes in the background (and again automatically on reconnect).
  const board = useApiResource(endpoint);
  const statsResource = useApiResource(isSignedIn ? "/api/user/stats" : null);

  const items = Array.isArray(board.data?.items) ? board.data.items : [];
  const me = board.data?.me || null;
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

        {/* Advertising — OUTSIDE the board. It sits between the page intro and
            the ranking controls, so it is never inside the table, never
            between two ranks and never over a tab or a player row. The
            footer slot stays at the very bottom, so the two providers are not
            stacked into one dense block. */}
        {hilltopSlot}

        {/* Tab bar — scrolls horizontally on mobile instead of wrapping. */}
        <div className="mb-6 -mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          <div className="flex w-max min-w-full justify-start gap-2 sm:justify-center">
            {TABS.map((x) => (
              <button
                key={x}
                onClick={() => setTab(x)}
                aria-pressed={tab === x}
                className={`shrink-0 whitespace-nowrap rounded-lg border px-4 py-2 text-sm font-semibold transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f] ${tab === x ? "border-[#f5ff3b]/60 bg-[#f5ff3b] text-[#041125]" : "border-[#00e5ff]/50 bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"}`}
              >
                {x === "trophies"
                  ? "Trophies"
                  : x === "peak"
                    ? "Peak Trophies"
                    : x === "trophy-gains"
                      ? "Trophy Gains"
                      : x === "all-time"
                  ? "All-Time wins"
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
                          : x === "daily-deal"
                            ? "Daily Deal best time"
                            : <span>Weekly Best Streak <svg className="w-4 h-4 inline text-[#f5ff3b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2Z"/></svg></span>}
              </button>
            ))}
          </div>
        </div>

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
                </p>
                {/* Real board record (weekly/all-time/per-game/streak rows all
                    return it). The Overall tab shows the aggregate instead —
                    its rows carry no per-game win/loss record. */}
                {tab === "trophies" ? (
                  <p className="mt-0.5 text-sm text-cyan-200/80">
                    <span className="font-bold text-[#f5ff3b]">
                      {formatNumber(me.peakTrophies)} Trophies
                    </span>
                    {" · "}
                    {formatNumber(me.overallTrophies)} current
                  </p>
                ) : tab === "daily-deal" ? (
                  <p className="mt-0.5 text-sm text-cyan-200/80">
                    <span className="font-bold text-[#f5ff3b]">
                      {formatDuration(me.best_ms ?? me.bestMs)}
                    </span>{" "}
                    best time
                    {me.runs ? ` · ${formatNumber(me.runs)} daily deals` : ""}
                  </p>
                ) : isStreakTab(tab) ? (
                  <p className="mt-0.5 text-sm text-cyan-200/80">
                    {getMetricValue(me, tab)}
                  </p>
                ) : (
                  <RecordLine item={me} />
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
                className="rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-4 py-2 text-sm font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a214d]"
              >
                {me ? climbCtaLabel : "PLAY NOW"}
              </Link>
              <Link
                href="/profil"
                className="rounded-lg border border-[#00e5ff]/50 bg-[#0a214d] px-4 py-2 text-sm font-semibold text-[#00e5ff] transition-all hover:bg-[#123b82] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a214d]"
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
              </>
            )}
          </div>
        )}

        {showPodium && (
          <Podium
            items={items.slice(0, 3)}
            myClerkId={myClerkId}
            tab={tab}
            category={tab}
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
                    <div className="h-3.5 w-2/5 rounded-sm bg-white/10" />
                    <div className="h-2.5 w-1/3 rounded-sm bg-white/5" />
                  </div>
                  <div className="h-4 w-12 shrink-0 rounded-sm bg-white/10" />
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
                className="mt-1 rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-5 py-2.5 text-sm font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
              >
                PLAY NOW
              </Link>
            </div>
          }
        >
          <AnimatePresence mode="wait">
              <motion.table
                key={tab}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="w-full border-collapse text-left"
              >
                <thead>
                  <tr className="border-b border-[#00e5ff]/50 text-[#f5ff3b]">
                    <th className="px-2 py-2 text-xs uppercase tracking-wider sm:px-3">#</th>
                    <th className="px-2 py-2 text-xs uppercase tracking-wider sm:px-3">Player</th>
                    <th className="px-2 py-2 text-right text-xs uppercase tracking-wider sm:px-3 sm:text-left">
                      {tab === "trophies"
                        ? "Trophies"
                        : tab === "all-time"
                          ? "Ranked wins"
                          : tab === "daily-deal"
                            ? "Best time"
                            : "Days"}
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
                              className="flex min-w-0 items-center gap-2.5 rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
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
                                  {item.isPro && <ProBadge className="ml-1.5" />}
                                  {item.playerLevel && (
                                    <PlayerLevelBadge
                                      level={item.playerLevel.level}
                                      rankKey={item.playerLevel.rankKey}
                                      size="compact"
                                      className="ml-1.5"
                                    />
                                  )}
                                </span>
                                {!isStreakTab(tab) &&
                                  tab !== "trophies" &&
                                  tab !== "daily-deal" && (
                                    <RecordLine item={item} />
                                  )}
                              </span>
                            </Link>
                            {isMe ? (
                              <span className="shrink-0 rounded-full bg-[#f5ff3b] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#041125]">
                                You
                              </span>
                            ) : (
                              <ReportEntryButton
                                reportedClerkId={item.clerk_id}
                                reportedPlayerName={item.user?.name || item.name || "Player"}
                                gameType="leaderboard"
                                contextLabel="Leaderboard"
                              />
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 text-right font-bold text-green-300 sm:px-3 sm:text-left">
                          {getMetricValue(item, tab)}
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
          <div className="mx-auto mt-6 flex max-w-2xl flex-col items-center gap-4 rounded-lg border border-[#f5ff3b]/30 bg-linear-to-br from-[#0a214d] to-[#08142f] p-6 text-center shadow-[0_0_24px_rgba(245,255,59,0.1)] sm:flex-row sm:justify-between sm:text-left">
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
              className="shrink-0 rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff] px-5 py-2.5 text-sm font-bold text-[#001933] transition-all hover:bg-[#00e5ff]/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08142f]"
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