"use client";

import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import Image from "next/image";

import Img1 from "../../images/roulette.jpg";
import Img2 from "../../images/blackjack.jpg";
import Img3 from "../../images/poker.jpg";
import Img4 from "../../images/plinko.jpg";
import Img5 from "../../images/mines.jpg";
import Img6 from "../../images/crash.jpg";
import Img7 from "../../images/chess.jpg";
import Img8 from "../../images/slots.jpg";
import Img9 from "../../images/coin-flip.png";
import Img10 from "../../images/2048.jpg";

function MainComponent() {
  const { isLoaded, isSignedIn } = useUser();
  const [error, setError] = useState<string | null>(null);
  const [userTokens, setUserTokens] = useState<any>(null);

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      fetch("/api/get-user-tokens", {
        method: "POST",
      })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || "Erreur inconnue");
          }
          setUserTokens(data.data);
        })
        .catch((err) => {
          console.error("❌ Erreur API:", err.message);
          setError(err.message);
        });
    }
  }, [isLoaded, isSignedIn]);

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
          {userTokens && (
            <div className="mx-auto mb-4 max-w-md rounded-lg bg-green-500/10 p-3 text-sm text-green-500">
              Jetons disponibles : {userTokens.tokens}
            </div>
          )}
        </section>

        <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4">
          {[
            { name: "Roulette", img: Img1, link: "/roulette" },
            { name: "Blackjack", img: Img2, link: "/blackjack" },
            { name: "Poker", img: Img3, link: "/poker" },
            { name: "Plinko", img: Img4, link: "/plinko" },
            { name: "Mines", img: Img5, link: "/mines" },
            { name: "Crash", img: Img6, link: "/crash" },
            { name: "Échecs", img: Img7, link: "/chess" },
            { name: "Machines à sous", img: Img8, link: "/slots" },
            { name: "Pile ou face", img: Img9, link: "/coin-flip" },
            { name: "2048", img: Img10, link: "/2048" },
          ].map((game, i) => (
            <a
              href={game.link}
              key={i}
              className="overflow-hidden rounded-2xl bg-white/5 shadow-lg transition-transform hover:scale-105"
            >
              <Image
                src={game.img}
                alt={game.name}
                className="w-full object-cover"
              />
              <div className="p-3 text-center text-white">{game.name}</div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export default MainComponent;
