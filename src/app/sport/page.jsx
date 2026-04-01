"use client";

import React, { useMemo, useState, useEffect } from "react";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";
import EventCard from "../../components/event-card";
import BetSlip from "../../components/bet-slip";

const MARKET_TYPES = [
  { key: "h2h", label: "Moneyline" },
  { key: "spreads", label: "Point Spread" },
  { key: "totals", label: "Over / Under" },
  { key: "props", label: "Prop Bets" },
];

const MainComponent = () => {
  const { user } = useUser();
  const [sports, setSports] = useState({});
  const [selectedSport, setSelectedSport] = useState(null);
  const [events, setEvents] = useState([]);
  const [selectedMarket, setSelectedMarket] = useState("h2h");
  const [selectedBet, setSelectedBet] = useState(null);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingSports, setLoadingSports] = useState(false);
  const [openGroup, setOpenGroup] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchSports = async () => {
      setLoadingSports(true);
      try {
        const res = await fetch("/api/sports/list");
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to load sports");

        const grouped = {};
        data.sports.forEach((sport) => {
          if (!grouped[sport.group]) grouped[sport.group] = [];
          grouped[sport.group].push(sport);
        });

        setSports(grouped);
      } catch (err) {
        console.error(err);
        setError("Unable to load leagues.");
      } finally {
        setLoadingSports(false);
      }
    };

    fetchSports();
  }, []);

  const fetchEvents = async ({ forceRefresh = false } = {}) => {
    if (!selectedSport) {
      setError("Select a league first.");
      return;
    }

    setLoadingEvents(true);
    setError("");
    setSelectedBet(null);

    try {
      const res = await fetch(
        `/api/sports/${selectedSport}?markets=h2h,spreads,totals${forceRefresh ? "&refresh=1" : ""}`
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to load events");
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (err) {
      console.error(err);
      setError("Could not fetch events. Try refresh.");
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  };

  const eventCount = useMemo(() => events.length, [events]);

  const handleBetSelection = (betSelection) => {
    setSelectedBet(betSelection);
  };

  const handleBetSubmit = async ({ amount, selection, odds, marketType, line }) => {
    const res = await fetch("/api/place-sports-bet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: selection.eventId,
        betAmount: amount,
        choice: `${marketType}:${selection.label}${line ? ` (${line})` : ""}`,
        odds,
        marketType,
        lineValue: line,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Bet placement failed");
    }

    return data;
  };

  return (
    <div>
      <NavigationBar currentPath="/sport" />
      <div className="min-h-screen bg-[#003366]">
        <div className="container mx-auto max-w-7xl px-4 py-24">
          <div className="mb-6 rounded-xl border border-[#FFD700] bg-[#002347] p-4 text-[#FFD700]">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h1 className="text-2xl font-bold">Sportsbook</h1>
                <p className="text-sm text-[#FFD700]/80">Manual loading enabled to reduce API usage.</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => fetchEvents()}
                  className="rounded-lg bg-[#FFD700] px-4 py-2 font-semibold text-[#003366] hover:bg-[#FFD700]/90"
                >
                  Show Events
                </button>
                <button
                  onClick={() => fetchEvents({ forceRefresh: true })}
                  className="rounded-lg border border-[#FFD700] px-4 py-2 font-semibold text-[#FFD700] hover:bg-[#FFD700]/10"
                >
                  Refresh
                </button>
              </div>
            </div>
            {selectedSport && <p className="mt-2 text-sm">Selected league: {selectedSport}</p>}
            <p className="text-sm">Loaded events: {eventCount}</p>
            {error && <p className="mt-1 text-sm text-red-300">{error}</p>}
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr_360px]">
            <aside className="space-y-2 rounded-xl border border-[#FFD700] bg-[#002347] p-3">
              <h2 className="px-2 py-1 text-sm font-bold uppercase tracking-wide text-[#FFD700]">Leagues</h2>
              {loadingSports && <p className="px-2 text-sm text-[#FFD700]">Loading leagues...</p>}
              {!loadingSports && Object.keys(sports).length === 0 && <p className="px-2 text-sm text-[#FFD700]">No leagues found.</p>}

              {Object.keys(sports).map((group) => (
                <div key={group} className="overflow-hidden rounded-lg border border-[#FFD700]/40">
                  <button
                    className="flex w-full items-center justify-between bg-[#003366] px-3 py-2 text-left text-[#FFD700]"
                    onClick={() => setOpenGroup(openGroup === group ? null : group)}
                  >
                    <span className="font-semibold">{group}</span>
                    <span>{openGroup === group ? "−" : "+"}</span>
                  </button>

                  {openGroup === group && (
                    <ul className="bg-[#002347]">
                      {sports[group].map((league) => (
                        <li
                          key={league.key}
                          onClick={() => setSelectedSport(league.key)}
                          className={`cursor-pointer border-t border-[#FFD700]/20 px-3 py-2 text-sm ${
                            selectedSport === league.key
                              ? "bg-[#FFD700] text-[#003366]"
                              : "text-[#FFD700] hover:bg-[#004080]"
                          }`}
                        >
                          <p className="font-semibold">{league.title}</p>
                          <p className="text-xs opacity-80">{league.description || "Live and upcoming odds"}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </aside>

            <section className="space-y-4">
              <div className="rounded-xl border border-[#FFD700] bg-[#002347] p-3">
                <p className="mb-2 text-xs uppercase tracking-wide text-[#FFD700]">Bet Type</p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {MARKET_TYPES.map((type) => (
                    <button
                      key={type.key}
                      onClick={() => setSelectedMarket(type.key)}
                      className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                        selectedMarket === type.key
                          ? "border-[#FFD700] bg-[#FFD700] text-[#003366]"
                          : "border-[#FFD700]/50 text-[#FFD700] hover:bg-[#004080]"
                      }`}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              </div>

              {loadingEvents && <p className="text-[#FFD700]">Loading events...</p>}
              {!loadingEvents && events.length === 0 && (
                <div className="rounded-xl border border-dashed border-[#FFD700]/50 p-6 text-center text-[#FFD700]">
                  Click <strong>Show Events</strong> to fetch odds on demand.
                </div>
              )}

              <div className="grid gap-4">
                {events.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    selectedMarket={selectedMarket}
                    onBetSelect={handleBetSelection}
                  />
                ))}
              </div>
            </section>

            <aside className="sticky top-24 h-fit rounded-xl border border-[#FFD700] bg-[#002347] p-4">
              <BetSlip selectedBet={selectedBet} marketType={selectedMarket} onSubmit={handleBetSubmit} user={user} />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MainComponent;
