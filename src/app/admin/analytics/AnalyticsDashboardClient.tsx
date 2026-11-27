"use client";

// The dashboard itself. It only ever talks to /api/admin/analytics — the
// PostHog personal API key never leaves the server.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Snapshot = {
  success: boolean;
  configured: boolean;
  range: number;
  generatedAt: string;
  totals: Record<string, number>;
  series: Array<{ day: string; event: string; total: number }>;
  modes: Array<{ mode: string | null; total: number }>;
  events: string[];
  error?: string;
};

const RANGES = [7, 30, 90] as const;

const LABELS: Record<string, string> = {
  landing_page_viewed: "Landing page viewed",
  signup_completed: "Signup completed",
  onboarding_started: "Onboarding started",
  onboarding_step_completed: "Onboarding step completed",
  onboarding_completed: "Onboarding completed",
  onboarding_skipped: "Onboarding skipped",
  first_game_started: "First game started",
  first_game_completed: "First game completed",
  solitaire_game_started: "Game started",
  solitaire_game_completed: "Game completed",
  solitaire_game_abandoned: "Game abandoned",
  solitaire_game_restarted: "Game restarted",
  ranked_queue_started: "Ranked queue started",
  ranked_queue_cancelled: "Ranked queue cancelled",
  ranked_match_found: "Ranked match found",
  ranked_match_started: "Ranked match started",
  ranked_match_completed: "Ranked match completed",
  ranked_match_forfeited: "Ranked match forfeited",
  daily_challenge_started: "Daily challenge started",
  daily_challenge_completed: "Daily challenge completed",
  solitaire_review_opened: "Review opened",
  solitaire_review_completed: "Review completed",
  review_practice_clicked: "Review practice clicked",
  practice_drill_started: "Practice drill started",
  practice_drill_completed: "Practice drill completed",
  leaderboard_viewed: "Leaderboard viewed",
  profile_viewed: "Profile viewed",
  academy_lesson_started: "Academy lesson started",
  academy_lesson_completed: "Academy lesson completed",
};

const GROUP_OF: Record<string, string> = {
  landing_page_viewed: "Acquisition & onboarding",
  signup_completed: "Acquisition & onboarding",
  onboarding_started: "Acquisition & onboarding",
  onboarding_step_completed: "Acquisition & onboarding",
  onboarding_completed: "Acquisition & onboarding",
  onboarding_skipped: "Acquisition & onboarding",
  first_game_started: "Acquisition & onboarding",
  first_game_completed: "Acquisition & onboarding",
  solitaire_game_started: "Gameplay",
  solitaire_game_completed: "Gameplay",
  solitaire_game_abandoned: "Gameplay",
  solitaire_game_restarted: "Gameplay",
  ranked_queue_started: "Competitive",
  ranked_queue_cancelled: "Competitive",
  ranked_match_found: "Competitive",
  ranked_match_started: "Competitive",
  ranked_match_completed: "Competitive",
  ranked_match_forfeited: "Competitive",
  daily_challenge_started: "Daily",
  daily_challenge_completed: "Daily",
  solitaire_review_opened: "Review",
  solitaire_review_completed: "Review",
  review_practice_clicked: "Review",
  practice_drill_started: "Review",
  practice_drill_completed: "Review",
  leaderboard_viewed: "Engagement",
  profile_viewed: "Engagement",
  academy_lesson_started: "Engagement",
  academy_lesson_completed: "Engagement",
};

const number = (value: number): string => value.toLocaleString("en-US");

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-[#1b2a4a] bg-[#0b1326] p-4">
      <div className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">{label}</div>
      <div className="mt-1 font-mono text-2xl text-white">{value}</div>
      <div className="mt-1 text-xs text-[#5f7794]">{detail}</div>
    </div>
  );
}

