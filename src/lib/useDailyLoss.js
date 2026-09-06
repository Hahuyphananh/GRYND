"use client";

// src/lib/useDailyLoss.js
//
// Shared client hook for the responsible-play daily-loss figure.
//
// Fetches the server-maintained daily net from /api/user/daily-loss — one
// indexed users-row read (plus a single crash-arena query) instead of the
// old 24-query fan-out across every game history table. Returns
// { dailyNet, loss, loaded }:
//   * dailyNet — signed net (negative = losing today)
//   * loss     — positive number when losing, 0 otherwise
//   * loaded   — false until the first fetch resolves (auth failure stays
//                quiet: dailyNet 0, loaded true only on success)
//
// Used by DailyLossGuard (modal + lobby chip) and the navbar's home-page
// chip, so the number is computed exactly once per mount everywhere.
//
// Fetch efficiency: the navbar and the guard mount this hook at the same
// time on lobby screens. A module-level shared promise dedupes those into
// a single in-flight request, and a 60s cache makes page navigations free
// (the server-side counter only changes when a bet settles).

import { useEffect, useState } from "react";

const CACHE_TTL_MS = 60_000;

let sharedPromise = null;
let cachedNet = null;
let cachedAt = 0;

async function fetchDailyNet() {
  const res = await fetch("/api/user/daily-loss", { cache: "no-store" });
  const data = await res.json();
  if (!data?.success || typeof data.net !== "number") {
    throw new Error("Failed to fetch daily loss");
  }
  return data.net;
}

export default function useDailyLoss() {
  const [dailyNet, setDailyNet] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (cachedNet !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
          setDailyNet(cachedNet);
          setLoaded(true);
          return;
        }
        sharedPromise = sharedPromise ?? fetchDailyNet().finally(() => (sharedPromise = null));
        const net = await sharedPromise;
        if (cancelled) return;
        cachedNet = net;
        cachedAt = Date.now();
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