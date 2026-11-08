"use client";

// The deal is never generated in the browser. This page asks the server for
// today's DETERMINISTIC deal (derived from its own UTC clock) and renders it.
// A refresh can therefore return a different response body only in the sense of
// navigational chrome — the cards are byte-for-byte the same all day.

import { useEffect, useState } from "react";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import SoloSolitaireGame from "../../components/solitaire-duel/SoloSolitaireGame";
import { formatDuration } from "../../lib/solitaire-duel/soloStats.js";
import type { SolitaireDeal } from "../../lib/solitaire-duel/types";

type DailySummary = {
  completed: number;
  currentStreak: number;
  longestStreak: number;
  bestMs: number | null;
  today: { completed: boolean; moves: number; elapsedMs: number | null } | null;
};

type DailyPayload = {
  dateKey: string;
  timezone: string;
  deal: SolitaireDeal;
  signedIn: boolean;
  summary: DailySummary | null;
};

export default function DailyPageClient() {
  const [payload, setPayload] = useState<DailyPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/solitaire/daily", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Daily challenge unavailable");
        return response.json();
      })
      .then((body) => {
        if (!cancelled && body?.data?.deal) setPayload(body.data as DailyPayload);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = payload?.summary ?? null;

  return (
    <div className="relative min-h-screen bg-[#05070d] pb-24 text-white md:pb-0">
      <NavigationBar currentPath="/daily" />
      <main className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
          GRYND · daily challenge
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl">
          One deal.{" "}
          <span className="text-cyan-300">Everyone.</span> Every day.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
          The same deterministic Klondike deal for every player, fixed by the UTC
          date. Refreshing cannot reroll it. Your first completion of the day is
          the official result; anything after that is practice.
        </p>

        {summary && (
          <dl className="mt-5 flex flex-wrap gap-2 text-center">
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Completed</dt>
              <dd className="font-mono text-lg">{summary.completed}</dd>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Current streak</dt>
              <dd className="font-mono text-lg">{summary.currentStreak}</dd>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Longest streak</dt>
              <dd className="font-mono text-lg">{summary.longestStreak}</dd>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Best time</dt>
              <dd className="font-mono text-lg">{formatDuration(summary.bestMs)}</dd>
            </div>
          </dl>
        )}

        {!payload && !failed && (
          <p className="py-20 text-center text-sm text-white/50" aria-busy="true">
            Dealing today's challenge…
          </p>
        )}

        {failed && (
          <div className="mt-8 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-100">
            Today's deal could not be loaded. Please try again shortly.
          </div>
        )}

        {payload && (
          <SoloSolitaireGame
            mode="daily"
            daily={{
              dateKey: payload.dateKey,
              deal: payload.deal,
              signedIn: payload.signedIn,
              summary: payload.summary,
            }}
          />
        )}
      </main>
      <Footer />
    </div>
  );
}
