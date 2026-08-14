"use client";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { useUser } from "@clerk/nextjs";
import React, { useEffect, useState } from "react";
import Img1 from "../../images/roulette.png";
import Img2 from "../../images/blackjack.jpg";
import Img3 from "../../images/poker.jpg";
import Img4 from "../../images/plinko.svg";
import Img6 from "../../images/crash.svg";
import Img7 from "../../images/chess.svg";
import Img10 from "../../images/keno.svg";
import Img11 from "../../images/uno.svg";
import Img12 from "../../images/rps.svg";
import Img13 from "../../images/dice.svg";
import Img14 from "../../images/connect-4.svg";
import Img15 from "../../images/towers.png";
import Img16 from "../../images/clicker.svg";
import Img17 from "../../images/pool.svg";
import Img18 from "../../images/hex-duel.svg";
import Img21 from "../../images/odds.svg";
import Img19 from "../../images/dice-flush.svg";
import Img20 from "../../images/farkle.svg";
import Img22 from "../../images/precision.svg";
import ImgDotsBoxes from "../../images/dots-and-boxes.svg";
import ImgMinesPvp from "../../images/mines-pvp.svg";
import Image from "next/image";
import Link from "next/link";
import { useTranslation } from "../../hooks/useTranslation";

function MainComponent() {
  const { user } = useUser();
  const [selectedGame, setSelectedGame] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [friendPresenceByGame, setFriendPresenceByGame] = useState({});
  const { t } = useTranslation();

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

  const games = [
    {
      name: "Roulette",
      href: "/casino/roulette",
      leaderboardKey: "roulette",
      image: Img1,
      descriptionKey: "games.roulette_desc",
      popular: true,
    },
    {
      name: "Blackjack",
      href: "/casino/blackjack",
      leaderboardKey: "blackjack",
      image: Img2,
      descriptionKey: "games.blackjack_desc",
      popular: true,
    },
    {
      name: "Mines Duel",
      href: "/casino/mines-pvp",
      leaderboardKey: "mines-pvp",
      image: ImgMinesPvp,
      descriptionKey: "games.mines_pvp_desc",
      nameKey: "games.mines_pvp_name",
      popular: true,
    },

    {
      name: "Plinko",
      href: "/casino/plinko",
      leaderboardKey: "plinko",
      image: Img4,
      descriptionKey: "games.plinko_desc",
      popular: true,
    },
    {
      name: "Poker",
      href: "/casino/poker/multi",
      leaderboardKey: "poker",
      image: Img3,
      descriptionKey: "games.poker_desc",
    },

    {
      name: "Crash Arena",
      href: "/casino/crash-arena",
      leaderboardKey: "crash",
      image: Img6,
      descriptionKey: "games.crash_arena_desc",
    },
    {
      name: "Échecs",
      href: "/casino/chess",
      leaderboardKey: "chess",
      image: Img7,
      descriptionKey: "games.chess_desc",
      nameKey: "games.chess_name",
    },
    {
      name: "Keno",
      href: "/casino/keno",
      leaderboardKey: "keno",
      image: Img10,
      descriptionKey: "games.keno_desc",
    },
    {
      name: "Neon Flush",
      href: "/casino/neon-flush",
      leaderboardKey: "uno",
      image: Img11,
      descriptionKey: "games.uno_desc",
    },
    {
      name: "Roche-Papier-Ciseaux",
      href: "/casino/rps",
      leaderboardKey: "rps",
      image: Img12,
      descriptionKey: "games.rps_desc",
      nameKey: "games.rps_name",
    },
    {
      name: "Dice Duel Arena",
      href: "/casino/dice-duel",
      leaderboardKey: "dice-duel",
      image: Img13,
      descriptionKey: "games.dice_duel_desc",
    },
    {
      name: "Connect Four",
      href: "/casino/connect-four",
      leaderboardKey: "connect-four",
      image: Img14,
      descriptionKey: "games.connect_four_desc",
    },

    {
      name: "Lane Runner",
      href: "/casino/lane-runner",
      leaderboardKey: "lane-runner",
      image: Img15,
      descriptionKey: "games.lane_runner_desc",
    },
    {
      name: "Clicker",
      href: "/casino/goonbet-clicker",
      leaderboardKey: "goonbet-clicker",
      image: Img16,
      descriptionKey: "games.goonbet_clicker_desc",
    },
    {
      name: "Pool Masters",
      href: "/casino/pool-masters",
      leaderboardKey: "pool-masters",
      image: Img17,
      descriptionKey: "games.pool_masters_desc",
    },

    {
      name: "HEX DUEL",
      href: "/casino/hex-duel",
      leaderboardKey: "hex-duel",
      image: Img18,
      descriptionKey: "games.hex_duel_desc",
      nameKey: "games.hex_duel_name",
    },
     {
      name: "Dice Flush",
      href: "/casino/dice-flush",
      leaderboardKey: "yahtzee",
      image: Img19,
      descriptionKey: "games.dice_flush_desc",
      popular: true,
    },
    {
      name: "Odds",
      href: "/casino/odds",
      leaderboardKey: "odds",
      image: Img21,
      descriptionKey: "games.odds_desc",
      nameKey: "games.odds_name",
      popular: true,
    },
    {
      name: "Farkle",
      href: "/casino/farkle",
      leaderboardKey: "farkle",
      image: Img20,
      descriptionKey: "games.farkle_desc",
      popular: true,
    },
    {
      name: "Precision",
      href: "/casino/precision",
      leaderboardKey: "precision",
      image: Img22,
      descriptionKey: "games.precision_desc",
      nameKey: "games.precision_name",
    },
    {
      name: "Dots & Boxes",
      href: "/casino/dots-and-boxes",
      leaderboardKey: "dots-and-boxes",
      image: ImgDotsBoxes,
      descriptionKey: "games.dots_and_boxes_desc",
      nameKey: "games.dots_and_boxes_name",
    },
  ];

  const filteredGames = games.filter((game) =>
    (game.nameKey ? t(game.nameKey) : game.name).toLowerCase().includes(search.toLowerCase())
  );

  const skillGameKeys = new Set([
    "dots-and-boxes",
    "connect-four",
    "neon-flush",
    "poker",
    "dice-duel",
    "chess",
    "rps",
    "pool-masters",
    "hex-duel",
    "yahtzee",
    "farkle",
    "precision",
  ]);

  const newestOrder = [
    "mines-pvp",
    "dots-and-boxes",
    "precision",
    "farkle",
    "yahtzee",
    "hex-duel",
    "pool-masters",
    "odds",
    "goonbet-clicker",
    "lane-runner",
    "connect-four",
    "dice-duel",
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

  if (activeFilter === "popular") {
    displayedGames = displayedGames.filter((g) => g.popular);
  }

  if (activeFilter === "skill") {
    displayedGames = displayedGames.filter((g) => skillGameKeys.has(g.leaderboardKey));
  }

  if (activeFilter === "newest") {
    displayedGames.sort(
      (a, b) => newestOrder.indexOf(a.leaderboardKey) - newestOrder.indexOf(b.leaderboardKey)
    );
  }

  useEffect(() => {
    if (!user) return;
    fetchFriendPresence();
    const id = setInterval(fetchFriendPresence, 30000);
    return () => clearInterval(id);
  }, [user]);

  const GameCard = ({ game }) => (        <div className="group relative overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(0,229,255,0.4)] focus-within:ring-2 focus-within:ring-[#00e5ff] focus-within:ring-offset-2 focus-within:ring-offset-[#040d24]">
      <Link href={game.href} className="block cursor-pointer" aria-label={`Play ${game.nameKey ? t(game.nameKey) : game.name}`}>
        <div className="mb-3 h-32 overflow-hidden rounded-lg">
          <Image
            src={game.image}
            alt={game.nameKey ? t(game.nameKey) : game.name}
            className="h-full w-full object-cover transition-transform group-hover:scale-110"
          />
        </div>

        <h3 className="mb-2 text-base font-bold text-[#f5ff3b] md:text-lg">
          {game.nameKey ? t(game.nameKey) : game.name}
        </h3>

        <p className="line-clamp-2 text-sm text-[#9dd8ff] md:text-base">{t(game.descriptionKey)}</p>

        <div className="mt-4 flex items-center text-[#00e5ff]">
          <span>{t("home.play_now")}</span>
          <svg className="ml-2 w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
      </Link>
      <div className="mt-2">
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
            {friendPresenceByGame[game.leaderboardKey].slice(0, 4).map((friend) =>
              friend.profilePicture ? (
                <img
                  key={`${friend.id}-${friend.name}`}
                  src={friend.profilePicture}
                  alt={friend.name}
                  className="h-6 w-6 rounded-full border border-white/30 object-cover"
                  title={friend.name}
                />
              ) : (
                <div
                  key={`${friend.id}-${friend.name}`}
                  className="h-6 w-6 rounded-full bg-[#FFD700] text-[#003366] text-xs font-bold flex items-center justify-center"
                  title={friend.name}
                >
                  {friend.name?.charAt(0)?.toUpperCase() || "U"}
                </div>
              )
            )}
          </div>
        )}
    </div>
  );

  return (
    <div className="relative min-h-screen overflow-x-clip pb-24 pt-20 md:pb-8">
      {/* Full-page interactive casino background (quieter "subtle" variant
          so it doesn't compete with the 22-card grid). */}
      <InteractiveCasinoBg variant="subtle" />

      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-4 sm:py-12">
        <section className="mb-8 space-y-3 text-center">
          <h1 className="text-3xl font-extrabold tracking-tight leading-tight text-[#f5ff3b] sm:text-4xl md:text-6xl fade-slide-up">
            {t("home.title")}
          </h1>
          <p
            className="text-base leading-relaxed text-[#d8fbff] sm:text-lg md:text-xl fade-slide-up"
            style={{ animationDelay: "0.15s" }}
          >
            {t("home.subtitle")}
          </p>
          <p
            className="text-base leading-relaxed text-[#d8fbff] sm:text-lg md:text-xl fade-slide-up"
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

        <div className="mb-10 flex flex-col items-center gap-4">
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#9dd8ff] opacity-80">
            {t("home.casino_lobby.sort_by")}
          </p>
          <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
            {[
              { key: "all", labelKey: "home.casino_lobby.filter_all" },
              { key: "popular", labelKey: "home.casino_lobby.filter_popular" },
              { key: "skill", labelKey: "home.casino_lobby.filter_skill" },
              { key: "newest", labelKey: "home.casino_lobby.filter_newest" },
            ].map((btn) => (
              <button
                key={btn.key}
                onClick={() => setActiveFilter(btn.key)}
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

        {displayedGames.length > 0 && (
          <>
            <h2 className="mb-6 text-2xl font-extrabold tracking-tight text-[#00e5ff] sm:text-3xl">
              {activeFilter === "popular"
                ? t("home.casino_lobby.filter_popular")
                : activeFilter === "skill"
                  ? t("home.casino_lobby.filter_skill")
                  : activeFilter === "newest"
                    ? t("home.casino_lobby.filter_newest")
                    : t("home.all_games")}
            </h2>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4 stagger-container">
              {displayedGames.map((game, index) => (
                <div key={game.nameKey ? t(game.nameKey) : game.name} style={{ "--i": index }}>
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
    </div>
  );
}

export default MainComponent;
