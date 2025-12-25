"use client";
import React, { useState, useEffect } from "react";
import NavigationBar from "../components/navigation-bar";
import BetSlip from "../components/bet-slip";
import { useUser, useAuth } from "@clerk/nextjs";
import Image from "next/image";
import Img1 from "../images/roulette.jpg";
import Img2 from "../images/blackjack.jpg";
import Img3 from "../images/poker.jpg";
import Img4 from "../images/plinko.jpg";
import SportCard from "../components/sport-card";
import EventCard from "../components/event-card";

function MainComponent() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();

  const [selectedBet, setSelectedBet] = useState(null);
  const [selectedOdds, setSelectedOdds] = useState(null);
  const [sports, setSports] = useState([]);
  const [events, setEvents] = useState([]);
  const [loadingSports, setLoadingSports] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [errorSports, setErrorSports] = useState(null);
  const [errorEvents, setErrorEvents] = useState(null);
  const [userTokens, setUserTokens] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [betInProgress, setBetInProgress] = useState(false);
  const [notification, setNotification] = useState(null);
  const [jwt, setJwt] = useState(null);

  const handleLoadSports = async () => {
    try {
      setLoadingSports(true);
      const res = await fetch("/api/list-sports", { method: "POST", body: JSON.stringify({}) });
      if (!res.ok) throw new Error(`Error fetching sports: ${res.status}`);
      const data = await res.json();
      setSports(data.sports);
    } catch (error) {
      setErrorSports("Failed to load sports");
      console.error(error);
    } finally {
      setLoadingSports(false);
    }
  };

  const handleLoadEvents = async () => {
    try {
      setLoadingEvents(true);
      const res = await fetch("/api/get-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Error fetching events: ${res.status}`);
      const data = await res.json();
      setEvents(data);
    } catch (error) {
      setErrorEvents("Failed to load events");
      console.error(error);
    } finally {
      setLoadingEvents(false);
    }
  };

  const fetchUserTokens = async () => {
    if (!user || !jwt) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        credentials: "include",
      });

      if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
      const data = await res.json();

      if (!data.success || !data.data) {
        const initRes = await fetch("/api/initialize-user-tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          credentials: "include",
        });
        if (!initRes.ok) throw new Error(`Init failed: ${initRes.status}`);

        const finalRes = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          credentials: "include",
        });

        const finalData = await finalRes.json();
        if (finalData.success) {
          setUserTokens(finalData.data.balance);
        }
      } else {
        setUserTokens(data.data.balance);
      }
    } catch (err) {
      console.error("Token fetch error:", err);
      setError("Impossible de gérer vos tokens");
      setUserTokens(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user && jwt) fetchUserTokens();
  }, [user, jwt]);

  const handleBetSelect = (team, odds) => {
    setSelectedBet(team);
    setSelectedOdds(odds);
  };

  const handleBetSubmit = async (betData) => {
    if (!user) {
      window.location.href = "/account/signin?callbackUrl=/";
      return;
    }

    if (!userTokens || userTokens < betData.amount) {
      showNotification("Solde insuffisant pour placer ce pari", "error");
      return;
    }

    setBetInProgress(true);
    setError(null);

    try {
      const res = await fetch("/api/bets/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(betData),
        credentials: "include",
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Erreur lors du placement du pari");
      }

      setSelectedBet(null);
      setSelectedOdds(null);
      setUserTokens(data.data.newBalance);
      showNotification("Pari placé avec succès!", "success");
    } catch (err) {
      console.error("Bet error:", err);
      showNotification(err.message || "Erreur lors du placement du pari", "error");
    } finally {
      setBetInProgress(false);
    }
  };

  const showNotification = (message, type = "info") => {
    setNotification({ message, type });
  };

  return (
   <div className="animated-bg">
      <NavigationBar currentPath="/" />

      <section className="bg [#003366] px-4 py-20 mt-8">
        <div className="mx-auto max-w-7xl text-center">
      <h1
  className="mb-4 text-4xl md:text-6xl font-extrabold text-transparent bg-clip-text 
  bg-gradient-to-r from-yellow-300 via-yellow-400 to-yellow-300
  drop-shadow-[0_0_8px_rgba(255,215,0,0.6)] tracking-widest uppercase 
  animate-[shimmerGradient_8s_ease-in-out_infinite]"
  style={{ backgroundSize: "200% auto" }}
>
  Pariez sur vos Sports Préférés et Jouez au Casino
</h1>

          <p className="mb-8 text-xl text-white">
            Des cotes compétitives, des paris en direct, des jeux de casino et
            des récompenses exclusives
          </p>
   <div className="flex flex-col space-y-4 sm:flex-row sm:justify-center sm:space-x-4 sm:space-y-0">
  <a
    href="/sign-up"
    className="inline-block rounded-lg bg-[#FFD700] px-8 py-4 text-lg font-medium text-[#003366] transition-all glow-pulse commencer-hover"
  >
    Commencer à Parier
  </a>
  <a
    href="/casino"
    className="inline-block rounded-lg border-2 border-[#FFD700] px-8 py-4 text-lg font-medium text-[#FFD700] transition-all glow-pulse decouvrir-hover"
  >
    Découvrir le Casino
  </a>
</div>

        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 py-8">
        <section className="mb-16">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-[#FFD700]">Casino en Ligne</h2>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
            <a
              href="/casino/roulette"
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
                Affrontez le croupier dans ce jeu de cartes classique
              </p>
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
                Affrontez l'IA ou d'autres joueurs dans des parties passionnantes
              </p>
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
                Regardez tomber votre jeton et multipliez vos gains
              </p>
            </a>
          </div>

          {/* Bouton More centré sous la grille */}
          <div className="flex justify-center mt-8">
  <a
    href="/casino"
    className="inline-block rounded-lg bg-[#FFD700] px-6 py-3 text-lg font-semibold text-[#003366] transition-all glow-pulse more-hover"
  >
    Plus de jeux
  </a>
</div>

        </section>

        <section className="mb-16">
          <div className="mb-8 flex justify-between items-center">
            <h2 className="text-2xl font-bold text-[#FFD700]">Sports Populaires</h2>
            <button
              onClick={handleLoadSports}
              className="inline-block rounded-lg bg-[#FFD700] px-6 py-3 text-lg font-semibold text-[#003366] transition-all glow-pulse more-hover"
            >
              Charger les Sports
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {loadingSports ? (
              <div className="text-center col-span-full text-[#FFD700]">Chargement...</div>
            ) : (
              sports.map((sport) => (
                <SportCard
                  key={sport.id}
                  icon={`fa-${sport.icon_name}`}
                  name={sport.name}
                  onClick={() => handleLoadEvents(sport.id)}
                />
              ))
            )}
          </div>
        </section>

        <section className="mb-16">
          <div className="mb-8 flex justify-between items-center">
            <h2 className="text-2xl font-bold text-[#FFD700]">Matchs du Jour</h2>
            <button
              onClick={handleLoadEvents}
              className="inline-block rounded-lg bg-[#FFD700] px-6 py-3 text-lg font-semibold text-[#003366] transition-all glow-pulse more-hover"
            >
              Charger les Événements
            </button>
          </div>
          <div className="space-y-4">
            {loadingEvents ? (
              <div className="text-center text-[#FFD700]">Chargement...</div>
            ) : (
              events.map((event) => (
                <EventCard
                  key={event.id}
                  team1={event.team1}
                  team2={event.team2}
                  date={event.date}
                  time={event.time}
                  odds1={event.odds1}
                  oddsDraw={event.oddsDraw}
                  odds2={event.odds2}
                  onBetSelect={(team, odds) => {
                    setSelectedBet(team);
                    setSelectedOdds(odds);
                  }}
                />
              ))
            )}
          </div>
        </section>

        <div className="lg:sticky lg:top-24">
          <BetSlip selectedBet={selectedBet} odds={selectedOdds} onSubmit={handleBetSubmit} />
        </div>
      </div>

      {notification && (
        <div
          className={`fixed bottom-4 right-4 p-4 rounded-lg text-white ${
            notification.type === "success" ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {notification.message}
        </div>
      )}
    </div>
  );
}

export default MainComponent;
