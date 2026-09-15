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
import { IconClock, IconSparkles } from "@tabler/icons-react";
import StickyMobileCta from "../../components/StickyMobileCta";
import CreatorModeLobby from "../../components/creator-mode/CreatorModeLobby";
import { buildCreatorHref } from "../../lib/creator-mode/client";
import { clearPlayedGames, getPlayedGames } from "../../lib/recentlyPlayed";
import {
  QUESTIONNAIRE_INVITE_SESSION_KEY,
  shouldShowQuestionnaireInvite,
} from "../../lib/onboardingFlow";
// Copy keys owned by the recommendation engine (src/lib/gameRecommendations.js)
// so the "For You" section and the engine's messaging can never drift apart.
import {
  FOR_YOU_HINT_MESSAGE_KEY,
  FOR_YOU_MESSAGE_KEY,
  shouldShowPersonalizedSection,
} from "../../lib/gameRecommendations";
// The "N playing" line on every game card. Both helpers are pure rules in the
// presence module (the single source of truth for this feature), so the badge
// cannot invent a number and the "nobody / playing / hot" split is tested.
import { activePlayerTier, formatPlayerCount } from "../../lib/gamePresence";

// sessionStorage keys for the lobby's persisted state (UX plan P1-1): the
// search box + active filter survive a refresh / back-navigation within the
// browser session, so a returning player lands where they left off instead
// of re-scanning the full grid.
const LOBBY_SEARCH_KEY = "grynd.lobby.search.v1";
const LOBBY_FILTER_KEY = "grynd.lobby.filter.v1";
const LOBBY_SORT_KEY = "grynd.lobby.sort.v1";

