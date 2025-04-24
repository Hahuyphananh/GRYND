"use client";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";
import { useState, React } from "react";
import Img1 from "../images/roulette.jpg";
import Img2 from "../images/blackjack.jpg";
import Img3 from "../images/poker.jpg";
import Img4 from "../images/plinko.jpg";
import Image from "next/image";

function MainComponent() {
  const { data: user } = useUser();
  const [selectedGame, setSelectedGame] = useState(null);
  const [error, setError] = useState(null);

  return (
    <div className="min-h-screen bg-[#003366] pt-20">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-7xl px-4 py-12">
        <section className="mb-16 text-center">
          <h1 className="mb-4 text-4xl font-bold text-[#FFD700] md:text-6xl">
            Casino en Ligne
          </h1>
          <p className="mb-8 text-xl text-white">
            Découvrez nos jeux de casino et tentez votre chance
          </p>
          {error && (
            <div className="mx-auto mb-4 max-w-md rounded-lg bg-red-500/10 p-3 text-sm text-red-500">
              {error}
            </div>
          )}
          {user && <></>}
        </section>

        <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
          <a
            href="/roulette"
            className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
          >
            <div className="mb-4 h-48 overflow-hidden rounded-lg">
              <Image
                src={Img1}
                alt="Table de roulette avec jetons"
                className="h-full w-full object-cover transition-transform group-hover:scale-110"
              />
            </div>
            <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Roulette</h3>
            <p className="text-gray-300">
              Placez vos paris sur les numéros, couleurs ou sections
            </p>
            <div className="mt-4 flex items-center text-[#FFD700]">
              <span>Jouer maintenant</span>
              <i className="fas fa-arrow-right ml-2"></i>
            </div>
          </a>

          <a
            href="/casino/blackjack"
            className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
          >
            <div className="mb-4 h-48 overflow-hidden rounded-lg">
              <Image
                src={Img2}
                alt="Table de blackjack avec cartes"
                className="h-full w-full object-cover transition-transform group-hover:scale-110"
              />
            </div>
            <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Blackjack</h3>
            <p className="text-gray-300">
              Affrontez le croupier dans ce jeu de cartes classique. Obtenez 21
              points ou approchez-vous en sans dépasser !
            </p>
            <div className="mt-4 flex items-center text-[#FFD700]">
              <span>Jouer maintenant</span>
              <i className="fas fa-arrow-right ml-2"></i>
            </div>
          </a>

          <a
            href="/casino/poker"
            className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
          >
            <div className="mb-4 h-48 overflow-hidden rounded-lg">
              <Image
                src={Img3}
                alt="Table de poker avec cartes et jetons"
                className="h-full w-full object-cover transition-transform group-hover:scale-110"
              />
            </div>
            <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Poker</h3>
            <p className="text-gray-300">
              Affrontez l'IA ou d'autres joueurs dans des parties de Texas
              Hold'em passionnantes !
            </p>
            <div className="mt-4 flex items-center text-[#FFD700]">
              <span>Jouer maintenant</span>
              <i className="fas fa-arrow-right ml-2"></i>
            </div>
          </a>

          <a
            href="/casino/plinko"
            className="group relative cursor-pointer overflow-hidden rounded-lg bg-black p-4 transition-all hover:shadow-lg hover:shadow-[#FFD700]/20"
          >
            <div className="mb-4 h-48 overflow-hidden rounded-lg">
              <Image
                src={Img4}
                alt="Jeu Plinko avec des jetons qui tombent"
                className="h-full w-full object-cover transition-transform group-hover:scale-110"
              />
            </div>
            <h3 className="mb-2 text-xl font-bold text-[#FFD700]">Plinko</h3>
            <p className="text-gray-300">
              Regardez tomber votre jeton et multipliez vos gains !
            </p>
            <div className="mt-4 flex items-center text-[#FFD700]">
              <span>Jouer maintenant</span>
              <i className="fas fa-arrow-right ml-2"></i>
            </div>
          </a>
        </div>
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
