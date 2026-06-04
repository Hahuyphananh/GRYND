"use client";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { useUser } from "@clerk/nextjs";
import React, { useEffect, useState } from "react";
import Img1 from "../../images/roulette.jpg";
import Img2 from "../../images/blackjack.jpg";
import Img3 from "../../images/poker.jpg";
import Img4 from "../../images/plinko.jpg";
import Img5 from "../../images/mines.jpg";
import Img6 from "../../images/crash.jpg";
import Img7 from "../../images/chess.jpg";
import Img8 from "../../images/slots.jpg";
import Img9 from "../../images/coin-flip.jpg";
import Img10 from "../../images/keno.png";
import Img11 from "../../images/uno.png";
import Img12 from "../../images/rps.png";
import Img13 from "../../images/dice.png";
import Img14 from "../../images/connect-4.png";
import Img15 from "../../images/towers.png";
import Img16 from "../../images/clicker.png";
import Img17 from "../../images/pool.png";
import Img18 from "../../images/hex-duel.svg";
import Img19 from "../../images/yahtzee.png";
import Img20 from "../../images/farkle.svg";
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
      name: "Mines",
      href: "/casino/mines",
      leaderboardKey: "mines",
      image: Img5,
      descriptionKey: "games.mines_desc",
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
      href: "/casino/poker",
      leaderboardKey: "poker",
      image: Img3,
      descriptionKey: "games.poker_desc",
    },

    {
      name: "Crash",
      href: "/casino/crash",
      leaderboardKey: "crash",
      image: Img6,
      descriptionKey: "games.crash_desc",
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
      name: "Slots",
      href: "/casino/slots",
      leaderboardKey: "slots",
      image: Img8,
      descriptionKey: "games.slots_desc",
    },
    {
      name: "Coin Flip",
      href: "/casino/coin-flip",
      leaderboardKey: "coin-flip",
      image: Img9,
      descriptionKey: "games.coin_flip_desc",
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
      name: "Yahtzee",
      href: "/casino/yahtzee",
      leaderboardKey: "yahtzee",
      image: Img19,
      descriptionKey: "games.yahtzee_desc",
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
  ];

  const filteredGames = games.filter((game) =>
    (game.nameKey ? t(game.nameKey) : game.name).toLowerCase().includes(search.toLowerCase())
  );

  const skillGameKeys = new Set([
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
  ]);

  const newestOrder = [
    "farkle",
    "yahtzee",
    "hex-duel",
    "pool-masters",
    "goonbet-clicker",
    "lane-runner",
    "connect-four",
    "dice-duel",
    "rps",
    "neon-flush",
    "keno",
    "coin-flip",
    "slots",
    "chess",
    "crash",
    "poker",
    "plinko",
    "mines",
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

  const GameCard = ({ game }) => (
    <div className="group relative overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-2 transition-all duration-300 hover:-translate-y-1 sm:hover:-translate-y-2 hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(0,229,255,0.4)]">
      <Link href={game.href} className="block cursor-pointer">
        <div className="mb-2 h-28 overflow-hidden rounded-lg">
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
          <i className="fas fa-arrow-right ml-2"></i>
        </div>
      </Link>
      <div className="mt-2">
        <Link
          href={`/classement?game=${game.leaderboardKey}`}
          className="text-xs text-[#00e5ff] underline underline-offset-2 hover:text-[#d8fbff]"
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
    <div className="min-h-screen overflow-x-clip bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] pb-24 pt-20 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-4 sm:py-12">
        <section className="mb-5 text-center">
          <h1 className="mb-2 text-3xl font-bold text-[#f5ff3b] sm:text-4xl md:text-6xl fade-slide-up">
            {t("home.title")}
          </h1>
          <p
            className="mb-2 text-base text-[#d8fbff] sm:text-lg md:text-xl fade-slide-up"
            style={{ animationDelay: "0.15s" }}
          >
            {t("home.subtitle")}
          </p>
          <p
            className="mb-2 text-base text-[#d8fbff] sm:text-lg md:text-xl fade-slide-up"
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
        <div className="mb-5 flex justify-center px-4">
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

            <input
              type="text"
              placeholder={t("home.search_placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-[#00e5ff]/45 bg-[#040d24] py-3 pl-12 pr-4 text-[#ecf8ff] placeholder-[#6aa4d8] focus:outline-none focus:ring-2 focus:ring-[#00e5ff] "
            />
          </div>
        </div>

        <div className="mb-8 flex flex-wrap justify-center gap-2 sm:gap-3">
          <p className="flex flex-wrap justify-center gap-3 mt-2">Sort By:</p>
          {[
            { key: "all", label: "All Games" },
            { key: "popular", label: "Popular Games" },
            { key: "skill", label: "Skill-Based Games" },
            { key: "newest", label: "Newest Games" },
          ].map((btn) => (
            <button
              key={btn.key}
              onClick={() => setActiveFilter(btn.key)}
              className={`rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-300 sm:px-5 sm:text-base ${
                activeFilter === btn.key
                  ? "bg-[#00e5ff] text-black shadow-[0_0_15px_rgba(0,229,255,0.7)]"
                  : "bg-[#08142f] text-[#d8fbff] border border-[#00e5ff]/30 hover:bg-[#10234a]"
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {displayedGames.length > 0 && (
          <>
            <h2 className="mb-6 text-2xl font-bold text-[#00e5ff] sm:text-3xl">
              {activeFilter === "popular"
                ? "Popular Games"
                : activeFilter === "skill"
                  ? "Skill-Based Games"
                  : activeFilter === "newest"
                    ? "Newest Games"
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
