"use client";

// Product & retention dashboard UI. Read-only; every number comes from
// /api/admin/analytics/solitaire. A section whose source could not answer is
// rendered as UNAVAILABLE with the reason — never as zero.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Section<T> =
  | { available: true; value: T; limitations: string[] }
  | { available: false; value: null; reason: string; limitations: string[] };

type FunnelStep = {
  key: string;
  label: string;
  users: number | null;
  conversionFromPrevious: number | null;
  dropOff: number | null;
  change: number | null;
  changePercent: number | null;
};

type Snapshot = {
  success: boolean;
  range: { start: string; end: string; days: number };
  previous: { start: string; end: string; days: number };
  generatedAt: string;
  overview: Section<{
    signups: number;
    firstTimePlayers: number | null;
    uniquePlayers: number;
    dau: number;
    wau: number;
    mau: number;
    gamesStarted: number;
    gamesCompleted: number;
    completionRate: number | null;
    rankedMatchesCompleted: number;
    dailyCompleted: number;
  }>;
  funnel: Section<{ steps: FunnelStep[] }>;
  retention: Section<{
    cohortDefinition: string;
    cohort: number;
    day1: number | null;
    day7: number | null;
    day30: number | null;
    day1Rate: number | null;
    day7Rate: number | null;
    day30Rate: number | null;
    returningPlayers: number | null;
    completingPlayers: number | null;
  }>;
  gameplay: Section<
    Array<{
      mode: string;
      starts: number;
      completions: number;
      abandonments: number | null;
      completionRate: number | null;
      averageDurationSeconds: number | null;
      players: number;
      limitations: string[];
    }>
  >;
  matchmaking: Section<{
    queueAttempts: number;
    matchesFound: number;
    cancellations: number;
    successRate: number | null;
    averageWaitSeconds: number | null;
    medianWaitSeconds: number | null;
    p90WaitSeconds: number | null;
    liveHumanMatches: number;
    recordedHumanMatches: number;
    aiMatches: number;
    sampleSize: number;
  }>;
  review: Section<{
    openedUsers: number | null;
    completedUsers: number | null;
    practiceClicks: number | null;
    adoptionRate: number | null;
    practiceExercisesStarted: number | null;
    practiceExercisesCompleted: number | null;
    limitations: string[];
  }>;
  definitions: Record<string, string>;
};

const RANGES = [7, 30, 90] as const;

const n = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "unavailable"
    : Math.round(value).toLocaleString("en-US");

const pct = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "unavailable"
    : `${value.toFixed(1)}%`;

const dur = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return "unavailable";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
};

