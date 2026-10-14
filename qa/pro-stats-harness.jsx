// qa/pro-stats-harness.jsx
//
// Mounts the REAL GRYND PRO performance dashboard
// (src/components/stats/PerformanceDashboard.tsx) under the REAL
// LanguageProvider, with a stubbed `fetch` standing in for
// /api/stats/performance.
//
// WHY THIS EXISTS
//   The tests prove the maths, the query layer and the access control. They
//   cannot prove a chart actually draws: an SVG with no path, an axis with no
//   dates, a tooltip that never appears or a table that renders its header only
//   all pass a unit test. This harness renders the component in a real browser
//   so qa/pro-stats-check.mjs can assert what is ON SCREEN — including the
//   states that matter (a locked account, an account with no results, a failed
//   request, a single-point series) and the responsive layouts.
//
// THE SCENARIO IS IN THE URL: ?scenario=pro|locked|free|guest|empty|onepoint|error|loading
//
// Run through qa/pro-stats-check.mjs — it compiles this file, serves it over a
// real http origin and drives every scenario at two viewports.

import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/context/LanguageContext";
import { SWRProvider } from "../src/components/SWRProvider";
import PerformanceDashboard from "../src/components/stats/PerformanceDashboard";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") || "pro";

// ── The fixture ────────────────────────────────────────────────────────────
// Deliberately NOT round numbers, so a hardcoded placeholder in the UI cannot
// pass an assertion by accident, and derived fields (the win rate, the record
// line) are computed here the same way the server computes them.

const PER_GAME = [
  {
    gameKey: "chess",
    label: "Chess",
    matches: 20,
    wins: 14,
    losses: 4,
    draws: 2,
    rating: 1180,
    trophies: 240,
  },
  {
    gameKey: "pool",
    label: "Pool Masters",
    matches: 12,
    wins: 8,
    losses: 2,
    draws: 2,
    rating: 1020,
    trophies: 90,
  },
  {
    // A placement table: trophies only, no Elo row — its rating must be null.
    gameKey: "tower-arena",
    label: "Tower Arena",
    matches: 9,
    wins: 6,
    losses: 3,
    draws: 0,
    rating: null,
    trophies: 150,
  },
];

const round2 = (value) => Math.round(value * 100) / 100;
const rate = (wins, losses) =>
  wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : null;

const day = (index) => {
  const month = String(1 + Math.floor(index / 28)).padStart(2, "0");
  const date = String(1 + (index % 28)).padStart(2, "0");
  return `2026-${month}-${date}T12:00:00.000Z`;
};

function summary() {
  const matches = PER_GAME.reduce((total, row) => total + row.matches, 0);
  const wins = PER_GAME.reduce((total, row) => total + row.wins, 0);
  const losses = PER_GAME.reduce((total, row) => total + row.losses, 0);
  const draws = PER_GAME.reduce((total, row) => total + row.draws, 0);
  return {
    matches,
    wins,
    losses,
    draws,
    decided: wins + losses,
    winRate: rate(wins, losses),
    firstAt: day(0),
    lastAt: day(51),
  };
}

const perGame = () =>
  PER_GAME.map((row) => ({
    ...row,
    decided: row.wins + row.losses,
    winRate: rate(row.wins, row.losses),
    firstAt: day(0),
    lastAt: day(Math.min(row.matches, 51)),
  }));

const chessSeries = () =>
  Array.from({ length: 20 }, (_, index) => ({
    at: day(index),
    value: 1000 + 10 * index,
  }));

const overallSeries = () =>
  Array.from({ length: 12 }, (_, index) => ({
    at: day(index + 8),
    overallElo: 990 + 4 * index,
    eligibleGames: 3,
  }));

const trophySeries = (total) =>
  Array.from({ length: 20 }, (_, index) => ({
    at: day(index),
    value: Math.round((total * (index + 1)) / 20),
  }));

const recent = () =>
  Array.from({ length: 10 }, (_, index) => ({
    gameKey: index % 2 === 0 ? "chess" : "pool",
    matchId: `fixture-${index + 1}`,
    outcome: index % 4 === 3 ? "loss" : index % 5 === 4 ? "draw" : "win",
    at: day(51 - index),
    rating: 1180 - index * 6,
    trophies: 240 - index * 10,
    ratingDelta: index % 4 === 3 ? -12 : 14,
    trophyDelta: index % 4 === 3 ? -30 : 30,
    opponentName: `Rival ${index + 1}`,
  }));

const rankHistory = () =>
  Array.from({ length: 12 }, (_, index) => ({
    bucket: day(index + 8).slice(0, 10),
    overallElo: 990 + 4 * index,
    overallRank: 1402 - 20 * index,
    eligibleGames: 3,
  }));

