"use client";

import React, { useMemo } from "react";

function OutcomeButton({ label, price, onClick }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg bg-[#FFD700] px-3 py-2 text-sm font-semibold text-[#003366] hover:bg-[#FFD700]/90"
    >
      {label} <span className="ml-1">{price}</span>
    </button>
  );
}

export default function EventCard({
  event,
  selectedMarket = "h2h",
  onBetSelect,
  team1,
  team2,
  date,
  time,
  odds1,
  oddsDraw,
  odds2,
}) {
  const fallbackEvent = useMemo(() => {
    if (event) return event;

    return {
      id: `${team1}-${team2}-${date}`,
      home_team: team1,
      away_team: team2,
      commence_time: new Date(`${date} ${time}`).toISOString(),
      bookmakers: [
        {
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: team1, price: odds1 },
                ...(oddsDraw ? [{ name: "Draw", price: oddsDraw }] : []),
                { name: team2, price: odds2 },
              ],
            },
          ],
        },
      ],
    };
  }, [event, team1, team2, date, time, odds1, odds2, oddsDraw]);

  const bookmaker = fallbackEvent.bookmakers?.[0];
  const market = bookmaker?.markets?.find((m) => m.key === selectedMarket) || bookmaker?.markets?.[0];
  const outcomes = market?.outcomes || [];

  const label =
    selectedMarket === "spreads"
      ? "Spread"
      : selectedMarket === "totals"
      ? "Total"
      : selectedMarket === "props"
      ? "Prop"
      : "Moneyline";

  return (
    <div className="rounded-xl border border-[#FFD700] bg-[#003366] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold text-white">
            {fallbackEvent.home_team} vs {fallbackEvent.away_team}
          </h3>
          <p className="text-xs text-gray-300">
            {new Date(fallbackEvent.commence_time).toLocaleDateString()} · {new Date(fallbackEvent.commence_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <span className="rounded-md border border-[#FFD700]/50 px-2 py-1 text-xs text-[#FFD700]">{label}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {outcomes.map((outcome) => (
          <OutcomeButton
            key={`${fallbackEvent.id}-${selectedMarket}-${outcome.name}`}
            label={outcome.name}
            price={outcome.price}
            onClick={() =>
              onBetSelect?.({
                eventId: fallbackEvent.id,
                marketType: selectedMarket,
                label: outcome.name,
                odds: outcome.price,
                line: outcome.point ?? null,
                eventLabel: `${fallbackEvent.home_team} vs ${fallbackEvent.away_team}`,
              })
            }
          />
        ))}
      </div>
    </div>
  );
}
