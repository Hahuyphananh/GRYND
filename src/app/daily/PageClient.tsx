"use client";

// The deal is never generated in the browser. This page asks the server for
// today's DETERMINISTIC deal (derived from its own UTC clock) and renders it.
// A refresh can therefore return a different response body only in the sense of
// navigational chrome — the cards are byte-for-byte the same all day.
//
// A PAST day is the PRO archive: `?date=YYYY-MM-DD` asks the server for that
// date's deal, and the server refuses it unless the caller is a verified PRO
// member. The date is read from the URL in an effect so the page stays static
// and hydration-safe; the entitlement is never resolved in the browser.

import { useEffect, useState } from "react";
import Link from "next/link";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import DailyArchivePanel from "../../components/play/DailyArchivePanel";
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
  archived?: boolean;
  timezone: string;
  deal: SolitaireDeal;
  signedIn: boolean;
  summary: DailySummary | null;
};

type LockedPayload = { code?: string; error?: string; locked?: boolean };

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default function DailyPageClient() {
  const [payload, setPayload] = useState<DailyPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [locked, setLocked] = useState<LockedPayload | null>(null);
  const [requestedDate, setRequestedDate] = useState<string | null>(null);
  const [dateReady, setDateReady] = useState(false);

  // The archive date lives in the URL. Reading it after mount keeps the page
  // static; the server still decides whether the caller may play that day.
  useEffect(() => {
    const date = new URLSearchParams(window.location.search).get("date");
    setRequestedDate(date && DATE_KEY_PATTERN.test(date) ? date : null);
    setDateReady(true);
  }, []);

  useEffect(() => {
    if (!dateReady) return;
    let cancelled = false;
    setPayload(null);
    setFailed(false);
    setLocked(null);

    const url = requestedDate
      ? `/api/solitaire/daily?date=${encodeURIComponent(requestedDate)}`
      : "/api/solitaire/daily";

    fetch(url, { credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (response.status === 403) {
          if (!cancelled) setLocked((body as LockedPayload) ?? { code: "PRO_REQUIRED" });
          return null;
        }
        if (!response.ok) throw new Error("Daily challenge unavailable");
        return body;
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
  }, [dateReady, requestedDate]);

  const summary = payload?.summary ?? null;

  return (
    <div className="relative min-h-screen bg-[#05070d] pb-24 text-white md:pb-0">
      <NavigationBar currentPath="/daily" />
      <main className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
          GRYND · {payload?.archived ? "daily archive" : "daily challenge"}
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl">
          {payload?.archived ? (
            <>
              Past deal.{" "}
              <span className="text-cyan-300">{payload.dateKey}</span>.
            </>
          ) : (
            <>
              One deal. <span className="text-cyan-300">Everyone.</span> Every day.
            </>
          )}
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
          {payload?.archived
            ? "This is the exact deal the server derived for that UTC date. A GRYND PRO archive run keeps its own recorded result, so today's official challenge is untouched."
            : "The same deterministic Klondike deal for every player, fixed by the UTC date. Refreshing cannot reroll it. Your first completion of the day is the official result; anything after that is practice. Looking for the day's puzzle instead? It has its own page, linked below."}
        </p>

        {payload?.archived && (
          <p className="mt-3 text-xs font-semibold">
            <Link
              href="/daily"
              className="text-cyan-300 underline-offset-4 hover:underline"
            >
              ← Back to today&apos;s free challenge
            </Link>
          </p>
        )}

        {summary && (
          <dl className="mt-5 flex flex-wrap gap-2 text-center">
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Completed</dt>
              <dd className="font-mono text-lg">{summary.completed}</dd>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Current streak</dt>
              <dd className="font-mono text-lg">{Number(summary.currentStreak) || 0}</dd>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Longest streak</dt>
              <dd className="font-mono text-lg">{Number(summary.longestStreak) || 0}</dd>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-white/40">Best time</dt>
              <dd className="font-mono text-lg">{formatDuration(summary.bestMs)}</dd>
            </div>
          </dl>
        )}

        {!payload && !failed && !locked && (
          <p className="py-20 text-center text-sm text-white/50" aria-busy="true">
            Dealing the challenge…
          </p>
        )}

        {failed && (
          <div className="mt-8 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-sm text-rose-100">
            {requestedDate
              ? "That archived deal could not be loaded. Please try again shortly."
              : "Today's deal could not be loaded. Please try again shortly."}
          </div>
        )}

        {locked && (
          <div
            data-testid="daily-archive-locked"
            className="mt-8 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/[0.06] p-5"
          >
            <p className="text-sm font-semibold text-[#ffe9a3]">
              {locked.error || "Past Daily Challenges are a GRYND PRO feature."}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-white/55">
              Today&apos;s deal stays free for everyone — the archive is the PRO
              extra.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href="/upgrade-pro"
                className="inline-flex min-h-9 items-center rounded-lg bg-[#FFD700] px-3 py-1.5 text-xs font-black text-[#00212b] transition hover:brightness-110"
              >
                See GRYND PRO
              </Link>
              <Link
                href="/daily"
                className="inline-flex min-h-9 items-center rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/80 transition hover:bg-white/5"
              >
                Play today&apos;s challenge
              </Link>
            </div>
          </div>
        )}

        <div className="mt-10 flex items-center gap-3">
          <h2 className="text-lg font-black uppercase tracking-[0.2em] text-white/70">
            {payload?.archived ? "The archived deal" : "The daily game"}
          </h2>
          <span className="h-px flex-1 bg-white/10" />
        </div>

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

        <DailyArchivePanel />

        {/* PUZZLES ARE NOT THIS PAGE. The daily challenge is a full Klondike
            deal; the daily puzzle is a three-step best-move run. They used to
            share this page, which made "daily" ambiguous — a solver looking for
            the day's puzzle found it wedged above the game. Each now has its own
            page, and this link is the only mention of the puzzle here. */}
        <section aria-labelledby="daily-puzzles-heading" className="mt-10">
          <div className="flex items-center gap-3">
            <h2
              id="daily-puzzles-heading"
              className="text-lg font-black uppercase tracking-[0.2em] text-white/70"
            >
              Looking for a puzzle?
            </h2>
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">
            The daily puzzle is a different game from the daily challenge:
            three verified positions from one deal, with one mistake ending the
            run. It lives on its own page.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Link
              href="/play/daily-puzzle/play"
              data-testid="daily-to-daily-puzzle"
              className="rounded-2xl border border-sky-400/25 bg-sky-400/[0.05] p-4 transition hover:border-sky-300/50 hover:bg-sky-400/10"
            >
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-sky-300">
                Daily puzzle
              </p>
              <p className="mt-1 text-sm text-white/70">
                Three steps, one run. Free for everyone.
              </p>
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