export default function AnalyticsDashboardClient() {
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/analytics?days=${days}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Snapshot | null;
      if (!res.ok || !body?.success) {
        setError(body?.error || `Request failed (HTTP ${res.status})`);
        return;
      }
      setSnapshot(body);
      if (body.error) setError(body.error);
    } catch {
      setError("Could not reach the analytics endpoint.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  const { totals, events, maxTotal, days, maxDay } = useMemo(() => {
    const totals = snapshot?.totals ?? {};
    const events = snapshot?.events ?? [];
    const maxTotal = Math.max(1, ...Object.values(totals));
    const byDay = new Map<string, number>();
    for (const point of snapshot?.series ?? []) {
      byDay.set(point.day, (byDay.get(point.day) ?? 0) + point.total);
    }
    const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
    const maxDay = Math.max(1, ...days.map(([, total]) => total));
    return { totals, events, maxTotal, days, maxDay };
  }, [snapshot]);

  const totalEvents = Object.values(totals).reduce((sum, value) => sum + value, 0);
  const grouped = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const event of events) {
      const group = GROUP_OF[event] ?? "Other";
      groups.set(group, [...(groups.get(group) ?? []), event]);
    }
    return [...groups.entries()];
  }, [events]);

  return (
    <div className="min-h-dvh bg-[#030817] px-4 py-8 text-[#c9f7ff] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Solitaire analytics</h1>
            <p className="mt-1 max-w-2xl text-sm text-[#7f9bbd]">
              Event volumes from PostHog for the Solitaire taxonomy. Read-only — no event can be
              created or edited here. Counts include bot traffic and are not deduplicated beyond what
              the emitters already guarantee.
            </p>
          </div>
          <nav className="flex gap-2 text-sm">
            <Link
              href="/admin"
              className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 text-[#c9f7ff] hover:border-[#f5ff3b]"
            >
              Admin dashboard
            </Link>
            <Link
              href="/admin/analytics/solitaire"
              className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 text-[#c9f7ff] hover:border-[#f5ff3b]"
            >
              Product metrics
            </Link>
            <Link
              href="/admin/operations"
              className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 text-[#c9f7ff] hover:border-[#f5ff3b]"
            >
              Operations
            </Link>
          </nav>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              aria-pressed={range === option}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                range === option
                  ? "border-[#f5ff3b] bg-[#f5ff3b]/10 text-[#f5ff3b]"
                  : "border-[#1b2a4a] text-[#a9c4dd] hover:border-[#f5ff3b]"
              }`}
            >
              Last {option} days
            </button>
          ))}
          {snapshot && (
            <span className="ml-auto text-xs text-[#5f7794]">
              queried {new Date(snapshot.generatedAt).toISOString().slice(0, 19).replace("T", " ")} UTC
            </span>
          )}
        </div>

        {snapshot && !snapshot.configured && (
          <div className="mb-5 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm text-amber-100">
            <p className="font-semibold">PostHog Query API is not configured.</p>
            <p className="mt-1 text-amber-100/80">
              Set <code className="font-mono">POSTHOG_PERSONAL_API_KEY</code> (a personal key with
              project read access) and <code className="font-mono">POSTHOG_PROJECT_ID</code> on the
              server. The key is never sent to the browser. Event capture itself uses
              <code className="ml-1 font-mono">NEXT_PUBLIC_POSTHOG_KEY</code> and is unaffected.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-5 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            <p className="font-semibold">Analytics query problem</p>
            <p className="mt-1 text-red-200/80">{error}</p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Events in range"
            value={number(totalEvents)}
            detail={`${events.length} event names tracked`}
          />
          <Kpi
            label="Games started"
            value={number(totals.solitaire_game_started ?? 0)}
            detail="solo + daily + AI + ranked starts"
          />
          <Kpi
            label="Games completed"
            value={number(totals.solitaire_game_completed ?? 0)}
            detail={`${number(totals.solitaire_game_abandoned ?? 0)} abandoned`}
          />
          <Kpi
            label="Ranked settled"
            value={number(totals.ranked_match_completed ?? 0)}
            detail={`${number(totals.ranked_match_forfeited ?? 0)} forfeits · server-confirmed`}
          />
        </div>

        <section className="mt-6 rounded-xl border border-[#1b2a4a] bg-[#0b1326]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1b2a4a] px-5 py-3">
            <h2 className="text-sm font-semibold text-white">Daily volume</h2>
            <span className="text-xs text-[#7f9bbd]">all taxonomy events, UTC days</span>
          </div>
          <div className="px-5 py-4">
            {loading && !snapshot ? (
              <p className="text-sm text-[#7f9bbd]">Loading…</p>
            ) : days.length === 0 ? (
              <p className="text-sm text-[#7f9bbd]">
                No events in this window. If the app is emitting, check that the project id/key
                point at the project the events are sent to.
              </p>
            ) : (
              <div className="flex h-32 items-end gap-1" role="img" aria-label="Daily event volume">
                {days.map(([day, total]) => (
                  <div
                    key={day}
                    className="flex-1 rounded-t bg-[#00e5ff]/60 hover:bg-[#f5ff3b]"
                    style={{ height: `${Math.max(3, (total / maxDay) * 100)}%` }}
                    title={`${day}: ${number(total)} events`}
                  />
                ))}
              </div>
            )}
            {days.length > 0 && (
              <div className="mt-2 flex justify-between text-[11px] text-[#5f7794]">
                <span>{days[0]?.[0]}</span>
                <span>{days[days.length - 1]?.[0]}</span>
              </div>
            )}
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-[#1b2a4a] bg-[#0b1326]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1b2a4a] px-5 py-3">
            <h2 className="text-sm font-semibold text-white">Taxonomy</h2>
            <span className="text-xs text-[#7f9bbd]">
              counts for the last {range} days · bar is relative to the busiest event
            </span>
          </div>

          {grouped.map(([group, groupEvents]) => (
            <div key={group} className="border-b border-[#16233d] last:border-b-0">
              <div className="px-5 pt-3 text-[11px] uppercase tracking-wider text-[#7f9bbd]">
                {group}
              </div>
              <ul className="px-5 py-2">
                {groupEvents.map((event) => {
                  const value = totals[event] ?? 0;
                  return (
                    <li key={event} className="flex items-center gap-3 py-1.5">
                      <span className="w-56 shrink-0 truncate text-xs text-[#a9c4dd]" title={event}>
                        {LABELS[event] ?? event}
                      </span>
                      <span className="hidden flex-1 sm:block">
                        <span
                          className="block h-2 rounded-full bg-[#00e5ff]/50"
                          style={{ width: `${(value / maxTotal) * 100}%`, minWidth: value ? 4 : 0 }}
                        />
                      </span>
                      <span className="w-20 text-right font-mono text-xs text-white">
                        {number(value)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>

        {snapshot?.modes?.length ? (
          <section className="mt-4 rounded-xl border border-[#1b2a4a] bg-[#0b1326] p-5">
            <h2 className="text-sm font-semibold text-white">By mode</h2>
            <p className="mt-1 text-xs text-[#7f9bbd]">
              Only events that carry <code className="font-mono">mode</code> contribute; page views do
              not.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {snapshot.modes.map((row) => (
                <span
                  key={row.mode ?? "unset"}
                  className="rounded-full border border-[#1b2a4a] px-3 py-1 text-xs text-[#a9c4dd]"
                >
                  {row.mode ?? "unset"}{" "}
                  <span className="font-mono text-white">{number(row.total)}</span>
                </span>
              ))}
            </div>
          </section>
        ) : null}

        <p className="mt-6 text-xs text-[#5f7794]">
          Counts are PostHog&apos;s. A missing event means no emitter fired, or the visitor had not
          accepted analytics cookies — both are expected states, not errors.
        </p>
      </div>
    </div>
  );
}
