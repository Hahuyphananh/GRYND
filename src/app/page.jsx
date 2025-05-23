"use client";
import React from "react";
import NavigationBar from "../components/navigation-bar";
import BetSlip from "../components/bet-slip";
import { useUser } from '@clerk/nextjs'
import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Img1 from '../images/roulette.jpg';
import Img2 from '../images/blackjack.jpg';
import Img3 from '../images/poker.jpg';
import Img4 from '../images/plinko.jpg';

function MainComponent() {
  const { data: user } = useUser();
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

  useEffect(() => {
    const syncData = async () => {
      try {
        const response = await fetch("/api/sync-sports-data", {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(`Error syncing data: ${response.status}`);
        }
      } catch (error) {
        console.error("Failed to sync sports data:", error);
      }
    };
    syncData();
    const interval = setInterval(syncData, 300000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchSports = async () => {
      try {
        setLoadingSports(true);
        const response = await fetch("/api/list-sports", {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (!response.ok) {
          throw new Error(`Error fetching sports: ${response.status}`);
        }
        const data = await response.json();
        setSports(data.sports);
      } catch (error) {
        setErrorSports("Failed to load sports");
        console.error(error);
      } finally {
        setLoadingSports(false);
      }
    };
    fetchSports();
  }, []);

  useEffect(() => {
    const fetchEvents = async (sportId = null) => {
      try {
        setLoadingEvents(true);
        const response = await fetch("/api/get-events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sportId }),
        });
        if (!response.ok) {
          throw new Error(`Error fetching events: ${response.status}`);
        }
        const data = await response.json();
        setEvents(data);
      } catch (error) {
        setErrorEvents("Failed to load events");
        console.error(error);
      } finally {
        setLoadingEvents(false);
      }
    };
    fetchEvents();
  }, []);

  const fetchUserTokens = async () => {
    if (!user) return;

    setLoading(true);
    setError(null);

    try {
      const getResponse = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      if (!getResponse.ok) {
        throw new Error(`Erreur HTTP: ${getResponse.status}`);
      }

      const getData = await getResponse.json();

      if (!getData.success || !getData.data) {
        const initResponse = await fetch("/api/initialize-user-tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
        });

        if (!initResponse.ok) {
          throw new Error(`Erreur HTTP: ${initResponse.status}`);
        }

        const finalResponse = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
        });

        if (!finalResponse.ok) {
          throw new Error(`Erreur HTTP: ${finalResponse.status}`);
        }

        const finalData = await finalResponse.json();
        if (finalData.success) {
          setUserTokens(finalData.data.balance);
        }
      } else {
        setUserTokens(getData.data.balance);
      }
    } catch (error) {
      console.error("Error managing tokens:", error);
      setError("Impossible de gérer vos tokens");
      setUserTokens(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchUserTokens();
    }
  }, [user]);

    useEffect(() => {
    const syncUser = async () => {
      try {
        await fetch("/api/sync-user", {
          method: "POST",
        });
      } catch (err) {
        console.error("Failed to sync user:", err);
      }
    };

    if (user) {
      syncUser();
    }
  }, [user]);


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
      const response = await fetch("/api/bets/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(betData),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Erreur lors du placement du pari");
      }

      setSelectedBet(null);
      setSelectedOdds(null);
      setUserTokens(data.data.newBalance);
      showNotification("Pari placé avec succès!", "success");
    } catch (error) {
      console.error("Error placing bet:", error);
      showNotification(
        error.message || "Erreur lors du placement du pari",
        "error",
      );
    } finally {
      setBetInProgress(false);
    }
  };

  const handleSportClick = (sportId) => {
    fetchEvents(sportId);
  };

  const showNotification = (message, type = "info") => {
    setNotification({ message, type });
  };

  return (
    <div className="min-h-screen bg-[#003366]">
      <NavigationBar currentPath="/" />

      <section className="bg-gradient-to-r from-[#003366] to-[#004080] px-4 py-20">
        <div className="mx-auto max-w-7xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-[#FFD700] md:text-6xl">
            Pariez sur vos Sports Préférés et Jouez au Casino
          </h1>
          <p className="mb-8 text-xl text-white">
            Des cotes compétitives, des paris en direct, des jeux de casino et
            des récompenses exclusives
          </p>
          <div className="flex flex-col space-y-4 sm:flex-row sm:justify-center sm:space-x-4 sm:space-y-0">
            <a
              href="/account/signup"
              className="inline-block rounded-lg bg-[#FFD700] px-8 py-4 text-lg font-medium text-[#003366] transition-colors hover:bg-[#FFD700]/80"
            >
              Commencer à Parier
            </a>
            <a
              href="/casino"
              className="inline-block rounded-lg border-2 border-[#FFD700] px-8 py-4 text-lg font-medium text-[#FFD700] transition-colors hover:bg-[#FFD700] hover:text-[#003366]"
            >
              Découvrir le Casino
            </a>
          </div>
        </div>
      </section>

      {user && (
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex items-center justify-end space-x-2 rounded-lg bg-[#003366] p-3">
            <i className="fas fa-coins text-[#FFD700]"></i>
            <span className="text-[#FFD700] font-medium">
              {userTokens !== null ? userTokens : "..."}
            </span>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-7xl px-4 py-8">
        <section className="mb-16">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-[#FFD700]">
              Casino en Ligne
            </h2>
          </div>

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
        </section>

        <div className="mb-16">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-[#FFD700]">
              Sports Populaires
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            {loadingSports ? (
              <div className="col-span-full text-center text-[#FFD700]">
                <i className="fas fa-spinner fa-spin text-2xl"></i>
              </div>
            ) : errorSports ? (
              <div className="col-span-full text-center space-y-4">
                <p className="text-red-500">{errorSports}</p>
                <button
                  onClick={() => {
                    setErrorSports(null);
                    setLoadingSports(true);
                    fetch("/api/list-sports", {
                      method: "POST",
                      body: JSON.stringify({}),
                    })
                      .then((response) => {
                        if (!response.ok)
                          throw new Error(`Error: ${response.status}`);
                        return response.json();
                      })
                      .then((data) => {
                        setSports(data.sports);
                        setLoadingSports(false);
                      })
                      .catch((error) => {
                        setErrorSports("Failed to load sports");
                        setLoadingSports(false);
                      });
                  }}
                  className="rounded-lg bg-[#FFD700] px-4 py-2 text-[#003366] hover:bg-[#FFD700]/80 transition-colors"
                >
                  Réessayer
                </button>
              </div>
            ) : (
              sports?.map((sport) => (
                <SportCard
                  key={sport.id}
                  icon={`fa-${sport.icon_name}`}
                  name={sport.name}
                  onClick={() => handleSportClick(sport.id)}
                />
              ))
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <h2 className="mb-8 text-2xl font-bold text-[#FFD700]">
              Matchs du Jour
            </h2>
            <div className="space-y-4">
              {loadingEvents ? (
                <div className="text-center text-[#FFD700]">
                  <i className="fas fa-spinner fa-spin text-2xl"></i>
                </div>
              ) : errorEvents ? (
                <div className="text-center space-y-4">
                  <p className="text-red-500">{errorEvents}</p>
                  <button
                    onClick={() => {
                      setErrorEvents(null);
                      setLoadingEvents(true);
                      fetch("/api/get-events", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({}),
                      })
                        .then((response) => {
                          if (!response.ok)
                            throw new Error(`Error: ${response.status}`);
                          return response.json();
                        })
                        .then((data) => {
                          setEvents(data);
                          setLoadingEvents(false);
                        })
                        .catch((error) => {
                          setErrorEvents("Failed to load events");
                          setLoadingEvents(false);
                        });
                    }}
                    className="rounded-lg bg-[#FFD700] px-4 py-2 text-[#003366] hover:bg-[#FFD700]/80 transition-colors"
                  >
                    Réessayer
                  </button>
                </div>
              ) : (
                events?.map((event) => (
                  <EventCard
                    key={event.id}
                    team1={event.team1}
                    team2={event.team2}
                    date={event.date}
                    time={event.time}
                    odds1={event.odds1}
                    oddsDraw={event.oddsDraw}
                    odds2={event.odds2}
                    onBetSelect={handleBetSelect}
                  />
                ))
              )}
            </div>
          </div>

          <div className="lg:sticky lg:top-24">
            <BetSlip
              selectedBet={selectedBet}
              odds={selectedOdds}
              onSubmit={handleBetSubmit}
            />
          </div>
        </div>
      </div>

      {notification && (
        <div className={`fixed bottom-4 right-4 p-4 rounded-lg ${notification.type === "success" ? "bg-green-500" : "bg-red-500"} text-white`}>
          {notification.message}
        </div>
      )}

      <style jsx global>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .grid > * {
          animation: fadeIn 0.6s ease-out forwards;
        }

        .grid > *:nth-child(1) { animation-delay: 0.1s; }
        .grid > *:nth-child(2) { animation-delay: 0.2s; }
        .grid > *:nth-child(3) { animation-delay: 0.3s; }
        .grid > *:nth-child(4) { animation-delay: 0.4s; }
        .grid > *:nth-child(5) { animation-delay: 0.5s; }
      `}</style>
    </div>
  );
}


export default MainComponent;