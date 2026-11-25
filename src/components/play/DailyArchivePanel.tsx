"use client";

// src/components/play/DailyArchivePanel.tsx
//
// THE PRO DAILY ARCHIVE on /daily.
//
// Today's challenge is free and is already on the page. This panel lists the
// past deals; a free caller sees the locked state (with the upgrade path and a
// free "play today" link), a PRO caller sees the 30-day calendar linking each
// day back to the same page with `?date=YYYY-MM-DD`.
//
// The panel never decides access: `/api/solitaire/daily?date=…` re-checks the
// membership server-side, so a crafted URL cannot open an archived seed.

import { useEffect, useState } from "react";
import Link from "next/link";

import { formatDuration } from "../../lib/solitaire-duel/soloStats.js";

type ArchiveDay = {
  dateKey: string;
  completed: boolean;
  moves: number;
  elapsedMs: number;
};

type ArchivePayload = {
  pro: boolean;
  locked: boolean;
  today: string;
  days: ArchiveDay[];
};

function dayLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function DailyArchivePanel({ className = "" }: { className?: string }) {
  const [data, setData] = useState<ArchivePayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/solitaire/daily/archive", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.success) throw new Error("archive unavailable");
        return body.data as ArchivePayload;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      aria-labelledby="daily-archive-heading"
      data-testid="daily-archive"
      className={`mt-10 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6 ${className}`}
    >
      <div className="flex items-center gap-3">
        <h2
          id="daily-archive-heading"
          className="text-lg font-black uppercase tracking-[0.2em] text-white/70"
        >
          Daily archive
        </h2>
        <span className="rounded-full border border-[#FFD700]/40 bg-[#FFD700]/10 px-2 py-0.5 text-[11px] font-black tracking-wider text-[#FFD700]">
          PRO
        </span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">
        Today&apos;s deal stays free for everyone. GRYND PRO members can replay
        any past Daily Challenge deal — the same cards that were dealt that UTC
        day — and keep the result on their archive record.
      </p>

      {!data && !failed && (
        <p className="mt-4 text-sm text-white/45" aria-busy="true">
          Loading the archive…
        </p>
      )}

      {failed && (
        <p className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
          The archive could not be loaded right now.
        </p>
      )}

      {data?.locked && (
        <div
          data-testid="daily-archive-locked"
          className="mt-4 rounded-xl border border-[#FFD700]/30 bg-[#FFD700]/[0.06] p-4"
        >
          <p className="text-sm font-semibold text-[#ffe9a3]">
            Past Daily Challenges are a GRYND PRO feature.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            Today&apos;s deal remains free — no membership needed.
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

      {data?.pro && !data.locked && (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.days.map((day) => (
            <li key={day.dateKey}>
              <Link
                href={`/daily?date=${encodeURIComponent(day.dateKey)}`}
                data-testid={`daily-archive-day-${day.dateKey}`}
                className="block rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 transition hover:border-cyan-300/40 hover:bg-cyan-400/[0.06]"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">
                    {dayLabel(day.dateKey)}
                  </span>
                  <span
                    className={`text-[11px] font-black uppercase tracking-wider ${
                      day.completed ? "text-emerald-300" : "text-white/35"
                    }`}
                  >
                    {day.completed ? "Completed" : "Unplayed"}
                  </span>
                </span>
                <span className="mt-1 flex items-center justify-between gap-2 font-mono text-[11px] text-white/45">
                  <span>{day.dateKey}</span>
                  <span>
                    {day.completed
                      ? `${day.moves} moves · ${formatDuration(day.elapsedMs)}`
                      : "Play deal"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
