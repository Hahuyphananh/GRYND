"use client";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { useUser } from "@clerk/nextjs";
import React, { useEffect, useState } from "react";
import IconAvatar from "../../components/IconAvatar";
import Img1 from "../../images/rouletteimage.png";
import Img2 from "../../images/blackjackimage.png";
import Img3 from "../../images/pokerimage.png";
import Img4 from "../../images/plinkoimage.png";
import Img6 from "../../images/crashimage.png";
import Img7 from "../../images/chessimage.png";
import Img10 from "../../images/kenoimage.png";
import Img11 from "../../images/uno game div.webp";
import Img12 from "../../images/rockpaperscissorsimage.png";
import Img14 from "../../images/four-in-a-row-card.png";
import ImgLaneRush from "../../images/lanerushimage.png";
import Img17 from "../../images/poolmastersimage.png";
import Img18 from "../../images/hexduelimage.png";
import Img21 from "../../images/odds.svg";
import Img19 from "../../images/dice-flush.svg";
import Img22 from "../../images/precision.svg";
import ImgDotsBoxes from "../../images/dots-and-boxes.svg";
import ImgTowerArena from "../../images/towersimage.jpg";
import ImgMinesPvp from "../../images/minesimage.png";
import ImgMemoryGrid from "../../images/memorygridimage.png";
import Image from "next/image";
import Link from "next/link";
import { useTranslation } from "../../hooks/useTranslation";
import { IconClock } from "@tabler/icons-react";
import StickyMobileCta from "../../components/StickyMobileCta";
import CreatorModeLobby from "../../components/creator-mode/CreatorModeLobby";
import { buildCreatorHref } from "../../lib/creator-mode/client";
import { clearPlayedGames, getPlayedGames } from "../../lib/recentlyPlayed";

// sessionStorage keys for the lobby's persisted state (UX plan P1-1): the
// search box + active filter survive a refresh / back-navigation within the
// browser session, so a returning player lands where they left off instead
// of re-scanning the full grid.
const LOBBY_SEARCH_KEY = "grynd.lobby.search.v1";
const LOBBY_FILTER_KEY = "grynd.lobby.filter.v1";
const LOBBY_SORT_KEY = "grynd.lobby.sort.v1";

