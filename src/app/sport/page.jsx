"use client";
import React from "react";
import NavigationBar from "../../components/navigation-bar";
import Link from "next/link"; // make sure this is imported at the top
import { useUser } from '@clerk/nextjs'
import { useState, useEffect  } from "react";
import EventCard from "../../components/event-card";
import BetSlip from "../../components/bet-slip";


const MainComponent = () => {
  const { data: user } = useUser();
  const [selectedSport, setSelectedSport] = useState("football");
  const [selectedBet, setSelectedBet] = useState(null);
  const [selectedOdds, setSelectedOdds] = useState(null);
  const [userTokens, setUserTokens] = useState(null);
  const [error, setError] = useState(null);

  const fetchUserTokens = async () => {
    if (!user) return;

    try {
      const response = await fetch("/api/getUserTokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Erreur HTTP: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setUserTokens(data.data.balance);
      } else {
        throw new Error(data.error || "Erreur inconnue");
      }
    } catch (error) {
      console.error("Error fetching tokens:", error);
      setError("Impossible de récupérer votre solde de tokens");
    }
  };

  useEffect(() => {
    if (user) {
      fetchUserTokens();
    }
  }, [user]);

  const handleBetSelection = (team, odds) => {
    setSelectedBet(team);
    setSelectedOdds(odds);
  };
  const handleBetSubmit = async (betData) => {
    try {
      await fetch("/api/placeBet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...betData,
          selection: selectedBet,
          odds: selectedOdds,
        }),
      });
    } catch (error) {
      console.error("Error placing bet:", error);
      throw error;
    }
  };

  return (
    <div>
      <NavigationBar currentPath="/sport" />
      <div className="min-h-screen bg-[#003366]">
        <div className="container mx-auto max-w-7xl px-4 pt-24">
          {user && (
            <div className="mb-6 flex items-center justify-end">
              <div className="rounded-lg bg-[#002347] px-4 py-2 text-[#FFD700]">
                <span className="mr-2">
                  <i className="fas fa-coins"></i>
                </span>
                {userTokens !== null ? (
                  <span className="font-bold">{userTokens} tokens</span>
                ) : (
                  <span>Chargement...</span>
                )}
                {error && (
                  <span className="ml-2 text-red-500">
                    <i className="fas fa-exclamation-circle"></i>
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="flex flex-col md:flex-row md:space-x-8">
            <div className="flex-1">
              <div className="mb-8 flex items-center">
                <i className="fas fa-futbol mr-4 text-4xl text-[#FFD700]"></i>
                <h1 className="text-4xl font-bold text-[#FFD700]">Football</h1>
              </div>
              <div className="mb-8 flex flex-wrap gap-4">
                <button className="rounded-lg bg-[#FFD700] px-6 py-2 font-medium text-[#003366] transition-colors hover:bg-[#FFD700]/80">
                  Tous les matchs
                </button>
                <button className="rounded-lg bg-[#FFD700] px-6 py-2 font-medium text-[#003366] transition-colors hover:bg-[#FFD700]/80">
                  En direct
                </button>
                <button className="rounded-lg bg-[#FFD700] px-6 py-2 font-medium text-[#003366] transition-colors hover:bg-[#FFD700]/80">
                  À venir
                </button>
              </div>

              <div className="grid gap-6">
                <Link href="/sports/match/psg-vs-marseille">
                  <div className="rounded-lg bg-[#003366] border border-[#FFD700] p-4 hover:bg-[#004080] transition-colors">
                    <EventCard
                      team1="PSG"
                      team2="Marseille"
                      date="15 Mars 2025"
                      time="20:45"
                      odds1="1.95"
                      oddsDraw="3.40"
                      odds2="3.80"
                      onBetSelect={handleBetSelection}
                    />
                  </div>
                </Link>

                <Link href="/sports/match/lyon-vs-monaco">
                  <div className="rounded-lg bg-[#003366] border border-[#FFD700] p-4 hover:bg-[#004080] transition-colors">
                    <EventCard
                      team1="Lyon"
                      team2="Monaco"
                      date="15 Mars 2025"
                      time="21:00"
                      odds1="2.10"
                      oddsDraw="3.30"
                      odds2="3.50"
                      onBetSelect={handleBetSelection}
                    />
                  </div>
                </Link>

                <Link href="/sports/match/lens-vs-lille">
                  <div className="rounded-lg bg-[#003366] border border-[#FFD700] p-4 hover:bg-[#004080] transition-colors">
                    <EventCard
                      team1="Lens"
                      team2="Lille"
                      date="16 Mars 2025"
                      time="17:00"
                      odds1="2.40"
                      oddsDraw="3.20"
                      odds2="2.90"
                      onBetSelect={handleBetSelection}
                    />
                  </div>
                </Link>
              </div>
            </div>

            {/* Right Sidebar */}
            <div className="sticky top-24 mt-8 w-full md:mt-0 md:w-[400px]">
              <div className="rounded-lg bg-[#003366] border border-[#FFD700] p-4">
                <BetSlip
                  selectedBet={selectedBet}
                  odds={selectedOdds}
                  onSubmit={handleBetSubmit}
                />
              </div>
            </div>
          </div>
          </div>
        </div>


        <style jsx global>{`
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }

          .grid > * {
            animation: fadeIn 0.3s ease-out forwards;
          }
        `}</style>
    </div>
      );
      }


export default MainComponent;