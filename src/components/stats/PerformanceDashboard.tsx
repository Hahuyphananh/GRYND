"use client";

// src/components/stats/PerformanceDashboard.tsx
//
// The GRYND PRO performance dashboard (rendered at /stats).
//
// EVERY NUMBER COMES FROM THE SERVER. The component formats and lays out the
// payload from /api/stats/performance; it never recomputes a win rate, never
// derives a rank and never fills a gap with a plausible-looking value. Filters
// are simply part of the request, so the API is the only thing that decides
// what a "win rate for Chess in the last 30 days" is.
//
// A non-member never reaches the charts: the API answers `{ pro: false }` with
// no analytics, and this component renders the upgrade prompt for that shape
// (see ProAnalyticsLocked).
//
// CHARTS ARE LABELLED BY RANKING SYSTEM. Per-game Elo, Overall Elo, trophies
// and Overall Elo RANK are four different metrics, so each chart names its own
// axis and none of them is merged into an invented "overall score".

import { useMemo, useState } from "react";
import Link from "next/link";
import AsyncState from "../states/AsyncState";
import LineChart from "./LineChart";
import ProAnalyticsLocked from "./ProAnalyticsLocked";
import StatTile from "./StatTile";
import { useApiResource } from "../../hooks/useApiResource";
import { useTranslation } from "../../hooks/useTranslation";

const RANGES = [
  { key: "all", days: 0 },
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
  { key: "365d", days: 365 },
] as const;

const PAGE_SIZE = 10;
const MAX_PAGES = 5;

type RangeKey = (typeof RANGES)[number]["key"];

