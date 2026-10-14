"use client";

// src/components/stats/ProAnalyticsLocked.tsx
//
// What a FREE player sees on /stats.
//
// It matters that this is a component and not "the dashboard with the numbers
// hidden": the API returns no analytics at all to a non-member (see
// /api/stats/performance), so there is nothing here to leak — the prompt is
// rendered from the locked response, and the shapes below are illustrative
// frames, not real figures.
//
// The copy is honest about what PRO adds: the dashboard is an EXTENSION of the
// free profile statistics, which keep working exactly as before.

import Link from "next/link";
import { useTranslation } from "../../hooks/useTranslation";

const FRAME = "rounded-xl border border-dashed border-[#00e5ff]/20 bg-[#04122b]/40";

export default function ProAnalyticsLocked({
  provisionalGames,
  overallMinGames,
  signedIn,
}: {
  provisionalGames: number;
  overallMinGames: number;
  signedIn: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#f5ff3b]/40 bg-gradient-to-b from-[#0a214d]/90 to-[#04122b]/90 p-6 shadow-[0_0_28px_rgba(245,255,59,0.12)]">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#00e5ff]">
          GRYND PRO
        </p>
        <h2 className="mt-1 text-2xl font-black text-[#f5ff3b]">
          {t("stats.locked.title")}
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-[#d8fbff]/85">
          {t("stats.locked.body")}
        </p>

        <ul className="mt-4 grid gap-2 text-sm text-[#d8fbff] sm:grid-cols-2">
          {[
            t("stats.locked.point_record"),
            t("stats.locked.point_pergame"),
            t("stats.locked.point_elo"),
            t("stats.locked.point_rank"),
          ].map((line) => (
            <li key={line} className="flex items-start gap-2">
              <span aria-hidden className="text-[#00ffa6]">
                ✓
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {signedIn ? (
            <Link
              href="/upgrade-pro"
              className="rounded-xl bg-[#f5ff3b] px-5 py-2.5 font-bold text-[#04122b] transition hover:bg-yellow-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] focus-visible:ring-offset-2 focus-visible:ring-offset-[#04122b]"
            >
              {t("stats.locked.cta")}
            </Link>
          ) : (
            <Link
              href="/sign-in"
              className="rounded-xl bg-[#00e5ff] px-5 py-2.5 font-bold text-[#04122b] transition hover:bg-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#04122b]"
            >
              {t("stats.locked.signin")}
            </Link>
          )}
          <span className="text-xs text-[#9dd8ff]/70">
            {t("stats.locked.free_note")}
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={`${FRAME} h-24 p-4`}>
            <div className="h-3 w-20 rounded bg-white/10" />
            <div className="mt-3 h-6 w-16 rounded bg-white/5" />
          </div>
        ))}
      </div>

      <div className={`${FRAME} p-6`} aria-hidden>
        <div className="h-3 w-40 rounded bg-white/10" />
        <div className="mt-4 h-40 rounded bg-gradient-to-r from-transparent via-white/5 to-transparent" />
      </div>

      <p className="text-xs text-[#9dd8ff]/60">
        {t("stats.locked.eligibility", {
          provisional: provisionalGames,
          min: overallMinGames,
        })}
      </p>
    </div>
  );
}