function readStored(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    return window.sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function MainComponent() {
  const { user } = useUser();
  const [selectedGame, setSelectedGame] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(() => readStored(LOBBY_SEARCH_KEY, ""));
  const [activeFilter, setActiveFilter] = useState(() => {
    const stored = readStored(LOBBY_FILTER_KEY, "all");
    console.log("[LOBBYDBG] filter init from storage:", stored);
    return ["all", "duels", "multiplayer", "popular"].includes(stored) ? stored : "all";
  });
  // Sort is a separate concern from filtering: filters narrow the set
  // (kind of game), sort reorders it. Persisted per session like the
  // filter so a returning player keeps their ordering.
  const [sortOrder, setSortOrder] = useState(() => {
    const stored = readStored(LOBBY_SORT_KEY, "featured");
    return ["featured", "most-played", "az", "newest"].includes(stored)
      ? stored
      : "featured";
  });
  // Per-game play counts (real data from /api/game-plays) powering the
  // "Most Played" sort. Loaded once per mount; missing counts simply fall
  // back to the featured order — never invented numbers.
  const [playCounts, setPlayCounts] = useState(null);
  const [recentGames, setRecentGames] = useState([]);
  const [friendPresenceByGame, setFriendPresenceByGame] = useState({});
  // First-battle card — shown to accounts that abandoned the /welcome flow
  // (onboarding incomplete) so the lobby hands them a clear first step
  // instead of a 22-game wall. Real signal from /api/onboarding/status;
  // dismissible per session.
  const [firstBattle, setFirstBattle] = useState(false);

  // Creator Mode (admin-only): when enabled, game links carry ?creator=1
  // so the shared CreatorModeProvider inside each game picks it up.
  const [creatorModeEnabled, setCreatorModeEnabled] = useState(false);
  const { t } = useTranslation();

  // Persist search + filter for the session (UX plan P1-1). Written on
  // every change; read once on mount via the lazy initializers above.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(LOBBY_SEARCH_KEY, search);
    } catch {}
  }, [search]);

  useEffect(() => {
    console.log("[LOBBYDBG] filter effect writing:", activeFilter);
    try {
      window.sessionStorage.setItem(LOBBY_FILTER_KEY, activeFilter);
    } catch {}
  }, [activeFilter]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(LOBBY_SORT_KEY, sortOrder);
    } catch {}
  }, [sortOrder]);

  // Recently played (UX plan P1-1): read once on mount. Games record a
  // play through <CreatorModeHost /> (autoStart edge), so returning to
  // the lobby shows a "Play again" strip of the last sessions.
  useEffect(() => {
    setRecentGames(getPlayedGames());
  }, []);

  // First-time guidance: a brand-new account that never finished the
  // /welcome flow gets a "pick your first battle" card above the grid.
  // Once onboarding is complete (or the card is dismissed) it never
  // comes back.
  useEffect(() => {
    if (!user) {
      setFirstBattle(false);
      return;
    }
    let cancelled = false;
    const dismissKey = "grynd:lobby:first-battle:dismissed";
    try {
      if (sessionStorage.getItem(dismissKey) === "1") {
        setFirstBattle(false);
        return;
      }
    } catch {
      // sessionStorage unavailable — still allow the card
    }
    fetch("/api/onboarding/status", { credentials: "include" })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (cancelled) return;
        setFirstBattle(
          Boolean(data?.success && data.onboardingCompleted === false),
        );
      })
      .catch(() => {
        if (!cancelled) setFirstBattle(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const fetchFriendPresence = async () => {
    try {
      const response = await fetch("/api/friends/game-presence", {
        credentials: "include",
      });
      const data = await response.json();
      if (response.ok && data.success) setFriendPresenceByGame(data.byGame || {});
    } catch (err) {
      console.error("[FRIEND_PRESENCE_ERROR]", err);
    }
  };

  // playsKey = the gameLabel the game page passes to <CreatorModeHost />
  // (the exact key the play counter is stored under). Matches the real
  // values across src/app/casino/* — verified against every gameLabel="…"
  // in the codebase; the play-count sort only works if these line up.
  const games = [
    {
      name: "Roulette",
      href: "/casino/roulette",
      leaderboardKey: "roulette",
      playsKey: "roulette",
      image: Img1,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.roulette_desc",
      pvpMode: "1v1",
      popular: true,
    },
    {
      name: "Blackjack",
      href: "/casino/blackjack",
      leaderboardKey: "blackjack",
      playsKey: "blackjack",
      image: Img2,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.blackjack_desc",
      pvpMode: "1v1",
      popular: true,
    },
    {
      name: "Mines Duel",
      href: "/casino/mines-pvp",
      leaderboardKey: "mines-pvp",
      recencyKey: "mines-duel",
      playsKey: "mines-duel",
      image: ImgMinesPvp,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.mines_pvp_desc",
      nameKey: "games.mines_pvp_name",
      pvpMode: "1v1",
      popular: true,
    },
    {
      name: "Memory Grid",
      href: "/casino/memory-grid",
      leaderboardKey: "memory-grid",
      playsKey: "memory-grid",
      image: ImgMemoryGrid,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.memory_grid_desc",
      nameKey: "games.memory_grid_name",
      pvpMode: "1v1",
      popular: true,
    },

    {
      name: "Plinko",
      href: "/casino/plinko",
      leaderboardKey: "plinko",
      recencyKey: "plinko-duel",
      playsKey: "plinko-duel",
      image: Img4,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.plinko_desc",
      pvpMode: "1v1",
      popular: true,
    },
    {
      name: "Poker",
      href: "/casino/poker/multi",
      leaderboardKey: "poker",
      playsKey: "poker",
      image: Img3,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.poker_desc",
      pvpMode: "multi",
    },

    {
      name: "Crash Arena",
      href: "/casino/crash-arena",
      leaderboardKey: "crash",
      playsKey: "crash-arena",
      image: Img6,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.crash_arena_desc",
      pvpMode: "multi",
    },
    {
      name: "Échecs",
      href: "/casino/chess",
      leaderboardKey: "chess",
      playsKey: "chess",
      image: Img7,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.chess_desc",
      nameKey: "games.chess_name",
      pvpMode: "1v1",
    },
    {
      name: "Keno",
      href: "/casino/keno",
      leaderboardKey: "keno",
      playsKey: "keno",
      image: Img10,
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.keno_desc",
      pvpMode: "1v1",
    },
    {
      name: "Neon Flush",
      href: "/casino/neon-flush",
      leaderboardKey: "uno",
      recencyKey: "uno-multiplayer",
      playsKey: "uno-multiplayer",
      image: Img11,
      descriptionKey: "games.uno_desc",
      pvpMode: "multi",
    },
    {
      name: "Roche-Papier-Ciseaux",
      href: "/casino/rps",
      leaderboardKey: "rps",
      recencyKey: "rock-paper-scissors",
      playsKey: "rock-paper-scissors",
      image: Img12,
      descriptionKey: "games.rps_desc",
      nameKey: "games.rps_name",
      pvpMode: "1v1",
    },
    {
      name: "Tower Arena",
      href: "/casino/tower-arena",
      leaderboardKey: "tower-arena",
      playsKey: "tower-arena",
      image: ImgTowerArena,
      descriptionKey: "games.tower_arena_desc",
      pvpMode: "multi",
    },
    {
      name: "Four-In-A-Row",
      href: "/casino/four-in-a-row",
      leaderboardKey: "four-in-a-row",
      playsKey: "four-in-a-row",
      image: Img14,
      // Bigger board + gentler hover zoom so the full board stays visible.
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.four_in_a_row_desc",
      pvpMode: "1v1",
    },

    {
      name: "Lane Rush Duel",
      href: "/casino/lane-runner",
      leaderboardKey: "lane-runner",
      recencyKey: "lane-rush-duel",
      playsKey: "lane-rush-duel",
      image: ImgLaneRush,
      // Gentler hover zoom so the twin towers stay fully visible.
      imageClassName: "group-hover:scale-[1.03]",
      descriptionKey: "games.lane_runner_desc",
      pvpMode: "1v1",
    },
    {
      name: "Pool Masters",
      href: "/casino/pool-masters",
      leaderboardKey: "pool-masters",
      playsKey: "pool-masters",
      image: Img17,
      descriptionKey: "games.pool_masters_desc",
      pvpMode: "1v1",
    },

    {
      name: "HEX DUEL",
      href: "/casino/hex-duel",
      leaderboardKey: "hex-duel",
      playsKey: "hex-duel",
      image: Img18,
      descriptionKey: "games.hex_duel_desc",
      nameKey: "games.hex_duel_name",
      pvpMode: "1v1",
    },
     {
      name: "Dice Flush",
      href: "/casino/dice-flush",
      leaderboardKey: "yahtzee",
      playsKey: "dice-flush",
      image: Img19,
      descriptionKey: "games.dice_flush_desc",
      pvpMode: "1v1",
      popular: true,
    },
    {
      name: "Odds",
      href: "/casino/odds",
      leaderboardKey: "odds",
      playsKey: "odds",
      image: Img21,
      descriptionKey: "games.odds_desc",
      nameKey: "games.odds_name",
      pvpMode: "1v1",
      popular: true,
    },
    {
      name: "Precision",
      href: "/casino/precision",
      leaderboardKey: "precision",
      playsKey: "precision",
      image: Img22,
      descriptionKey: "games.precision_desc",
      nameKey: "games.precision_name",
      pvpMode: "1v1",
    },
    {
      name: "Dots & Boxes",
      href: "/casino/dots-and-boxes",
      leaderboardKey: "dots-and-boxes",
      playsKey: "dots-and-boxes",
      image: ImgDotsBoxes,
      descriptionKey: "games.dots_and_boxes_desc",
      nameKey: "games.dots_and_boxes_name",
      pvpMode: "1v1",
    },
  ];

  const filteredGames = games.filter((game) =>
    (game.nameKey ? t(game.nameKey) : game.name).toLowerCase().includes(search.toLowerCase())
  );

  const newestOrder = [
    "memory-grid",
    "mines-pvp",
    "dots-and-boxes",
    "precision",
    "yahtzee",
    "hex-duel",
    "pool-masters",
    "odds",
    "lane-runner",
    "four-in-a-row",
    "rps",
    "neon-flush",
    "keno",
    "chess",
    "crash",
    "poker",
    "plinko",
    "blackjack",
    "roulette",
  ];

  let displayedGames = [...filteredGames];

  // Filters narrow the set — kind of game. Sorts reorder it (below).
  if (activeFilter === "duels") {
    displayedGames = displayedGames.filter((g) => g.pvpMode === "1v1");
  } else if (activeFilter === "multiplayer") {
    displayedGames = displayedGames.filter((g) => g.pvpMode === "multi");
  } else if (activeFilter === "popular") {
    displayedGames = displayedGames.filter((g) => g.popular);
  }

  // Games at the top of the newest order get a "NEW" badge on their card.
  // Ordered newest-first (see `newestOrder` below), so the first N entries
  // are the most recently shipped games.
  const NEW_BADGE_COUNT = 4;
  const newestKeys = newestOrder.slice(0, NEW_BADGE_COUNT);

  // Real sort orders. "Featured" is the hand-ordered default; "Newest" is
  // the recency list; "A–Z" is the localized display name; "Most Played"
  // uses REAL play counts from /api/game-plays (games with no recorded
  // count yet sort to the bottom, never invented).
  if (sortOrder === "az") {
    displayedGames.sort((a, b) =>
      (a.nameKey ? t(a.nameKey) : a.name).localeCompare(
        b.nameKey ? t(b.nameKey) : b.name,
      ),
    );
  } else if (sortOrder === "newest") {
    displayedGames.sort(
      (a, b) => newestOrder.indexOf(a.leaderboardKey) - newestOrder.indexOf(b.leaderboardKey),
    );
  } else if (sortOrder === "most-played") {
    displayedGames.sort((a, b) => {
      const pa = Number(playCounts?.[a.playsKey] ?? 0);
      const pb = Number(playCounts?.[b.playsKey] ?? 0);
      return pb - pa;
    });
  }

  // Real play counts for the "Most Played" sort. Fetched once per mount
  // (global counts change slowly); a failure just leaves the featured
  // order in place for that session.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/game-plays", { cache: "no-store" })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (cancelled || !data?.success || !data.counts) return;
        setPlayCounts(data.counts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    // Friend presence is social chrome, not game state. Throttled from 30s
    // to 60s (and the endpoint now caches per user) to cut idle read load.
    // Only poll while the tab is visible — background tabs don't need it.
    let id = null;
    const start = () => {
      fetchFriendPresence();
      id = setInterval(fetchFriendPresence, 60000);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () =>
      document.visibilityState === "visible" ? start() : stop();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);

  const GameCard = ({ game }) => (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] hover:border-[#00e5ff]/60 hover:shadow-[0_0_30px_rgba(0,229,255,0.4)] focus-within:ring-2 focus-within:ring-[#00e5ff] focus-within:ring-offset-2 focus-within:ring-offset-[#040d24]">
      <Link
        href={buildCreatorHref(game.href, creatorModeEnabled)}
        className="block cursor-pointer focus-visible:outline-none"
        aria-label={`Play ${game.nameKey ? t(game.nameKey) : game.name}`}
      >
        <div className="mb-3 relative aspect-video overflow-hidden rounded-lg">
          <Image
            src={game.image}
            alt={game.nameKey ? t(game.nameKey) : game.name}
            quality={85}
            loading="lazy"
            // Source art is 1.6–2.4MB PNGs — the card only ever displays
            // at ~3–4 columns wide, so let the optimizer serve a
            // viewport-sized variant instead of the full-res original.
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            className={`h-full w-full object-cover object-center transition-transform group-hover:scale-110 ${game.imageClassName || ""}`}
          />
          {/* PvP mode badge — real product data: every GRYND game is
              competitive. 1v1 duels vs multiplayer tables. */}
          <span className="absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm">
            {game.pvpMode === "multi"
              ? t("home.casino_lobby.pvp_multi_badge")
              : t("home.pvp_badge")}
          </span>
          {/* Popular / New badges — brand neon pills over the card art.
              Purely informational chrome: aria-hidden so screen readers
              don't double-announce what the game title already says. */}
          {/* NEW takes priority: the newest games always carry the recency
              badge even when they're also popular, so the recency signal is
              unambiguous (popularity stays discoverable via the filter). */}
          {newestKeys.includes(game.leaderboardKey) && (
            <span
              aria-hidden="true"
              className="absolute right-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm"
            >
              {t("home.casino_lobby.badge_new")}
            </span>
          )}
          {game.popular && !newestKeys.includes(game.leaderboardKey) && (
            <span
              aria-hidden="true"
              className="absolute right-2 top-2 rounded-full border border-[#f5ff3b]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f5ff3b] shadow-[0_0_10px_rgba(245,255,59,0.45)] backdrop-blur-sm"
            >
              {t("home.casino_lobby.badge_hot")}
            </span>
          )}
        </div>

        <h3 className="mb-2 text-lg font-extrabold tracking-tight text-[#f5ff3b] md:text-xl">
          {game.nameKey ? t(game.nameKey) : game.name}
        </h3>

        <p className="line-clamp-2 text-sm leading-relaxed text-[#9dd8ff] md:text-[15px]">
          {t(game.descriptionKey)}
        </p>

        {/* Primary CTA — always visible, works on touch. The whole card is
            a link; this makes the action explicit without hover. */}
        <div className="mt-4">
          <span className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-2 text-sm font-bold text-[#00e5ff] transition-all duration-200 group-hover:bg-[#00e5ff] group-hover:text-black group-hover:shadow-[0_0_15px_rgba(0,229,255,0.5)] sm:w-auto">
            {t("home.casino_lobby.play")}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </span>
        </div>
      </Link>
      <div className="mt-auto pt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/classement?game=${game.leaderboardKey}`}
          className="text-xs text-[#00e5ff] underline underline-offset-2 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] rounded"
        >
          {t("home.view_leaderboard")} {game.nameKey ? t(game.nameKey) : game.name}
        </Link>
      </div>

      {Array.isArray(friendPresenceByGame[game.leaderboardKey]) &&
        friendPresenceByGame[game.leaderboardKey].length > 0 && (
          <div
            className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1"
            title={friendPresenceByGame[game.leaderboardKey].map((f) => f.name).join(", ")}
          >
            {friendPresenceByGame[game.leaderboardKey].slice(0, 4).map((friend) => (
              <IconAvatar
                key={`${friend.id}-${friend.name}`}
                iconKey={friend.iconKey}
                name={friend.name}
                size="h-6 w-6"
                className="border border-white/30"
              />
            ))}
          </div>
        )}
    </div>
  );

  return (
    <div className="relative min-h-screen overflow-x-clip pb-40 pt-16 md:pb-8 md:pt-20">
      {/* Full-page interactive casino background (quieter "subtle" variant
          so it doesn't compete with the 22-card grid). */}
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-7xl px-3 py-6 sm:px-4 sm:py-12">
        <section className="mb-8 space-y-3 text-center">
          <h1 className="text-2xl font-black tracking-tight leading-tight sm:text-4xl md:text-6xl fade-slide-up">
            <span className="text-[#f5ff3b]">{t("home.title_line1")}</span>{" "}
            <span className="bg-gradient-to-r from-[#00e5ff] to-[#f0abfc] bg-clip-text text-transparent">
              {t("home.title_line2")}
            </span>
          </h1>
          <p
            className="text-base leading-relaxed text-[#d8fbff] sm:text-lg md:text-xl fade-slide-up"
            style={{ animationDelay: "0.15s" }}
          >
            {t("home.subtitle")}
          </p>
          <p
            className="mx-auto max-w-2xl text-sm leading-relaxed text-[#9dd8ff]/90 sm:text-base fade-slide-up"
            style={{ animationDelay: "0.2s" }}
          >
            {t("home.description")}
          </p>
          {error && (
            <div
              className="mx-auto mb-4 max-w-md rounded-lg bg-red-500/10 p-3 text-sm text-red-500 fade-slide-up"
              style={{ animationDelay: "0.6s" }}
            >
              {error}
            </div>
          )}
          {user && <></>}
        </section>

        {/* First battle — only for accounts that abandoned onboarding */}
        {firstBattle && (
          <div className="mb-8">
            <div className="relative overflow-hidden rounded-2xl border border-[#f5ff3b]/40 bg-gradient-to-r from-[#0a214d]/90 to-[#08142f]/90 px-5 py-4 shadow-[0_0_30px_rgba(245,255,59,0.12)]">
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h2 className="text-lg font-black tracking-tight text-[#f5ff3b] sm:text-xl">
                    {t("onboarding.firstMatch.lobbyTitle")}
                  </h2>
                  <p className="mt-0.5 text-sm text-[#d8fbff]">
                    {t("onboarding.welcome.subtitle")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href="/casino/rps/play-ai?onboarding=1"
                    className="rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] px-5 py-2.5 text-sm font-bold text-[#041125] transition-all hover:bg-[#f5ff3b]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a214d]"
                  >
                    {t("onboarding.firstMatch.lobbyCta")}
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setFirstBattle(false);
                      try {
                        sessionStorage.setItem(
                          "grynd:lobby:first-battle:dismissed",
                          "1",
                        );
                      } catch {
                        // ignore
                      }
                    }}
                    aria-label={t("onboarding.firstMatch.dismiss")}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-[#00e5ff]/40 text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mb-8 flex justify-center px-4">
          <div className="relative w-full max-w-4xl">
            {/* Search Icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 pointer-events-none"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35m1.85-5.15a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>

            <label htmlFor="game-search" className="sr-only">{t("home.search_placeholder")}</label>
            <input
              id="game-search"
              type="text"
              placeholder={t("home.search_placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-[#00e5ff]/45 bg-[#040d24] py-3 pl-12 pr-4 text-[#ecf8ff] placeholder-[#6aa4d8] transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-[#00e5ff]"
            />
          </div>
        </div>

        {/* Filters narrow the set (what kind of game); sort reorders it.
            Two separate controls so each does one job — the filter chips
            are cyan (action), the sort chips are amber (ordering). */}
        <div className="mb-6 flex flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#9dd8ff] opacity-80">
              {t("home.casino_lobby.filter_by")}
            </p>
            <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
              {[
                { key: "all", labelKey: "home.casino_lobby.filter_all" },
                { key: "duels", labelKey: "home.casino_lobby.filter_duels" },
                {
                  key: "multiplayer",
                  labelKey: "home.casino_lobby.filter_multiplayer",
                },
                { key: "popular", labelKey: "home.casino_lobby.filter_popular" },
              ].map((btn) => (
                <button
                  key={btn.key}
                  onClick={() => setActiveFilter(btn.key)}
                  aria-pressed={activeFilter === btn.key}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 sm:px-5 sm:text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] ${
                    activeFilter === btn.key
                      ? "bg-[#00e5ff] text-black shadow-[0_0_15px_rgba(0,229,255,0.7)]"
                      : "bg-[#08142f] text-[#d8fbff] border border-[#00e5ff]/30 hover:bg-[#10234a]"
                  }`}
                >
                  {t(btn.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col items-center gap-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#f5ff3b]/70">
              {t("home.casino_lobby.sort_by")}
            </p>
            <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
              {[
                { key: "featured", labelKey: "home.casino_lobby.sort_featured" },
                {
                  key: "most-played",
                  labelKey: "home.casino_lobby.sort_most_played",
                },
                { key: "az", labelKey: "home.casino_lobby.sort_az" },
                { key: "newest", labelKey: "home.casino_lobby.sort_newest" },
              ].map((btn) => (
                <button
                  key={btn.key}
                  onClick={() => setSortOrder(btn.key)}
                  aria-pressed={sortOrder === btn.key}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 sm:px-5 sm:text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] ${
                    sortOrder === btn.key
                      ? "bg-[#f5ff3b] text-[#041125] shadow-[0_0_15px_rgba(245,255,59,0.6)]"
                      : "bg-[#08142f] text-[#e8e4c8] border border-[#f5ff3b]/30 hover:bg-[#10234a]"
                  }`}
                >
                  {t(btn.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Admin-only Creator Mode entry — normal users never see it
            (the shared access hook hides it and the server never grants
            access). Opens the settings modal; game links carry ?creator=1
            only while enabled. Rendered above the game grid. */}
        <div className="mb-8 flex justify-center">
          <CreatorModeLobby onChange={setCreatorModeEnabled} />
        </div>

        {/* Recently played (UX plan P1-1) — the last games the player
            actually started this session, newest first. Shown only on the
            unfiltered view: once the player searches or picks a filter,
            the grid below is what they asked for and the strip would just
            compete with it. Games record a play via <CreatorModeHost />'s
            autoStart edge, so this is per-user and per-session. */}
        {search.trim().length === 0 &&
          activeFilter === "all" &&
          recentGames.length > 0 && (
            <section className="mb-8" aria-label={t("home.casino_lobby.recently_played")}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
                  <IconClock size={18} className="text-[#00e5ff]" aria-hidden="true" />
                  {t("home.casino_lobby.recently_played")}
                </h2>
                <button
                  onClick={() => {
                    clearPlayedGames();
                    setRecentGames([]);
                  }}
                  className="rounded-md px-2 py-1 text-xs font-medium text-[#9dd8ff] transition hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                >
                  {t("home.casino_lobby.clear_recent")}
                </button>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {recentGames.map((label) => {
                  const game = games.find((g) => (g.recencyKey || g.leaderboardKey) === label);
                  if (!game) return null;
                  return (
                    <Link
                      key={label}
                      href={buildCreatorHref(game.href, creatorModeEnabled)}
                      className="group w-40 shrink-0 overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_24px_rgba(0,229,255,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24]"
                      aria-label={`${t("home.casino_lobby.play_again")}: ${game.nameKey ? t(game.nameKey) : game.name}`}
                    >
                      <div className="relative aspect-video overflow-hidden">
                        <Image
                          src={game.image}
                          alt=""
                          quality={80}
                          loading="lazy"
                          sizes="160px"
                          className="h-full w-full object-cover object-center transition-transform group-hover:scale-110"
                        />
                        <span className="absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] shadow-[0_0_10px_rgba(0,229,255,0.45)] backdrop-blur-sm">
                          {game.pvpMode === "multi"
                            ? t("home.casino_lobby.pvp_multi_badge")
                            : t("home.pvp_badge")}
                        </span>
                      </div>
                      <div className="px-3 py-2">
                        <p className="truncate text-sm font-bold text-[#f5ff3b]">
                          {game.nameKey ? t(game.nameKey) : game.name}
                        </p>
                        <p className="text-[10px] uppercase tracking-[0.18em] text-[#00e5ff]">
                          {t("home.casino_lobby.play_again")}
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

        {displayedGames.length > 0 && (
          <>
            <h2 className="mb-6 text-2xl font-extrabold tracking-tight text-[#00e5ff] sm:text-3xl">
              {activeFilter === "duels"
                ? t("home.casino_lobby.filter_duels")
                : activeFilter === "multiplayer"
                  ? t("home.casino_lobby.filter_multiplayer")
                  : activeFilter === "popular"
                    ? t("home.casino_lobby.filter_popular")
                    : t("home.all_games")}
            </h2>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4 stagger-container">
              {displayedGames.map((game, index) => (
                <div
                  key={game.nameKey ? t(game.nameKey) : game.name}
                  className="h-full"
                  style={{ "--i": index }}
                >
                  <GameCard game={game} />
                </div>
              ))}
            </div>
          </>
        )}
        {displayedGames.length === 0 &&
          (search.trim().length > 0 || activeFilter !== "all") && (
            <div className="mt-4 rounded-2xl border border-[#00e5ff]/20 bg-[#040d24]/40 px-6 py-16 text-center sm:py-20">
              <p className="text-lg font-semibold text-[#d8fbff] opacity-90">
                {t("home.casino_lobby.no_results_title")}
              </p>
              <p className="mt-2 text-sm text-[#9dd8ff] opacity-80">
                {t("home.casino_lobby.no_results_hint")}
              </p>
            </div>
          )}
      </div>

      <style jsx global>{`
        @keyframes fadeSlideUp {
          0% {
            opacity: 0;
            transform: translateY(30px) scale(0.98);
            filter: blur(6px);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
          }
        }

        .fade-slide-up {
          opacity: 0;
          animation: fadeSlideUp 0.6s ease-out forwards;
        }

        /* Stagger utility */
        .stagger-container > * {
          opacity: 0;
          animation: fadeSlideUp 0.6s ease-out forwards;
        }

        /* Automatically stagger children */
        .stagger-container > *:nth-child(n) {
          animation-delay: calc(0.08s * var(--i));
        }
      `}</style>
      <Footer />
      <StickyMobileCta playHref={buildCreatorHref("/casino/roulette", creatorModeEnabled)} />
    </div>
  );
}

export default MainComponent;
