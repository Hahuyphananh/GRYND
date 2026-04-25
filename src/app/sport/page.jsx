"use client";

import React, { useMemo, useState, useEffect } from "react";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";
import EventCard from "../../components/event-card";
import BetSlip from "../../components/bet-slip";
import BetTracker from "../../components/BetTracker";
import { useTranslation } from "../../hooks/useTranslation";

const MARKET_TYPES = [
  { key: "h2h", labelKey: "sports.moneyline" },
  { key: "spreads", labelKey: "sports.point_spread" },
  { key: "totals", labelKey: "sports.over_under" },
  { key: "props", labelKey: "sports.prop_bets" },
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
  const [currentBets, setCurrentBets] = useState([]);
  const [betHistory, setBetHistory] = useState([]);
  const { t } = useTranslation();

  const fetchMyBets = async () => {
    const res = await fetch("/api/sports/my-bets", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || t("sports.fetch_bets_failed"));
    }
    setCurrentBets(Array.isArray(data.currentBets) ? data.currentBets : []);
    setBetHistory(Array.isArray(data.betHistory) ? data.betHistory : []);
  };

  const settleAndRefreshBets = async () => {
    await fetch("/api/sports/settle", { method: "POST" });
    await fetchMyBets();
  };

  useEffect(() => {
    if (!user) return;
    settleAndRefreshBets().catch((err) => {
      console.error(err);
    });
    const id = setInterval(() => {
      settleAndRefreshBets().catch((err) => console.error(err));
    }, 45000);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    const fetchSports = async () => {
      setLoadingSports(true);
      try {
        const res = await fetch("/api/sports/list");
        const data = await res.json();
        if (!data.success) throw new Error(data.error || t("sports.load_sports_failed"));

        const grouped = {};
        data.sports.forEach((sport) => {
          if (!grouped[sport.group]) grouped[sport.group] = [];
          grouped[sport.group].push(sport);
        });

        setSports(grouped);
      } catch (err) {
        console.error(err);
        setError(t("sports.load_sports_failed"));
      } finally {
        setLoadingSports(false);
      }
    };

    fetchSports();
  }, []);

  const fetchEvents = async ({ forceRefresh = false } = {}) => {
    if (!selectedSport) {
      setError(t("sports.select_league_first"));
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
      if (!data.success) throw new Error(data.error || t("sports.load_events_failed"));
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (err) {
      console.error(err);
      setError(t("sports.load_events_failed"));
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
  if (!res.ok) throw new Error(data.error || t("sports.bet_failed"));

  await fetchMyBets();

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
                <h1 className="text-2xl font-bold">{t("sports.title")}</h1>
                <p className="text-sm text-[#95e4ff]">{t("sports.manual_loading")}</p>
              </div>
              
            </div>
            {selectedSport && <p className="mt-2 text-sm">{t("sports.selected_league")} {selectedSport}</p>}
            <p className="text-sm">{t("sports.events_loaded")} {eventCount}</p>
            {error && <p className="mt-1 text-sm text-red-300">{error}</p>}
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr_360px]">
            <aside className="space-y-2 rounded-xl border border-[#00e5ff]/50 bg-[#08142f]/95 p-3">
              <h2 className="px-2 py-1 text-sm font-bold uppercase tracking-wide text-[#f5ff3b]">{t("sports.leagues")}</h2>
              {loadingSports && <p className="px-2 text-sm text-[#00e5ff]">{t("sports.loading_leagues")}</p>}
              {!loadingSports && Object.keys(sports).length === 0 && <p className="px-2 text-sm text-[#00e5ff]">{t("sports.leagues_not_found")}</p>}

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
                      {selectedSport && (
  <div className="flex items-center justify-between rounded-xl border border-[#00e5ff]/45 bg-[#08142f]/95 p-3">
    <div>
      <p className="text-sm text-[#95e4ff]">{t("sports.select_league")}</p>
      <p className="font-bold text-[#f5ff3b]">{selectedSport}</p>
    </div>

    <button
      onClick={() => fetchEvents({ forceRefresh: true })}
      className="rounded-lg border border-[#00e5ff] px-3 py-2 text-sm font-semibold text-[#00e5ff] hover:bg-[#00e5ff]/10"
    >
      {t("sports.refresh")}
    </button>
  </div>
)}
                      {sports[group].map((league) => (
                        <li
  key={league.key}
  onClick={() => {
    setSelectedSport(league.key);
    fetchEvents(); // 🔥 auto load events
  }}
  className={`cursor-pointer border-t border-[#00e5ff]/20 px-3 py-2 text-sm ${
    selectedSport === league.key
      ? "bg-[#f5ff3b] text-[#071421]"
      : "text-[#9dd8ff] hover:bg-[#003b8e]"
  }`}
>
  <div className="flex items-center justify-between">
    <div>
      <p className="font-semibold">{league.title}</p>
      <p className="text-xs opacity-80">
        {league.description || t("sports.live_odds_fallback")}
      </p>
    </div>

    {/* 🔥 NEW BUTTON */}
    <button
      onClick={(e) => {
        e.stopPropagation();
        setSelectedSport(league.key);
        fetchEvents();
      }}
      className="ml-2 rounded-md border border-[#f5ff3b]/50 bg-[#f5ff3b] px-2 py-1 text-xs font-bold text-[#031026] hover:brightness-95"
    >
      {t("sports.view")}
    </button>
  </div>
</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </aside>

            <section className="space-y-4">
              <div className="rounded-xl border border-[#00e5ff]/45 bg-[#08142f]/95 p-3">
                <p className="mb-2 text-xs uppercase tracking-wide text-[#f5ff3b]">{t("sports.bet_type")}</p>
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
                      {t(type.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {loadingEvents && <p className="text-[#00e5ff]">{t("sports.loading_events")}</p>}
              {!loadingEvents && events.length === 0 && (
                <div className="rounded-xl border border-dashed border-[#00e5ff]/50 p-6 text-center text-[#00e5ff]">
                {!selectedSport
  ? t("sports.select_league_prompt")
  : t("sports.no_events")}
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

           <aside className="sticky top-24 h-fit space-y-4">
  <div className="rounded-xl border border-[#00e5ff]/45 bg-[#08142f]/95 p-4">
    <BetSlip
      selectedBet={selectedBet}
      marketType={selectedMarket}
      onSubmit={handleBetSubmit}
      user={user}
    />
  </div>

  <BetTracker currentBets={currentBets} betHistory={betHistory} />
</aside>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MainComponent;
