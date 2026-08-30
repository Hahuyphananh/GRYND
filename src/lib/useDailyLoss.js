"use client";

// src/lib/useDailyLoss.js
//
// Shared client hook for the responsible-play daily-loss figure.
//
// Fetches today's settled bets from /api/get-bet-history?since=… (SQL-level
// date filter on every game table) and sums each bet's `tokenDiff` net.
// Returns { dailyNet, loss, loaded }:
//   * dailyNet — signed net (negative = losing today)
//   * loss     — positive number when losing, 0 otherwise
//   * loaded   — false until the first fetch resolves (auth failure stays
//                quiet: dailyNet 0, loaded true only on success)
//
// Used by DailyLossGuard (modal + lobby chip) and the navbar's home-page
// chip, so the number is computed exactly once per mount everywhere.

import { useEffect, useState } from "react";

function startOfTodayUtcIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function useDailyLoss() {
  const [dailyNet, setDailyNet] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/get-bet-history?since=${encodeURIComponent(startOfTodayUtcIso())}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (cancelled || !data?.success || !Array.isArray(data.bets)) return;
        const net = data.bets.reduce(
          (sum, b) => sum + (Number(b?.tokenDiff) || 0),
          0,
        );
        setDailyNet(net);
        setLoaded(true);
      } catch {
        // offline / auth failure — stay quiet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { dailyNet, loss: Math.max(0, -dailyNet), loaded };
}
