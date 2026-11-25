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
//
// Copy resolves through `solitaireModes.*`, so the panel reads in the player's
// language on a page that is otherwise already translated, and every surface
// reads the semantic layer rather than the old white-alpha card classes.

import { useEffect, useState } from "react";
import Link from "next/link";

import { Surface } from "../ui";
import { useTranslation } from "../../hooks/useTranslation";
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

const LINK =
  "text-sm font-semibold text-[color:var(--text-secondary)] underline-offset-4 transition-colors hover:text-[color:var(--text-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)] motion-reduce:transition-none";

export default function SolitaireModesPanel() {
  const { t } = useTranslation();
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
    [t("solitaireModes.solo.gamesPlayed"), solo ? String(solo.games) : DASH],
    [t("solitaireModes.solo.completed"), solo ? String(solo.completed) : DASH],
    [
      t("solitaireModes.solo.completionRate"),
      solo && solo.completionRate !== null ? `${solo.completionRate}%` : DASH,
    ],
    [t("solitaireModes.solo.bestTime"), formatDuration(solo?.bestMs ?? null)],
    [t("solitaireModes.solo.averageTime"), formatDuration(solo?.averageMs ?? null)],
  ];

  const dailyRows: Array<[string, string]> = [
    [
      t("solitaireModes.daily.completed"),
      daily ? String(daily.completed) : DASH,
    ],
    // A loaded 0 is a real streak state and reads as "0"; only a summary that
    // never arrived (guest, failed fetch) is unavailable, and that is the dash.
    [
      t("solitaireModes.daily.currentStreak"),
      daily ? String(Number(daily.currentStreak) || 0) : DASH,
    ],
    [
      t("solitaireModes.daily.longestStreak"),
      daily ? String(Number(daily.longestStreak) || 0) : DASH,
    ],
    [t("solitaireModes.daily.bestTime"), formatDuration(daily?.bestMs ?? null)],
    [
      t("solitaireModes.daily.today"),
      daily?.today
        ? daily.today.completed
          ? t("solitaireModes.daily.todayDone")
          : t("solitaireModes.daily.todayInProgress")
        : DASH,
    ],
  ];

  const cards = [
    {
      key: "ranked",
      title: t("solitaireModes.ranked.title"),
      body: t("solitaireModes.ranked.body"),
      links: [
        { href: "/classement", label: t("solitaireModes.ranked.leaderboard") },
        { href: "/games/solitaire-duel/play", label: t("solitaireModes.ranked.play") },
      ],
    },
    {
      key: "solo",
      title: t("solitaireModes.solo.title"),
      rows: soloRows,
      links: [{ href: "/solitaire", label: t("solitaireModes.solo.play") }],
    },
    {
      key: "daily",
      title: t("solitaireModes.daily.title"),
      rows: dailyRows,
      links: [{ href: "/daily", label: t("solitaireModes.daily.play") }],
    },
  ];

  return (
    <section aria-labelledby="solitaire-modes-heading" className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="solitaire-modes-heading"
          className="text-lg font-bold text-[color:var(--text-primary)]"
        >
          {t("solitaireModes.title")}
        </h2>
        {!loaded && (
          <span className="text-xs text-[color:var(--text-muted)]">
            {t("solitaireModes.loading")}
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {cards.map((card) => (
          <Surface key={card.key} tone="panel" padding="sm" className="flex flex-col">
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
              {card.title}
            </p>
            {card.body && (
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--text-secondary)]">
                {card.body}
              </p>
            )}
            {card.rows && (
              <dl className="mt-2 space-y-1 text-sm">
                {card.rows.map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-[color:var(--text-muted)]">{label}</dt>
                    <dd className="font-mono tabular-nums text-[color:var(--text-primary)]">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-3 flex flex-wrap gap-3">
              {card.links.map((link) => (
                <Link key={link.href} href={link.href} className={LINK}>
                  {link.label}
                </Link>
              ))}
            </div>
          </Surface>
        ))}
      </div>

      {loaded && !solo && !daily && (
        <p className="mt-2 text-xs leading-relaxed text-[color:var(--text-muted)]">
          {t("solitaireModes.guest")}
        </p>
      )}
    </section>
  );
}
