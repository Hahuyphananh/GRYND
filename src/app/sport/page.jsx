"use client";
import React, { useState, useEffect } from "react";
import NavigationBar from "../../components/navigation-bar";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import EventCard from "../../components/event-card";
import BetSlip from "../../components/bet-slip";

const MainComponent = () => {
  const { data: user } = useUser();
  const [sports, setSports] = useState({});
  const [selectedSport, setSelectedSport] = useState(null);
  const [events, setEvents] = useState([]);
  const [selectedBet, setSelectedBet] = useState(null);
  const [selectedOdds, setSelectedOdds] = useState(null);
  const [userTokens, setUserTokens] = useState(null);
  const [error, setError] = useState(null);
  const [openGroup, setOpenGroup] = useState(null);
  const [loadingEvents, setLoadingEvents] = useState(false); // new loading state

  // Fetch events only on button click
  const fetchEvents = async (leagueKey) => {
    if (!leagueKey) return;
    setLoadingEvents(true);
    try {
      const res = await fetch(`/api/sports/${leagueKey}`);
      const data = await res.json();
      if (data.success) setEvents(data.events);
    } catch (err) {
      console.error("Failed to fetch events:", err);
    }
    setLoadingEvents(false);
  };

  // Existing fetchSports logic stays the same
  useEffect(() => {
    const fetchSports = async () => {
      try {
        const res = await fetch("/api/sports/list");
        const data = await res.json();
        if (data.success) {
          const grouped = {};
          data.sports.forEach((sport) => {
            if (!grouped[sport.group]) grouped[sport.group] = [];
            grouped[sport.group].push(sport);
          });
          setSports(grouped);
          const firstLeague = data.sports[0]?.key;
          if (firstLeague) setSelectedSport(firstLeague);
        }
      } catch (err) {
        console.error("Failed to fetch sports:", err);
      }
    };
    fetchSports();
  }, []);

  // handleBetSelection & handleBetSubmit remain the same
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
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div>
      <NavigationBar currentPath="/sport" />
      <div className="min-h-screen bg-[#003366]">
        <div className="container mx-auto max-w-7xl px-4 pt-24">
          {/* User tokens */}
          {user && (
            <div className="mb-6 flex items-center justify-end">
              <div className="rounded-lg bg-[#002347] px-4 py-2 text-[#FFD700]">
                <span className="mr-2"><i className="fas fa-coins"></i></span>
                {userTokens !== null ? <span className="font-bold">{userTokens} tokens</span> : <span>Chargement...</span>}
                {error && <span className="ml-2 text-red-500"><i className="fas fa-exclamation-circle"></i></span>}
              </div>
            </div>
          )}

          <div className="flex flex-col md:flex-row md:space-x-8">
            {/* Sports dropdowns */}
            <div className="flex-1 mb-8">
              {Object.keys(sports).map((group) => (
                <div key={group} className="mb-2 border rounded-lg overflow-hidden">
                  <button
                    className="w-full flex justify-between px-4 py-2 bg-gray-800 text-[#FFD700] font-semibold hover:bg-gray-700"
                    onClick={() => setOpenGroup(openGroup === group ? null : group)}
                  >
                    {group} <span>{openGroup === group ? "▲" : "▼"}</span>
                  </button>
                  {openGroup === group && (
                    <ul className="bg-gray-900">
                      {sports[group].map((league) => (
                        <li key={league.key} className={`cursor-pointer px-4 py-2 transition-colors ${selectedSport === league.key ? "bg-[#FFD700] text-[#003366] font-bold" : "text-[#FFD700] hover:bg-[#FFD700]/20"}`}>
                          <div className="flex justify-between items-center">
                            <div onClick={() => setSelectedSport(league.key)}>
                              {league.title}
                              <p className="text-sm text-gray-400">{league.description}</p>
                            </div>
                            <button
                              className="ml-2 px-2 py-1 bg-[#FFD700] text-[#003366] rounded hover:bg-[#FFD700]/80 text-sm"
                              onClick={() => fetchEvents(league.key)}
                            >
                              Charger Événements
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            {/* Events */}
            <div className="flex-1 grid gap-6">
              {loadingEvents && <p className="text-[#FFD700]">Chargement des événements...</p>}
              {!loadingEvents && events.length === 0 && <p className="text-[#FFD700]">Aucun événement chargé</p>}
              {events.map((event) => (
                <Link key={event.id} href={`/sport/match/${event.id}`}>
                  <div className="rounded-lg bg-[#003366] border border-[#FFD700] p-4 hover:bg-[#004080] transition-colors">
                    <EventCard
                      team1={event.bookmakers[0]?.markets[0]?.outcomes[0]?.name || "Team 1"}
                      team2={event.bookmakers[0]?.markets[0]?.outcomes[1]?.name || "Team 2"}
                      date={new Date(event.commence_time).toLocaleDateString()}
                      time={new Date(event.commence_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      odds1={event.bookmakers[0]?.markets[0]?.outcomes[0]?.price || "-"}
                      odds2={event.bookmakers[0]?.markets[0]?.outcomes[1]?.price || "-"}
                      oddsDraw={event.bookmakers[0]?.markets[0]?.outcomes[2]?.price || null}
                      onBetSelect={handleBetSelection}
                    />
                  </div>
                </Link>
              ))}
            </div>

            {/* BetSlip Sidebar */}
            <div className="sticky top-24 mt-8 w-full md:mt-0 md:w-[400px]">
              <div className="rounded-lg bg-[#003366] border border-[#FFD700] p-4">
                <BetSlip selectedBet={selectedBet} odds={selectedOdds} onSubmit={handleBetSubmit} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MainComponent;