function payload(gameKey) {
  const total = summary();
  const selected = gameKey && gameKey !== "all" ? gameKey : null;
  const rating = chessSeries();
  const trophies = trophySeries(selected === "chess" ? 240 : 480);

  return {
    success: true,
    pro: true,
    locked: false,
    game: selected,
    games: PER_GAME.map((row) => row.gameKey),
    gameLabels: Object.fromEntries(PER_GAME.map((row) => [row.gameKey, row.label])),
    summary: total,
    perGame: perGame(),
    series: {
      game: selected,
      // Per-game Elo only exists when ONE game is selected — with no filter it
      // is empty (the UI must ask for a game, not draw a merged line).
      rating: selected ? rating : [],
      ratingChange: selected ? rating[rating.length - 1].value - rating[0].value : null,
      overallElo: overallSeries(),
      overallEloChange:
        overallSeries()[overallSeries().length - 1].overallElo - overallSeries()[0].overallElo,
      trophy: trophies,
      trophyChange: trophies[trophies.length - 1].value - trophies[0].value,
      rowsUsed: total.matches,
      capped: false,
    },
    recent: recent(),
    recentForm: {
      outcomes: recent().slice(0, 10).map((entry) => entry.outcome),
      winRate: 62.5,
      streak: { outcome: "win", length: 3 },
    },
    rankHistory: rankHistory(),
    eligibility: { provisionalGames: 10, overallMinGames: 3 },
    generatedAt: "2026-03-05T09:30:00.000Z",
  };
}

function emptyPayload() {
  const zero = {
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    decided: 0,
    winRate: null,
    firstAt: null,
    lastAt: null,
  };
  return {
    success: true,
    pro: true,
    locked: false,
    game: null,
    games: PER_GAME.map((row) => row.gameKey),
    gameLabels: Object.fromEntries(PER_GAME.map((row) => [row.gameKey, row.label])),
    summary: zero,
    perGame: [],
    series: {
      game: null,
      rating: [],
      ratingChange: null,
      overallElo: [],
      overallEloChange: null,
      trophy: [],
      trophyChange: null,
      rowsUsed: 0,
      capped: false,
    },
    recent: [],
    recentForm: { outcomes: [], winRate: null, streak: null },
    rankHistory: [],
    eligibility: { provisionalGames: 10, overallMinGames: 3 },
    generatedAt: "2026-03-05T09:30:00.000Z",
  };
}

function onePointPayload() {
  const base = payload("chess");
  const onlyPoint = chessSeries().slice(0, 1);
  return {
    ...base,
    series: {
      ...base.series,
      rating: onlyPoint,
      ratingChange: null,
      // One measurement is not a curve: the chart must say so rather than draw
      // a flat line through a single reading.
      overallElo: [overallSeries()[0]],
      overallEloChange: null,
      trophy: trophySeries(240).slice(0, 1),
      trophyChange: null,
    },
    rankHistory: rankHistory().slice(0, 1),
  };
}

const LOCKED = {
  success: true,
  pro: false,
  locked: true,
  game: null,
  games: PER_GAME.map((row) => row.gameKey),
  gameLabels: Object.fromEntries(PER_GAME.map((row) => [row.gameKey, row.label])),
  upgradeUrl: "/upgrade-pro",
};

const state = (window.__proStats = { requests: [] });

window.fetch = async (url) => {
  const text = String(url);
  state.requests.push(text);

  if (scenario === "error") {
    return new Response(JSON.stringify({ success: false, error: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (scenario === "loading") {
    // Never resolves in time: the check asserts the skeleton, not the data.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }

  const query = new URL(text, window.location.origin).searchParams;
  const body =
    scenario === "empty"
      ? emptyPayload()
      : scenario === "onepoint"
        ? onePointPayload()
        : scenario === "locked"
          ? {
              // The server is what decides: the page prop says "member" and the
              // API still answers locked.
              ...LOCKED,
            }
          : payload(query.get("game"));

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const PROPS = {
  pro: scenario === "lock" || scenario === "free" || scenario === "guest" ? false : true,
  signedIn: scenario === "guest" ? false : true,
};

// The values the check script asserts are actually rendered.
window.__expected = {
  matches: String(summary().matches),
  record: `${summary().wins}\u2013${summary().losses}\u2013${summary().draws}`,
  winRate: `${summary().winRate.toFixed(1)}%`,
  chessRating: "1,180",
  rankBest: "#1,182",
  generatedAt: "Mar 5, 2026",
  scenarios: { scenario, ...PROPS },
};

// The app's own data layer: SWR's fetcher (and its persistent cache) come from
// SWRProvider, exactly as they do on the real page — the dashboard's request is
// therefore made the way it is made in production.
createRoot(document.getElementById("root")).render(
  <SWRProvider>
    <LanguageProvider>
      <PerformanceDashboard signedIn={PROPS.signedIn} pro={PROPS.pro} />
    </LanguageProvider>
  </SWRProvider>,
);