type Payload = {
  pro: boolean;
  locked?: boolean;
  game: string | null;
  games: string[];
  gameLabels?: Record<string, string>;
  summary?: {
    matches: number;
    wins: number;
    losses: number;
    draws: number;
    decided: number;
    winRate: number | null;
    firstAt: string | null;
    lastAt: string | null;
  };
  perGame?: Array<{
    gameKey: string;
    label: string;
    matches: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number | null;
    rating: number | null;
    trophies: number | null;
    lastAt: string | null;
  }>;
  series?: {
    game: string | null;
    rating: Array<{ at: string; value: number }>;
    ratingChange: number | null;
    overallElo: Array<{ at: string; overallElo: number; eligibleGames: number }>;
    overallEloChange: number | null;
    trophy: Array<{ at: string; value: number }>;
    trophyChange: number | null;
    rowsUsed: number;
    capped: boolean;
  };
  recent?: Array<{
    gameKey: string;
    matchId: string;
    outcome: string;
    at: string;
    rating: number | null;
    trophies: number | null;
    ratingDelta: number | null;
    trophyDelta: number | null;
    opponentName: string | null;
  }>;
  recentForm?: {
    outcomes: string[];
    winRate: number | null;
    streak: { outcome: string; length: number } | null;
  };
  rankHistory?: Array<{
    bucket: string;
    overallElo: number | null;
    overallRank: number | null;
    eligibleGames: number;
  }>;
  eligibility?: { provisionalGames: number; overallMinGames: number };
  /** When the server built this payload. */
  generatedAt?: string;
};

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString();
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toFixed(1)}%`;
}

function formatDelta(value: number | null | undefined, suffix = ""): string | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n}${suffix}`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function PerformanceDashboard({
  signedIn,
  pro,
}: {
  signedIn: boolean;
  /** Server-resolved membership — the client never decides this. */
  pro: boolean;
}) {
  const { t } = useTranslation();
  const [game, setGame] = useState<string>("all");
  const [range, setRange] = useState<RangeKey>("all");
  const [pages, setPages] = useState(1);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (game !== "all") params.set("game", game);
    const days = RANGES.find((entry) => entry.key === range)?.days ?? 0;
    if (days > 0) {
      params.set("from", new Date(Date.now() - days * 86_400_000).toISOString());
    }
    params.set("limit", String(PAGE_SIZE * pages));
    return params.toString();
  }, [game, range, pages]);

  const resource = useApiResource<Payload>(
    signedIn && pro ? `/api/stats/performance?${query}` : null,
  );
  const data = resource.data;
  const locked = Boolean(data?.locked) || !pro;

  const labelFor = (key: string) => data?.gameLabels?.[key] ?? key;

  const gameOptions = useMemo(() => {
    const keys = data?.games ?? [];
    return keys.map((key) => ({ key, label: labelFor(key) }));
  }, [data?.games, data?.gameLabels]);

  const rangeLabel = (key: RangeKey) =>
    key === "all" ? t("stats.range.all") : t(`stats.range.${key}`);

  if (!signedIn) {
    return (
      <ProAnalyticsLocked
        signedIn={false}
        provisionalGames={data?.eligibility?.provisionalGames ?? 10}
        overallMinGames={data?.eligibility?.overallMinGames ?? 3}
      />
    );
  }

  if (locked) {
    return (
      <ProAnalyticsLocked
        signedIn
        provisionalGames={data?.eligibility?.provisionalGames ?? 10}
        overallMinGames={data?.eligibility?.overallMinGames ?? 3}
      />
    );
  }

  const summary = data?.summary;
  const perGame = data?.perGame ?? [];
  const series = data?.series;
  const recent = data?.recent ?? [];
  const rankHistory = data?.rankHistory ?? [];
  const form = data?.recentForm;
  const rankPoints = rankHistory
    .filter((point) => point.overallRank !== null)
    .map((point) => ({ at: `${point.bucket}T00:00:00.000Z`, value: point.overallRank as number }));
  const overallEloPoints = (series?.overallElo ?? []).map((point) => ({
    at: point.at,
    value: point.overallElo,
  }));
  const canLoadMore = recent.length >= PAGE_SIZE * pages && pages < MAX_PAGES;

  return (
    <AsyncState
      isLoading={resource.isLoading}
      error={resource.error}
      hasData={resource.hasData}
      onRetry={() => {
        void resource.refresh();
      }}
      cachedAt={resource.cachedAt}
      skeleton={
        <div className="space-y-4" aria-busy="true">
          <div className="h-24 animate-pulse rounded-xl bg-white/5" />
          <div className="h-56 animate-pulse rounded-xl bg-white/5" />
          <div className="h-40 animate-pulse rounded-xl bg-white/5" />
        </div>
      }
    >
      <div className="space-y-6">
        {/* Filters — the server does the filtering; these only choose it. */}
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-[#9dd8ff]/70">
            {t("stats.filters.game")}
            <select
              value={game}
              onChange={(event) => {
                setGame(event.target.value);
                setPages(1);
              }}
              className="rounded-lg border border-[#00e5ff]/30 bg-[#04122b] px-3 py-2 text-sm font-medium text-white focus:border-[#00e5ff] focus:outline-none"
            >
              <option value="all">{t("stats.filters.all_games")}</option>
              {gameOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-[#9dd8ff]/70">
            {t("stats.filters.range")}
            <div className="flex flex-wrap gap-1">
              {RANGES.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => {
                    setRange(entry.key);
                    setPages(1);
                  }}
                  aria-pressed={range === entry.key}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                    range === entry.key
                      ? "border-[#00e5ff] bg-[#00e5ff]/20 text-white"
                      : "border-white/15 text-[#9dd8ff]/80 hover:border-[#00e5ff]/50"
                  }`}
                >
                  {rangeLabel(entry.key)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Totals */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label={t("stats.tile.matches")}
            value={formatNumber(summary?.matches)}
            hint={summary?.lastAt ? t("stats.tile.last_played", { date: shortDate(summary.lastAt) }) : null}
          />
          <StatTile
            label={t("stats.tile.record")}
            value={`${formatNumber(summary?.wins)}–${formatNumber(summary?.losses)}–${formatNumber(summary?.draws)}`}
            hint={t("stats.tile.record_hint")}
          />
          <StatTile
            label={t("stats.tile.win_rate")}
            value={formatRate(summary?.winRate)}
            hint={t("stats.tile.win_rate_hint", { decided: formatNumber(summary?.decided) })}
          />
          <StatTile
            label={t("stats.tile.form")}
            value={formatRate(form?.winRate)}
            hint={
              form?.streak
                ? t("stats.tile.form_streak", {
                    count: form.streak.length,
                    outcome: t(`stats.outcome.${form.streak.outcome}`),
                  })
                : t("stats.tile.form_hint")
            }
            tone={form?.winRate !== null && (form?.winRate ?? 0) >= 50 ? "good" : "default"}
          />
        </div>

        {/* ── Charts: four DIFFERENT metrics, each labelled ────────────── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title={t("stats.chart.rating_title")}
            subtitle={
              series?.game
                ? t("stats.chart.rating_sub", { game: labelFor(series.game) })
                : t("stats.chart.rating_pick")
            }
            change={series?.ratingChange}
            changeSuffix={t("stats.points")}
          >
            {series?.game ? (
              <LineChart
                points={series.rating}
                seriesLabel={t("stats.chart.rating_series", { game: labelFor(series.game) })}
                axisLabel={t("stats.chart.rating_axis")}
                emptyLabel={t("stats.chart.no_points")}
                color="#00e5ff"
              />
            ) : (
              <ChartHint>{t("stats.chart.rating_pick")}</ChartHint>
            )}
          </ChartCard>

          <ChartCard
            title={t("stats.chart.overall_title")}
            subtitle={t("stats.chart.overall_sub")}
            change={series?.overallEloChange}
            changeSuffix={t("stats.points")}
          >
            <LineChart
              points={overallEloPoints}
              seriesLabel={t("stats.chart.overall_series")}
              axisLabel={t("stats.chart.overall_axis")}
              emptyLabel={t("stats.chart.overall_empty", {
                min: data?.eligibility?.overallMinGames ?? 3,
                provisional: data?.eligibility?.provisionalGames ?? 10,
              })}
              color="#f5ff3b"
            />
          </ChartCard>

          <ChartCard
            title={t("stats.chart.trophy_title")}
            subtitle={
              series?.game
                ? t("stats.chart.trophy_sub", { game: labelFor(series.game) })
                : t("stats.chart.trophy_sub_total")
            }
            change={series?.trophyChange}
          >
            <LineChart
              points={series?.trophy ?? []}
              seriesLabel={t("stats.chart.trophy_series")}
              axisLabel={t("stats.chart.trophy_axis")}
              emptyLabel={t("stats.chart.no_points")}
              color="#00ffa6"
            />
          </ChartCard>

          <ChartCard
            title={t("stats.chart.rank_title")}
            subtitle={
              rankPoints.length
                ? t("stats.chart.rank_sub", { date: shortDate(rankHistory[0]?.bucket) })
                : t("stats.chart.rank_empty_sub")
            }
            change={
              rankPoints.length >= 2
                ? rankPoints[rankPoints.length - 1].value - rankPoints[0].value
                : null
            }
            changeInverted
          >
            <LineChart
              points={rankPoints}
              seriesLabel={t("stats.chart.rank_series")}
              axisLabel={t("stats.chart.rank_axis")}
              emptyLabel={t("stats.chart.rank_empty")}
              color="#f0abfc"
              lowerIsBetter
              formatValue={(value) => `#${formatNumber(value)}`}
            />
          </ChartCard>
        </div>

        {series?.capped ? (
          <p className="text-xs text-[#9dd8ff]/60">
            {t("stats.capped", { rows: formatNumber(series.rowsUsed) })}
          </p>
        ) : null}

        {/* ── Per-game breakdown ──────────────────────────────────────── */}
        <section className="rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-[#00e5ff]">
            {t("stats.pergame.title")}
          </h3>
          <p className="mt-1 text-xs text-[#9dd8ff]/70">{t("stats.pergame.note")}</p>

          {perGame.length === 0 ? (
            <p className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-[#9dd8ff]/70">
              {t("stats.pergame.empty")}
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-[#9dd8ff]/70">
                    <th className="py-2 pr-3 font-semibold">{t("stats.pergame.game")}</th>
                    <th className="py-2 pr-3 text-right font-semibold">{t("stats.pergame.matches")}</th>
                    <th className="py-2 pr-3 text-right font-semibold">{t("stats.pergame.record")}</th>
                    <th className="py-2 pr-3 text-right font-semibold">{t("stats.pergame.win_rate")}</th>
                    <th className="py-2 pr-3 text-right font-semibold">{t("stats.pergame.rating")}</th>
                    <th className="py-2 text-right font-semibold">{t("stats.pergame.trophies")}</th>
                  </tr>
                </thead>
                <tbody>
                  {perGame.map((row) => (
                    <tr key={row.gameKey} className="border-t border-white/10">
                      <td className="py-2 pr-3 font-semibold text-white">
                        <button
                          type="button"
                          onClick={() => {
                            setGame(row.gameKey);
                            setPages(1);
                          }}
                          className="text-left underline-offset-2 hover:underline"
                        >
                          {row.label}
                        </button>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-[#d8fbff]">
                        {formatNumber(row.matches)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-[#d8fbff]">
                        {formatNumber(row.wins)}–{formatNumber(row.losses)}–{formatNumber(row.draws)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-[#d8fbff]">
                        {formatRate(row.winRate)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-[#d8fbff]">
                        {formatNumber(row.rating)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[#d8fbff]">
                        {formatNumber(row.trophies)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Recent results ──────────────────────────────────────────── */}
        <section className="rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-[#00e5ff]">
            {t("stats.recent.title")}
          </h3>

          {recent.length === 0 ? (
            <p className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-[#9dd8ff]/70">
              {t("stats.recent.empty")}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {recent.map((entry, index) => {
                const delta = formatDelta(entry.ratingDelta, t("stats.points"));
                const trophyDelta = formatDelta(entry.trophyDelta);
                return (
                  <li
                    key={`${entry.gameKey}-${entry.matchId}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <OutcomeChip
                        outcome={entry.outcome}
                        label={t(`stats.outcome.${entry.outcome}`)}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white">
                          {labelFor(entry.gameKey)}
                          {entry.opponentName ? (
                            <span className="font-normal text-[#9dd8ff]/80">
                              {" "}
                              {t("stats.recent.versus")}{" "}
                              {entry.opponentName}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-[#9dd8ff]/60">{shortDate(entry.at)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs tabular-nums">
                      {delta ? (
                        <span className={entry.ratingDelta && entry.ratingDelta < 0 ? "text-red-300/90" : "text-[#00ffa6]"}>
                          {t("stats.recent.elo", { delta })}
                        </span>
                      ) : null}
                      {trophyDelta ? (
                        <span className="text-[#f5ff3b]">
                          {t("stats.recent.trophies", { delta: trophyDelta })}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {canLoadMore ? (
            <button
              type="button"
              onClick={() => setPages((value) => Math.min(MAX_PAGES, value + 1))}
              className="mt-4 w-full rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/10"
            >
              {t("stats.recent.load_more")}
            </button>
          ) : null}
        </section>

        {/* Honest sourcing notes — no metric is presented without its limits. */}
        <div className="space-y-1 rounded-xl border border-white/10 bg-white/5 p-4 text-xs text-[#9dd8ff]/70">
          <p>{t("stats.notes.sources")}</p>
          <p>{t("stats.notes.unsettled")}</p>
          <p>
            {t("stats.notes.rank_window", {
              date: rankHistory.length ? shortDate(rankHistory[0]?.bucket) : t("stats.notes.today"),
            })}
          </p>
          <p>{t("stats.notes.eligibility", {
            provisional: data?.eligibility?.provisionalGames ?? 10,
            min: data?.eligibility?.overallMinGames ?? 3,
          })}</p>
        </div>

        <p className="text-xs text-[#9dd8ff]/50">
          {t("stats.generated_at", { date: shortDate(data?.generatedAt) })}{" "}
          <Link href="/profil" className="text-[#00e5ff] underline">
            {t("stats.back_to_profile")}
          </Link>
        </p>
      </div>
    </AsyncState>
  );
}

function ChartCard({
  title,
  subtitle,
  change,
  changeSuffix = "",
  changeInverted = false,
  children,
}: {
  title: string;
  subtitle: string;
  change?: number | null;
  changeSuffix?: string;
  /** For RANK charts: a NEGATIVE change is an improvement. */
  changeInverted?: boolean;
  children: React.ReactNode;
}) {
  const delta = formatDelta(change, changeSuffix);
  const improving = change === null || change === undefined ? null : changeInverted ? change < 0 : change > 0;

  return (
    <section className="rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-[#00e5ff]">{title}</h3>
          <p className="mt-0.5 text-xs text-[#9dd8ff]/70">{subtitle}</p>
        </div>
        {delta ? (
          <span
            className={`shrink-0 rounded-full border px-2 py-1 text-xs font-bold tabular-nums ${
              improving
                ? "border-[#00ffa6]/50 bg-[#00ffa6]/10 text-[#00ffa6]"
                : "border-red-400/50 bg-red-500/10 text-red-200"
            }`}
          >
            {delta}
          </span>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ChartHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-white/15 bg-white/5 px-4 py-8 text-center text-sm text-[#9dd8ff]/70">
      {children}
    </p>
  );
}

function OutcomeChip({ outcome, label }: { outcome: string; label: string }) {
  const style =
    outcome === "win"
      ? "border-[#00ffa6]/50 bg-[#00ffa6]/10 text-[#00ffa6]"
      : outcome === "draw"
        ? "border-[#f5ff3b]/50 bg-[#f5ff3b]/10 text-[#f5ff3b]"
        : "border-red-400/50 bg-red-500/10 text-red-200";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${style}`}>
      {label}
    </span>
  );
}

