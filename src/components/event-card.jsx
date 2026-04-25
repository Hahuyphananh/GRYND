"use client";

import React, { useMemo } from "react";
import { useTranslation } from "../hooks/useTranslation";

function OutcomeButton({ label, price, onClick }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b] px-3 py-2 text-sm font-semibold text-[#041125] shadow-[0_0_14px_rgba(245,255,59,0.4)] hover:brightness-95"
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
  const { t } = useTranslation();
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
      ? t("sports.point_spread")
      : selectedMarket === "totals"
      ? t("sports.over_under")
      : selectedMarket === "props"
      ? t("sports.prop_bets")
      : t("sports.moneyline");

  return (
    <div className="rounded-xl border border-[#00e5ff]/45 bg-[#081734]/90 p-4 shadow-[0_0_18px_rgba(0,229,255,0.2)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold text-[#ecf8ff]">
            {fallbackEvent.home_team} vs {fallbackEvent.away_team}
          </h3>
          <p className="text-xs text-[#95e4ff]">
            {new Date(fallbackEvent.commence_time).toLocaleDateString()} · {new Date(fallbackEvent.commence_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <span className="rounded-md border border-[#00e5ff]/50 px-2 py-1 text-xs text-[#00e5ff]">{label}</span>
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