// Active players per game (the lobby's "N playing" line). 20s sits inside the
// requested 15–30s window and is the shortest cadence that can never miss the
// endpoint's own 10s Redis cache (CacheKeys.activePlayers), so a lobby visit
// costs about three lightweight reads a minute instead of a query per card.
// Polling pauses while the tab is hidden and refreshes immediately when it
// comes back — the same policy the friend-presence poll below already uses.
const ACTIVE_PLAYERS_POLL_MS = 20000;

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
  // "Make GRYND yours" — a one-time invitation for EXISTING players (the
  // tutorial is already done) who never answered or declined the
  // questionnaire. The decision comes from the shared flow rules
  // (src/lib/onboardingFlow.js) and dismissal is stored on the user row, so
  // this can never turn into a recurring interruption.
  const [questionnaireInvite, setQuestionnaireInvite] = useState(false);
  // "For You" (personalization engine). `questionnaireAnswered` comes from the
  // SAME /api/onboarding/status snapshot the invitation uses, so a player who
  // never answered costs no extra request; `forYou` is null until the one
  // recommendation call succeeds, and null means "render the normal lobby".
  const [questionnaireAnswered, setQuestionnaireAnswered] = useState(false);
  const [forYou, setForYou] = useState(null);
  // Bumped whenever the tab becomes visible again. Returning from Settings —
  // where preferences are edited — should re-read the ranking instead of
  // showing what the answers used to be (covers bfcache restores, where the
  // component is not remounted).
  const [forYouRefresh, setForYouRefresh] = useState(0);

  // Creator Mode (admin-only): when enabled, game links carry ?creator=1
  // so the shared CreatorModeProvider inside each game picks it up.
  const [creatorModeEnabled, setCreatorModeEnabled] = useState(false);
  // Active players per game — the "N playing" line on every card.
  //
  // `status` is "loading" until the first answer lands, "ready" with the real
  // counts, or "error". An ERROR HIDES the line: /api/casino/active-players
  // fails closed with `success: false` precisely when it could not read the
  // store, so printing "No players right now" there would be a lie. Counts are
  // aggregate only, keyed by the canonical game id (leaderboardKey) the lobby
  // already carries — nothing is hardcoded and no card fetches on its own.
  const [activePlayers, setActivePlayers] = useState({ status: "loading", counts: {} });
  const { t, language } = useTranslation();

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

  // First-time guidance: both lobby onboarding cards are decided from the SAME
  // server snapshot (/api/onboarding/status) and each keeps its own
  // session-scoped suppressor on top — the same pattern the first-battle card
  // already used:
  //
  //   first-battle card → the tutorial is NOT finished (new/abandoned account)
  //   GRYND invitation  → the tutorial IS finished and the questionnaire was
  //                       neither answered nor declined (existing account, so
  //                       it is never sent back through onboarding)
  //
  // The server flags stay the source of truth (a dismissal survives reloads
  // and other devices); the session flags only stop a transient error from
  // re-asking within the same tab.
  useEffect(() => {
    if (!user) {
      setFirstBattle(false);
      setQuestionnaireInvite(false);
      setQuestionnaireAnswered(false);
      return;
    }
    let cancelled = false;
    const FIRST_BATTLE_DISMISS_KEY = "grynd:lobby:first-battle:dismissed";
    const readSession = (key) => {
      try {
        return sessionStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    };

    fetch("/api/onboarding/status", { credentials: "include" })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (cancelled) return;
        const ok = data?.success === true;
        setFirstBattle(
          Boolean(
            ok &&
              data.onboardingCompleted === false &&
              !readSession(FIRST_BATTLE_DISMISS_KEY),
          ),
        );
        setQuestionnaireInvite(
          shouldShowQuestionnaireInvite({
            isSignedIn: true,
            onboardingCompleted: ok ? data.onboardingCompleted === true : null,
            questionnaireCompleted: ok ? data.questionnaireCompleted === true : null,
            questionnaireDismissed: ok ? data.questionnaireDismissed === true : null,
            handledThisSession: readSession(QUESTIONNAIRE_INVITE_SESSION_KEY),
          }),
        );
        // Only an answered questionnaire can be personalized — the "For You"
        // fetch hangs off this flag instead of firing for everyone.
        setQuestionnaireAnswered(ok && data.questionnaireCompleted === true);
      })
      .catch(() => {
        if (!cancelled) {
          setFirstBattle(false);
          setQuestionnaireInvite(false);
          setQuestionnaireAnswered(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Visibility watcher (see forYouRefresh): re-read the ranking when the
  // player comes back to the tab, so a preference edit made elsewhere is
  // reflected without a hard reload. Same pattern the friend-presence poller
  // below uses; it fires no request of its own.
  useEffect(() => {
    if (!user) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") setForYouRefresh((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [user]);

  // "For You" (personalization engine) — ONE server call, chained behind the
  // onboarding-status snapshot above. A player who never answered the
  // questionnaire costs zero extra requests; everyone else asks once per mount
  // (never a request per card — the payload is the whole ranked list and the
  // section renders the top few). Every failure mode leaves the section off:
  // signed out, network/500 error, `personalized: false` (no usable answers),
  // or `complete: false` (a partial answer set) — the gate itself lives in the
  // engine (shouldShowPersonalizedSection) so it is unit tested, and /casino
  // can never break because of personalization.
  useEffect(() => {
    if (!user || !questionnaireAnswered) {
      setForYou(null);
      return;
    }
    let cancelled = false;
    fetch("/api/onboarding/recommendations", { credentials: "include" })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (cancelled) return;
        if (!shouldShowPersonalizedSection(data)) {
          setForYou(null);
          return;
        }
        setForYou({
          ids: data.primaryGameIds,
          messageKey: typeof data.messageKey === "string" ? data.messageKey : null,
        });
      })
      .catch(() => {
        if (!cancelled) setForYou(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user, questionnaireAnswered, forYouRefresh]);

  // "Maybe Later": hide it now, suppress it for this session, and record the
  // dismissal server-side so it stays gone on every future visit/device. It
  // never blocks gameplay, and the questionnaire stays reachable from Settings.
  const dismissQuestionnaireInvite = () => {
    setQuestionnaireInvite(false);
    try {
      sessionStorage.setItem(QUESTIONNAIRE_INVITE_SESSION_KEY, "1");
    } catch {
      // sessionStorage unavailable — the server flag still applies
    }
    try {
      fetch("/api/onboarding/questionnaire/dismiss", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        keepalive: true,
      }).catch(() => {});
    } catch {
      // fetch unavailable — nothing else to do
    }
  };

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

  // "For You": the engine ranks canonical game ids (leaderboardKey), so map
  // them back onto the real lobby entries — a plain lookup in the array we
  // already have, never a request per card. Unresolvable ids are dropped
  // rather than rendered as an empty card.
  const forYouGames = (forYou?.ids ?? [])
    .map((id) => games.find((game) => game.leaderboardKey === id))
    .filter(Boolean);
  // Exactly the "Recently played" rule: once the player searches or picks a
  // filter, the grid is what they asked for — a personalized section must not
  // compete with it or pretend to be filtered.
  const showForYou =
    forYouGames.length > 0 && search.trim().length === 0 && activeFilter === "all";

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

  // Active players per game (the lobby's "N playing" line). One request for the
  // WHOLE lobby, then a light poll: the endpoint returns aggregate counts for
  // every game at once (Redis-cached for 10s server-side), so twenty cards cost
  // one read, never twenty.
  //
  // Public endpoint, so signed-out visitors see the same live lobby. It never
  // blocks anything: a failure only hides the counts (below), and filters,
  // sorting, search links and every Play button keep working exactly as before.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let id = null;

    const load = async () => {
      // Never stack requests — a slow network or a visibility flip must not
      // queue up a second read of the same aggregate.
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/casino/active-players", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        // `success: false` is the route's fail-closed answer (it still returns
        // 200), so it is treated as a failure rather than as "nobody playing".
        if (!res.ok || data?.success !== true) {
          setActivePlayers({ status: "error", counts: {} });
          return;
        }
        setActivePlayers({ status: "ready", counts: data.counts || {} });
      } catch {
        if (!cancelled) setActivePlayers({ status: "error", counts: {} });
      } finally {
        inFlight = false;
      }
    };

    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    const start = () => {
      stop();
      load();
      id = setInterval(load, ACTIVE_PLAYERS_POLL_MS);
    };
    // Background tabs don't need live counts; returning to the lobby refreshes
    // them at once instead of waiting out a stale interval.
    const onVisibility = () =>
      document.visibilityState === "visible" ? start() : stop();

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // One card's live-activity line: the count of players inside that game right
  // now, in the three states activePlayerTier() defines. The number comes from
  // the shared counts map, the words from the app-text catalog, and the glyph
  // is decorative — every state is readable as text, never by colour alone.
  const PlayerCountBadge = ({ game }) => {
    if (activePlayers.status === "loading") {
      // Subtle placeholder rather than nothing: it reserves the line's height
      // so the cards don't reflow when the first answer lands, and it claims
      // nothing while it waits.
      return (
        <p
          aria-hidden="true"
          className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#9dd8ff]/40" />
          <span className="h-3 w-14 animate-pulse rounded-full bg-[#9dd8ff]/15" />
        </p>
      );
    }
    // Failed read → no line at all. The card is then exactly what it was
    // before this feature, which is the honest fallback: no count, no zero,
    // no stale number.
    if (activePlayers.status !== "ready") return null;

    const players = Number(activePlayers.counts?.[game.leaderboardKey] ?? 0);
    const tier = activePlayerTier(players);
    const text =
      tier === "none"
        ? t("home.casino_lobby.players_none")
        : t("home.casino_lobby.players_playing", {
            count: formatPlayerCount(players, language),
          });

    return (
      <p
        className={`flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold ${
          tier === "hot"
            ? "text-[#f5ff3b]"
            : tier === "playing"
              ? "text-[#34d399]"
              : "text-[#9dd8ff]"
        }`}
      >
        <span
          aria-hidden="true"
          className={
            tier === "none"
              ? "text-[#9dd8ff]/50"
              : tier === "hot"
                ? "drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]"
                : "text-[#34d399] drop-shadow-[0_0_6px_rgba(52,211,153,0.7)]"
          }
        >
          {tier === "hot" ? "🔥" : "●"}
        </span>
        {text}
      </p>
    );
  };

  const GameCard = ({ game, recommended = false }) => (
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
          {/* "For You" only: a quiet marker on a personal pick. Anchored to
              the image's bottom-right so it never fights the PvP badge
              (top-left) or the NEW/HOT pills (top-right). */}
          {recommended && (
            <span className="absolute bottom-2 right-2 rounded-full border border-[#f0abfc]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f0abfc] shadow-[0_0_10px_rgba(240,171,252,0.4)] backdrop-blur-sm">
              {t("home.casino_lobby.recommended_badge")}
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
      {/* Card footer: live activity first, then the leaderboard shortcut.
          The count deliberately sits OUTSIDE the card's Link — that link has
          its own aria-label ("Play <game>"), which would otherwise swallow the
          count for screen readers — and adding it here leaves the title,
          description, CTA and the art badges (PvP / NEW / HOT / Recommended /
          friends) untouched. */}
      <div className="mt-auto pt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <PlayerCountBadge game={game} />
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

        {/* "Make GRYND yours" — the one-time questionnaire invitation for
            existing players. Deliberately a card (not a modal): it never
            blocks the grid or gameplay, and "Maybe Later" is remembered
            server-side so it cannot nag. */}
        {questionnaireInvite && (
          <div className="mb-8">
            <div className="relative overflow-hidden rounded-2xl border border-[#00e5ff]/40 bg-gradient-to-r from-[#08142f]/95 to-[#0a214d]/95 px-5 py-4 shadow-[0_0_30px_rgba(0,229,255,0.12)]">
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h2 className="text-lg font-black tracking-tight text-[#f5ff3b] sm:text-xl">
                    {t("onboarding.questionnaire.invite.title")}
                  </h2>
                  <p className="mt-0.5 text-sm text-[#d8fbff]">
                    {t("onboarding.questionnaire.invite.body")}
                  </p>
                  {/* Duration + reversibility: it reads as a feature you can
                      undo (Settings → Your GRYND Preferences), not a screen
                      you are being pushed through. */}
                  <p className="mt-1 text-xs text-[#9dd8ff]/80">
                    {t("onboarding.questionnaire.invite.note")}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Link
                    href="/welcome/questionnaire?from=lobby"
                    className="rounded-lg border border-[#00e5ff]/60 bg-[#00e5ff] px-5 py-2.5 text-sm font-bold text-black transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a214d]"
                  >
                    {t("onboarding.questionnaire.invite.primary")}
                  </Link>
                  <button
                    type="button"
                    onClick={dismissQuestionnaireInvite}
                    className="rounded-lg border border-[#00e5ff]/35 px-4 py-2.5 text-sm font-semibold text-[#9dd8ff] transition hover:bg-[#00e5ff]/10 hover:text-[#d8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
                  >
                    {t("onboarding.questionnaire.invite.secondary")}
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

        {/* FOR YOU (personalization engine) — the highest-scoring games for
            this player's questionnaire answers, above All Games. Rendered with
            the SAME GameCard as the grid below (one card system, one request),
            and only when the server says the ranking is personalized AND the
            answers are complete. No questionnaire → no section → the lobby is
            byte-for-byte what it was before. */}
        {showForYou && (
          <section className="mb-8" aria-label={t(FOR_YOU_MESSAGE_KEY)}>
            <h2 className="mb-1 flex items-center gap-2 text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
              <IconSparkles size={18} className="text-[#00e5ff]" aria-hidden="true" />
              {t(FOR_YOU_MESSAGE_KEY)}
            </h2>
            {/* One short line of personalized framing: the player's primary
                goal when the engine has one, otherwise the neutral hint. */}
            <p className="mb-4 text-sm leading-relaxed text-[#9dd8ff]">
              {forYou?.messageKey ? t(forYou.messageKey) : t(FOR_YOU_HINT_MESSAGE_KEY)}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4">
              {forYouGames.map((game) => (
                <div key={`for-you-${game.leaderboardKey}`} className="h-full">
                  <GameCard game={game} recommended />
                </div>
              ))}
            </div>
          </section>
        )}

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
