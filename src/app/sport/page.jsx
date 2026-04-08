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
      <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#071536] to-[#003b8e]">
        <div className="container mx-auto max-w-7xl px-4 py-24">
          <div className="mb-6 rounded-xl border border-[#00e5ff]/50 bg-[#091537]/90 p-4 text-[#f5ff3b] shadow-[0_0_24px_rgba(0,229,255,0.2)]">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h1 className="text-2xl font-bold">Paris Sportifs</h1>
                <p className="text-sm text-[#95e4ff]">Chargement manuel activé afin de réduire l'utilisation de l'API.</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => fetchEvents()}
                  className="rounded-lg border border-[#f5ff3b]/50 bg-[#f5ff3b] px-4 py-2 font-semibold text-[#031026] shadow-[0_0_18px_rgba(245,255,59,0.45)] hover:brightness-95"
                >
                  Afficher les Événements
                </button>
                <button
                  onClick={() => fetchEvents({ forceRefresh: true })}
                  className="rounded-lg border border-[#00e5ff] px-4 py-2 font-semibold text-[#00e5ff] hover:bg-[#00e5ff]/10"
                >
                  Rafraîchir
                </button>
              </div>
            </div>
            {selectedSport && <p className="mt-2 text-sm">Ligue Sélectionnée: {selectedSport}</p>}
            <p className="text-sm">Événements chargés: {eventCount}</p>
            {error && <p className="mt-1 text-sm text-red-300">{error}</p>}
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr_360px]">
            <aside className="space-y-2 rounded-xl border border-[#00e5ff]/50 bg-[#08142f]/95 p-3">
              <h2 className="px-2 py-1 text-sm font-bold uppercase tracking-wide text-[#f5ff3b]">Ligues</h2>
              {loadingSports && <p className="px-2 text-sm text-[#00e5ff]">Chargement des Ligues...</p>}
              {!loadingSports && Object.keys(sports).length === 0 && <p className="px-2 text-sm text-[#00e5ff]">Ligues pas trouvées.</p>}

              {Object.keys(sports).map((group) => (
                <div key={group} className="overflow-hidden rounded-lg border border-[#00e5ff]/35">
                  <button
                    className="flex w-full items-center justify-between bg-[#06122b] px-3 py-2 text-left text-[#00e5ff]"
                    onClick={() => setOpenGroup(openGroup === group ? null : group)}
                  >
                    <span className="font-semibold">{group}</span>
                    <span>{openGroup === group ? "−" : "+"}</span>
                  </button>

                  {openGroup === group && (
                    <ul className="bg-[#0c1d45]">
                      {sports[group].map((league) => (
                        <li
                          key={league.key}
                          onClick={() => setSelectedSport(league.key)}
                          className={`cursor-pointer border-t border-[#00e5ff]/20 px-3 py-2 text-sm ${
                            selectedSport === league.key
                              ? "bg-[#f5ff3b] text-[#071421]"
                              : "text-[#9dd8ff] hover:bg-[#003b8e]"
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
              <div className="rounded-xl border border-[#00e5ff]/45 bg-[#08142f]/95 p-3">
                <p className="mb-2 text-xs uppercase tracking-wide text-[#f5ff3b]">Type de Pari</p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {MARKET_TYPES.map((type) => (
                    <button
                      key={type.key}
                      onClick={() => setSelectedMarket(type.key)}
                      className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                        selectedMarket === type.key
                          ? "border-[#f5ff3b] bg-[#f5ff3b] text-[#051127] shadow-[0_0_14px_rgba(245,255,59,0.4)]"
                          : "border-[#00e5ff]/50 text-[#00e5ff] hover:bg-[#003b8e]/50"
                      }`}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              </div>

              {loadingEvents && <p className="text-[#00e5ff]">Loading events...</p>}
              {!loadingEvents && events.length === 0 && (
                <div className="rounded-xl border border-dashed border-[#00e5ff]/50 p-6 text-center text-[#00e5ff]">
                  Cliquez sur<strong>Afficher les Événements</strong> pour obtenir les cotes.
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

            <aside className="sticky top-24 h-fit rounded-xl border border-[#00e5ff]/45 bg-[#08142f]/95 p-4 shadow-[0_0_18px_rgba(0,229,255,0.2)]">
              <BetSlip selectedBet={selectedBet} marketType={selectedMarket} onSubmit={handleBetSubmit} user={user} />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MainComponent;
