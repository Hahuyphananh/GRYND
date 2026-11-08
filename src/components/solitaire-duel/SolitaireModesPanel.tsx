"use client";

// src/components/solitaire-duel/SolitaireModesPanel.tsx
//
// PROFILE → MODES. Three sections, three data sources, no mixing:
//
//   * Ranked  — links to the rating/history surfaces the profile already owns.
//               No numbers are re-derived here, so nothing can disagree with
//               the ranked widgets below.
//   * Solo    — GET /api/solitaire/solo (solo table only).
//   * Daily   — GET /api/solitaire/daily  (daily table only, plus streak).
//
// Every unavailable figure renders as "—". A guest sees the solo/daily empty
// state with a sign-in hint rather than a fabricated zero (a real 0 and "not
// recorded" are different claims).

import { useEffect, useState } from "react";
import Link from "next/link";

import { formatDuration, summariseSolo } from "../../lib/solitaire-duel/soloStats.js";

type SoloSummary = ReturnType<typeof summariseSolo>;

type DailySummary = {
  completed: number;
  currentStreak: number;
  longestStreak: number;
  bestMs: number | null;
  today: { completed: boolean; moves: number; elapsedMs: number | null } | null;
};

const DASH = "—";

export default function SolitaireModesPanel() {
  const [solo, setSolo] = useState<SoloSummary | null>(null);
  const [daily, setDaily] = useState<DailySummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const json = (url: string) =>
      fetch(url, { credentials: "same-origin" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

    Promise.all([json("/api/solitaire/solo"), json("/api/solitaire/daily")]).then(([soloBody, dailyBody]) => {
      if (cancelled) return;
      if (soloBody?.data?.summary) setSolo(soloBody.data.summary as SoloSummary);
      if (dailyBody?.data?.summary) setDaily(dailyBody.data.summary as DailySummary);
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const soloRows: Array<[string, string]> = [
    ["Games played", solo ? String(solo.games) : DASH],
    ["Completed", solo ? String(solo.completed) : DASH],
    ["Completion rate", solo && solo.completionRate !== null ? `${solo.completionRate}%` : DASH],
    ["Best time", formatDuration(solo?.bestMs ?? null)],
    ["Average time", formatDuration(solo?.averageMs ?? null)],
  ];

  const dailyRows: Array<[string, string]> = [
    ["Challenges completed", daily ? String(daily.completed) : DASH],
    ["Current streak", daily ? String(daily.currentStreak) : DASH],
    ["Longest streak", daily ? String(daily.longestStreak) : DASH],
    ["Best time", formatDuration(daily?.bestMs ?? null)],
    ["Today", daily?.today ? (daily.today.completed ? "Completed" : "In progress") : DASH],
  ];

  return (
    <section aria-labelledby="solitaire-modes-heading" className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="solitaire-modes-heading" className="text-lg font-bold text-white">
          Solitaire modes
        </h2>
        {!loaded && <span className="text-xs text-white/40">Loading…</span>}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-cyan-400/25 bg-cyan-400/[0.05] p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300">Ranked PvP</p>
          <p className="mt-2 text-sm leading-relaxed text-white/60">
            Rating, recent matches and trophies are in the ranked sections of this
            profile. Ranked only counts real human opponents.
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <Link href="/classement" className="font-semibold text-cyan-300 hover:text-cyan-200">
              Leaderboard →
            </Link>
            <Link href="/games/solitaire-duel/play" className="font-semibold text-white/70 hover:text-white">
              Play ranked →
            </Link>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/45">Solo Solitaire</p>
          <dl className="mt-2 space-y-1 text-sm">
            {soloRows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt className="text-white/50">{label}</dt>
                <dd className="font-mono text-white">{value}</dd>
              </div>
            ))}
          </dl>
          <Link href="/solitaire" className="mt-3 inline-block text-sm font-semibold text-white/75 hover:text-white">
            Play solo →
          </Link>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/45">Daily Challenge</p>
          <dl className="mt-2 space-y-1 text-sm">
            {dailyRows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt className="text-white/50">{label}</dt>
                <dd className="font-mono text-white">{value}</dd>
              </div>
            ))}
          </dl>
          <Link href="/daily" className="mt-3 inline-block text-sm font-semibold text-white/75 hover:text-white">
            Today&apos;s deal →
          </Link>
        </div>
      </div>

      {loaded && !solo && !daily && (
        <p className="mt-2 text-xs text-white/40">
          Sign in to record solo games and daily streaks. Prefer to stay a guest?
          Solo still works, with records kept in this browser.
        </p>
      )}
    </section>
  );
}