const delta = (step: FunnelStep): string => {
  if (step.change === null) return "no baseline";
  const sign = step.change > 0 ? "+" : "";
  return `${sign}${step.change.toLocaleString("en-US")}${
    step.changePercent === null ? "" : ` (${sign}${step.changePercent.toFixed(1)}%)`
  }`;
};

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-[#1b2a4a] bg-[#0b1326] p-4">
      <div className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">{label}</div>
      <div className="mt-1 font-mono text-xl text-white">{value}</div>
      {detail ? <div className="mt-1 text-xs text-[#5f7794]">{detail}</div> : null}
    </div>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
      <span className="font-semibold">Unavailable.</span> {reason}
    </div>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 rounded-xl border border-[#1b2a4a] bg-[#0b1326]">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#1b2a4a] px-5 py-3">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {hint ? <span className="text-xs text-[#7f9bbd]">{hint}</span> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export default function ProductDashboardClient() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (range: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/analytics/solitaire?days=${range}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Snapshot | null;
      if (!res.ok || !body?.success) {
        setError((body as unknown as { error?: string } | null)?.error ?? `Request failed (HTTP ${res.status})`);
        return;
      }
      setSnapshot(body);
    } catch {
      setError("Could not reach the analytics endpoint.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const overview = snapshot?.overview;
  const funnel = snapshot?.funnel;
  const retention = snapshot?.retention;
  const gameplay = snapshot?.gameplay;
  const matchmaking = snapshot?.matchmaking;
  const review = snapshot?.review;

  const overallConversion =
    funnel?.available && funnel.value.steps.length
      ? (() => {
          const first = funnel.value.steps[0].users;
          const last = funnel.value.steps[funnel.value.steps.length - 1].users;
          return first && last !== null ? Math.min(100, (last / first) * 100) : null;
        })()
      : null;

  return (
    <div className="min-h-dvh bg-[#030817] px-4 py-8 text-[#c9f7ff] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Solitaire product metrics</h1>
            <p className="mt-1 max-w-3xl text-sm text-[#7f9bbd]">
              Activation, retention, gameplay, matchmaking and Game Review. Users, sessions, games and
              matches are separate units and are never added together.
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            <Link href="/admin/analytics" className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 hover:border-[#f5ff3b]">
              Event volumes
            </Link>
            <Link href="/admin" className="rounded-lg border border-[#1b2a4a] px-3 py-1.5 hover:border-[#f5ff3b]">
              Admin dashboard
            </Link>
          </nav>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setDays(option)}
              aria-pressed={days === option}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                days === option
                  ? "border-[#f5ff3b] bg-[#f5ff3b]/10 text-[#f5ff3b]"
                  : "border-[#1b2a4a] text-[#a9c4dd] hover:border-[#f5ff3b]"
              }`}
            >
              Last {option} days
            </button>
          ))}
          {snapshot ? (
            <span className="ml-auto text-xs text-[#5f7794]">
              {snapshot.range.start.slice(0, 10)} → {snapshot.range.end.slice(0, 10)} UTC · generated{" "}
              {snapshot.generatedAt.slice(11, 19)} UTC
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            <p className="font-semibold">Could not load metrics</p>
            <p className="mt-1 text-red-200/80">{error}</p>
          </div>
        ) : null}

        {loading && !snapshot ? (
          <p className="text-sm text-[#7f9bbd]">Loading…</p>
        ) : null}

        {overview ? (
          <section className="mt-2">
            <h2 className="mb-2 text-sm font-semibold text-white">Overview</h2>
            {overview.available ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Kpi label="Unique players" value={n(overview.value.uniquePlayers)} detail="any mode, in window" />
                  <Kpi label="DAU" value={n(overview.value.dau)} detail="last 24h before window end" />
                  <Kpi label="WAU" value={n(overview.value.wau)} detail="last 7 days" />
                  <Kpi label="MAU" value={n(overview.value.mau)} detail="last 30 days" />
                  <Kpi label="New signups" value={n(overview.value.signups)} detail="accounts created" />
                  <Kpi
                    label="First-time players"
                    value={n(overview.value.firstTimePlayers)}
                    detail="first recorded game activity"
                  />
                  <Kpi label="Games started" value={n(overview.value.gamesStarted)} detail="solo + daily + duels" />
                  <Kpi
                    label="Games completed"
                    value={n(overview.value.gamesCompleted)}
                    detail={`completion rate ${pct(overview.value.completionRate)}`}
                  />
                  <Kpi
                    label="Ranked matches completed"
                    value={n(overview.value.rankedMatchesCompleted)}
                    detail="human vs human, settled"
                  />
                  <Kpi
                    label="Daily Challenges completed"
                    value={n(overview.value.dailyCompleted)}
                    detail="verified board solves"
                  />
                </div>
                {overview.limitations.length ? (
                  <ul className="mt-3 space-y-1 text-xs text-[#5f7794]">
                    {overview.limitations.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <Unavailable reason={"reason" in overview ? overview.reason : "Unavailable"} />
            )}
          </section>
        ) : null}

        {funnel ? (
          <Card title="Activation funnel" hint="unique users, ordered · PostHog · consenting visitors only">
            {funnel.available ? (
              <>
                <div className="mb-3 flex flex-wrap gap-6 text-sm">
                  <span className="text-[#a9c4dd]">
                    Visitor → ranked completion:{" "}
                    <span className="font-mono text-white">{pct(overallConversion)}</span>
                  </span>
                  <span className="text-[#5f7794]">change vs previous {snapshot?.range.days} days</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">
                      <tr>
                        <th className="py-2 font-medium">Stage</th>
                        <th className="py-2 text-right font-medium">Users</th>
                        <th className="py-2 text-right font-medium">From previous</th>
                        <th className="py-2 text-right font-medium">Drop-off</th>
                        <th className="py-2 text-right font-medium">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funnel.value.steps.map((step) => (
                        <tr key={step.key} className="border-t border-[#16233d]">
                          <td className="py-2 text-[#c9f7ff]">{step.label}</td>
                          <td className="py-2 text-right font-mono text-white">{n(step.users)}</td>
                          <td className="py-2 text-right font-mono text-[#a9c4dd]">
                            {pct(step.conversionFromPrevious)}
                          </td>
                          <td className="py-2 text-right font-mono text-[#a9c4dd]">{pct(step.dropOff)}</td>
                          <td className="py-2 text-right font-mono text-[#5f7794]">{delta(step)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <Unavailable reason={"reason" in funnel ? funnel.reason : "Unavailable"} />
            )}
          </Card>
        ) : null}

        {retention ? (
          <Card title="Retention" hint="cohort: first signup in window · UTC days">
            {retention.available ? (
              <>
                <p className="mb-3 max-w-3xl text-xs text-[#7f9bbd]">{retention.value.cohortDefinition}</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Kpi label="Cohort" value={n(retention.value.cohort)} detail="new signups" />
                  <Kpi label="Day 1" value={pct(retention.value.day1Rate)} detail={`${n(retention.value.day1)} users active`} />
                  <Kpi label="Day 7" value={pct(retention.value.day7Rate)} detail={`${n(retention.value.day7)} users active`} />
                  <Kpi label="Day 30" value={pct(retention.value.day30Rate)} detail={`${n(retention.value.day30)} users active`} />
                </div>
                <div className="mt-3 grid gap-2 text-xs text-[#a9c4dd] sm:grid-cols-2">
                  <p>Players who completed ≥1 game in window: <span className="font-mono text-white">{n(retention.value.completingPlayers)}</span></p>
                  <p>
                    Returning players:{" "}
                    <span className="font-mono text-[#7f9bbd]">
                      unavailable — needs a per-player history this endpoint does not scan
                    </span>
                  </p>
                </div>
                <p className="mt-3 text-xs text-[#5f7794]">
                  Retention uses activity events, never pageviews alone. A user who declined analytics
                  is absent from the cohort, so rates are a floor, not a full-population figure.
                </p>
              </>
            ) : (
              <Unavailable reason={"reason" in retention ? retention.reason : "Unavailable"} />
            )}
          </Card>
        ) : null}

        {gameplay ? (
          <Card title="Gameplay by mode" hint="AI practice and human ranked are separate rows">
            {gameplay.available ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[11px] uppercase tracking-wider text-[#7f9bbd]">
                    <tr>
                      <th className="py-2 font-medium">Mode</th>
                      <th className="py-2 text-right font-medium">Starts</th>
                      <th className="py-2 text-right font-medium">Completions</th>
                      <th className="py-2 text-right font-medium">Abandonments</th>
                      <th className="py-2 text-right font-medium">Completion</th>
                      <th className="py-2 text-right font-medium">Avg duration</th>
                      <th className="py-2 text-right font-medium">Players</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gameplay.value.map((row) => (
                      <tr key={row.mode} className="border-t border-[#16233d] align-top">
                        <td className="py-2 capitalize text-[#c9f7ff]">{row.mode}</td>
                        <td className="py-2 text-right font-mono text-white">{n(row.starts)}</td>
                        <td className="py-2 text-right font-mono text-white">{n(row.completions)}</td>
                        <td className="py-2 text-right font-mono text-[#a9c4dd]">{n(row.abandonments)}</td>
                        <td className="py-2 text-right font-mono text-[#a9c4dd]">{pct(row.completionRate)}</td>
                        <td className="py-2 text-right font-mono text-[#a9c4dd]">{dur(row.averageDurationSeconds)}</td>
                        <td className="py-2 text-right font-mono text-[#a9c4dd]">{n(row.players)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="mt-3 space-y-1 text-[11px] text-[#5f7794]">
                  {gameplay.value.flatMap((row) =>
                    row.limitations.map((item) => <li key={`${row.mode}-${item}`}>• {row.mode}: {item}</li>),
                  )}
                </ul>
              </div>
            ) : (
              <Unavailable reason={"reason" in gameplay ? gameplay.reason : "Unavailable"} />
            )}
          </Card>
        ) : null}

        {matchmaking ? (
          <Card title="Matchmaking" hint="human queue only · recorded opponents are not live humans">
            {matchmaking.available ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Kpi label="Queue attempts" value={n(matchmaking.value.queueAttempts)} detail="non-AI match rows" />
                  <Kpi label="Matches found" value={n(matchmaking.value.matchesFound)} detail="second seat acquired" />
                  <Kpi label="Success rate" value={pct(matchmaking.value.successRate)} detail="found / attempts" />
                  <Kpi label="Cancellations" value={n(matchmaking.value.cancellations)} detail="status cancelled" />
                  <Kpi label="Average wait" value={dur(matchmaking.value.averageWaitSeconds)} detail={`n=${n(matchmaking.value.sampleSize)}`} />
                  <Kpi label="Median wait" value={dur(matchmaking.value.medianWaitSeconds)} detail="p50" />
                  <Kpi label="90th percentile" value={dur(matchmaking.value.p90WaitSeconds)} detail="p90" />
                  <Kpi label="Live now" value={n(matchmaking.value.liveHumanMatches)} detail="human vs human, playing" />
                  <Kpi label="Recorded-human" value={n(matchmaking.value.recordedHumanMatches)} detail="ghost replays, not live" />
                  <Kpi label="AI practice" value={n(matchmaking.value.aiMatches)} detail="unrated" />
                </div>
                {matchmaking.value.sampleSize === 0 ? (
                  <p className="mt-3 text-xs text-amber-200">
                    Wait times are unavailable: no non-AI match in this window has both a start and a
                    creation timestamp.
                  </p>
                ) : null}
              </>
            ) : (
              <Unavailable reason={"reason" in matchmaking ? matchmaking.reason : "Unavailable"} />
            )}
          </Card>
        ) : null}

        {review ? (
          <Card title="Game Review" hint="correlational — this does not show that reviews improve retention">
            {review.available ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Kpi label="Reviews opened" value={n(review.value.openedUsers)} detail="unique users" />
                  <Kpi label="Reviews completed" value={n(review.value.completedUsers)} detail="unique users" />
                  <Kpi label="Adoption" value={pct(review.value.adoptionRate)} detail="review users / completed games, capped" />
                  <Kpi label="Practice clicks" value={n(review.value.practiceClicks)} detail="recommendation clicks" />
                  <Kpi label="Practice started" value={n(review.value.practiceExercisesStarted)} detail="drill starts" />
                  <Kpi label="Practice completed" value={n(review.value.practiceExercisesCompleted)} detail="drill completions" />
                </div>
                <ul className="mt-3 space-y-1 text-[11px] text-[#5f7794]">
                  {review.value.limitations.map((item) => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>
              </>
            ) : (
              <Unavailable reason={"reason" in review ? review.reason : "Unavailable"} />
            )}
          </Card>
        ) : null}

        {snapshot ? (
          <details className="mt-6 rounded-xl border border-[#1b2a4a] bg-[#0b1326] p-5 text-xs text-[#7f9bbd]">
            <summary className="cursor-pointer text-sm font-semibold text-white">Metric definitions</summary>
            <dl className="mt-3 space-y-2">
              {Object.entries(snapshot.definitions).map(([key, value]) => (
                <div key={key}>
                  <dt className="font-mono text-[#00e5ff]">{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}

        <p className="mt-6 text-xs text-[#5f7794]">
          Empty windows are shown as 0 or unavailable, never filled with sample data. Every window is
          UTC and half-open: [start, end).
        </p>
      </div>
    </div>
  );
}
