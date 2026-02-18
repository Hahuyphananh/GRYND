"use client";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";
import { useState, React } from "react";
import Img1 from "../../images/roulette.jpg";
import Img2 from "../../images/blackjack.jpg";
import Img3 from "../../images/poker.jpg";
import Img4 from "../../images/plinko.jpg";
import Img5 from "../../images/mines.jpg";
import Img6 from "../../images/crash.jpg";
import Img7 from "../../images/chess.jpg";
import Img8 from "../../images/slots.jpg";
import Img9 from "../../images/coin-flip.png";
import Img10 from "../../images/keno.png";
import Img11 from "../../images/Uno.jpg";
import Img12 from "../../images/Rps.png";
import Img13 from "../../images/tanks.png"
import Image from "next/image";

function MainComponent() {
  const { data: user } = useUser();
  const [selectedGame, setSelectedGame] = useState(null);
  const [error, setError] = useState(null);
const [search, setSearch] = useState("");

const games = [
  {
    name: "Roulette",
    href: "/casino/roulette",
    image: Img1,
    description: "Placez vos paris sur les numéros, couleurs ou sections",
    popular: true,
  },
  {
    name: "Blackjack",
    href: "/casino/blackjack",
    image: Img2,
    description: "Affrontez le croupier dans ce jeu classique.",
    popular: true,
  },
   {
    name: "Mines",
    href: "/casino/mines",
    image: Img5,
    description: "Évitez les bombes et trouvez les diamants !",
    popular: true,
  },

  {
    name: "Plinko",
    href: "/casino/plinko",
    image: Img4,
    description: "Regardez tomber votre jeton et multipliez vos gains !",
    popular: true,
  },
   {
    name: "Poker",
    href: "/casino/poker",
    image: Img3,
    description: "Affrontez l'IA ou d'autres joueurs.",
  },
  {
    name: "Crash",
    href: "/casino/crash",
    image: Img6,
    description: "Cash out avant que la fusée crash !",
  },
  {
    name: "Échecs",
    href: "/casino/chess",
    image: Img7,
    description: "Affrontez d'autres joueurs dans un match d'échecs.",
  },
  {
    name: "Slots",
    href: "/casino/slots",
    image: Img8,
    description: "Pariez votre chance dans les jeux de slots !",
  },
  {
    name: "Coin Flip",
    href: "/casino/coin-flip",
    image: Img9,
    description: "Faites tourner votre chance avec un pile ou face !",
  },
  {
    name: "Keno",
    href: "/casino/keno",
    image: Img10,
    description: "Choisissez vos numéros fétiches et gagnez gros !",
  },
  {
    name: "Uno",
    href: "/casino/uno",
    image: Img11,
    description: "Défie l’IA dans ce jeu rapide et stratégique.",
  },
  {
    name: "Roche-Papier-Ciseaux",
    href: "/casino/rps",
    image: Img12,
    description: "Parie tes jetons dans ce jeu rapide et stratégique.",
  },
  {
    name: "Tanks",
    href: "/casino/tanks",
    image: Img13,
    description: "Deviens le meilleur tank et empare-toi des primes !",
  },
];

const filteredGames = games.filter((game) =>
  game.name.toLowerCase().includes(search.toLowerCase())
);

const popularGames = filteredGames.filter((g) => g.popular);
const otherGames = filteredGames.filter((g) => !g.popular);
const GameCard = ({ game }) => (
  <a
    href={game.href}
    className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-2 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
  >
    <div className="mb-2 h-28 overflow-hidden rounded-lg">
      <Image
        src={game.image}
        alt={game.name}
        className="h-full w-full object-cover transition-transform group-hover:scale-110"
      />
    </div>

    <h3 className="mb-2 text-md font-bold text-[#FFD700]">
      {game.name}
    </h3>

    <p className="text-gray-300">{game.description}</p>

    <div className="mt-4 flex items-center text-[#FFD700]">
      <span>Jouer maintenant</span>
      <i className="fas fa-arrow-right ml-2"></i>
    </div>
  </a>
);

  return (
    <div className="min-h-screen bg-[#003366] pt-20">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-7xl px-4 py-12">
        <section className="mb-5 text-center">
  <h1 className="mb-4 text-4xl font-bold text-[#FFD700] md:text-6xl fade-slide-up shimmer-heading">
    Casino en Ligne
  </h1>
  <p className="mb-2 text-xl text-white fade-slide-up" style={{ animationDelay: '0.3s' }}>
    Découvrez nos jeux de casino et tentez votre chance
  </p>
  {error && (
    <div className="mx-auto mb-4 max-w-md rounded-lg bg-red-500/10 p-3 text-sm text-red-500 fade-slide-up" style={{ animationDelay: '0.6s' }}>
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
      placeholder="Rechercher un jeu..."
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      className="w-full rounded-xl border border-[#FFD700]/40 bg-black py-3 pl-12 pr-4 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#FFD700] "
    />
  </div>
</div>

{popularGames.length > 0 && (
  <div className="mb-8 rounded-2xl border border-[#FFD700]/40 bg-gradient-to-br from-[#001a33] to-[#000814] p-8 shadow-[0_0_40px_rgba(255,215,0,0.15)]">

    <h2 className="mb-6 text-4xl font-extrabold text-[#FFD700] tracking-wide" style={{ textShadow: "0 0 12px rgba(255,215,0,0.7)" }}>
      ⭐ Jeux les plus populaires
    </h2>

    <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
      {popularGames.map((game) => (
        <GameCard key={game.name} game={game} />
      ))}
    </div>
  </div>
)}

      {otherGames.length > 0 && (
  <>
    <h2 className="mb-6 text-3xl font-bold text-[#FFD700]">
      🎮 Tous les jeux
    </h2>

    <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
      {otherGames.map((game) => (
        <GameCard key={game.name} game={game} />
      ))}
    </div>
  </>
)}

      </div>

      <style jsx global>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .grid > * {
          animation: fadeIn 0.5s ease-out forwards;
        }

        .grid > *:nth-child(1) {
          animation-delay: 0.1s;
        }
        .grid > *:nth-child(2) {
          animation-delay: 0.2s;
        }
        .grid > *:nth-child(3) {
          animation-delay: 0.3s;
        }
        .grid > *:nth-child(4) {
          animation-delay: 0.4s;
        }
      `}</style>
    </div>
  );
}

export default MainComponent;
