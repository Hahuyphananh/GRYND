"use client";

// src/components/home/PlayerDashboard.tsx
//
// THE SIGNED-IN HOME DASHBOARD.
//
// Four blocks, in the order a player asks the questions:
//
//   1. Overview      — level, trophy progress to the next level, rank badge,
//                      daily streak, ranked standing and fastest solve. Every
//                      number is the server payload from
//                      `/api/home/dashboard`; nothing is recomputed here except
//                      formatting, and the progress percentage is the one the
//                      server's `getPlayerProgression` returned.
//   2. Next action   — the deterministic recommendation and its reason. When
//                      the device-local practice record shows a weak skill, a
//                      targeted drill replaces the generic ladder step; the
//                      record is read from localStorage and never sent to the
//                      server, so no extra request is made.
//   3. Recent        — ranked, Solo and Daily results merged newest-first, each
//                      linking to its review when one exists. Practice rows are
//                      always labelled unrated.
//   4. The public leaderboard preview is rendered by the page below this panel,
//      so its report controls stay in one place.
//
// Guest and failure states are real states, not empty cards: a signed-out
// visitor gets a starting path that works without an account, a new account
// gets the Academy recommendation, and a failed read gets an explanation plus a
// retry while the rest of the page stays usable.

import Link from "next/link";

import PlayerLevelBadge from "../player-level/PlayerLevelBadge";
import { Button, StatTile, Surface } from "../ui";
import { rankForRankKey } from "../../lib/playerLevel.js";
import { formatDuration } from "../../lib/solitaire-duel/soloStats.js";
import { weakestPracticeFocus } from "../../lib/solitaire-duel/practiceFocus";
import { mergePracticeFocus } from "../../lib/home/dashboard.js";
import { usePracticeProgress } from "../../hooks/usePracticeProgress";
import { useTranslation } from "../../hooks/useTranslation";

type Level = {
  level: number;
  rankKey: string;
  complete: boolean;
  progressPercent: number;
  trophiesToNext: number;
  nextLevelTrophies: number | null;
  progressTrophies: number;
  currentTrophies: number;
  peakTrophies: number;
  protected?: boolean;
};

type Overview = {
  playerLevel: Level;
  trophies: { total: number; peak: number };
  ranked: {
    rating: number;
    peakRating: number;
    gamesRated: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
    provisional: boolean;
    provisionalGamesRemaining: number;
  } | null;
  lastRankedChange: {
    ratingDelta: number;
    trophyDelta: number;
    at: number | null;
  } | null;
  streak: {
    current: number;
    best: number;
    creditedToday: boolean;
    nextMilestone: { day: number; items: string[] } | null;
  } | null;
  solo: {
    games: number;
    completed: number;
    completionRate: number | null;
    bestMs: number | null;
    averageMs: number | null;
    totalMoves: number;
  } | null;
  daily: {
    completed: number;
    currentStreak: number;
    longestStreak: number;
    bestMs: number | null;
    dateKey: string;
    today: { completed: boolean; moves: number; elapsedMs: number | null } | null;
  } | null;
  fastestSolveMs: number | null;
};

type ActivityEntry = {
  key: string;
  kind: "ranked" | "solo" | "daily";
  at: number;
  outcome: string | null;
  status?: string | null;
  competitive: boolean;
  isPractice: boolean;
  reviewable: boolean;
  moves: number | null;
  elapsedMs: number | null;
  dateKey: string | null;
  href: string;
  actionLabel: string;
};

type Recommendation = {
  id: string;
  title: string;
  body: string;
  ctaLabel: string;
  href: string;
  reason: string;
};

export type DashboardPayload = {
  partial?: boolean;
  generatedAt?: number;
  overview: Overview;
  recent: ActivityEntry[];
  recommendation: Recommendation;
};

export type PlayerDashboardProps = {
  isLoaded: boolean;
  isSignedIn: boolean;
  dashboard: DashboardPayload | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
};

const OUTCOME_LABEL: Record<string, string> = {
  win: "Win",
  loss: "Loss",
  draw: "Draw",
  completed: "Completed",
};

function formatDay(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// The Daily Challenge's day is fixed in UTC by the server; showing it in the
// viewer's timezone could name the wrong day.
function formatDealDay(dateKey: string | null, fallbackMs: number): string {
  if (!dateKey) return formatDay(fallbackMs);
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return formatDay(fallbackMs);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function number(value: number | null | undefined): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

function signed(value: number): string {
  const n = Number(value) || 0;
  return n > 0 ? `+${n.toLocaleString("en-US")}` : n.toLocaleString("en-US");
}

function outcomeTone(outcome: string | null): string {
  if (outcome === "win") return "text-[color:var(--state-win)]";
  if (outcome === "loss") return "text-[color:var(--state-loss)]";
  if (outcome === "draw") return "text-[color:var(--state-gold)]";
  if (outcome === "completed") return "text-[color:var(--state-win)]";
  return "text-[color:var(--text-muted)]";
}

function entryTitle(entry: ActivityEntry): string {
  if (entry.kind === "solo") return "Solo Solitaire";
  if (entry.kind === "daily") return "Daily Challenge";
  return entry.isPractice ? "Practice vs AI" : "Ranked match";
}

function entryMeta(entry: ActivityEntry): string {
  const parts: string[] = [];
  if (entry.kind === "ranked") {
    parts.push(entry.isPractice ? "Practice · unrated" : "Ranked");
  }
  if (entry.outcome) parts.push(OUTCOME_LABEL[entry.outcome] ?? entry.outcome);
  else if (entry.status === "cancelled") parts.push("Cancelled");
  else if (entry.status === "waiting") parts.push("Waiting");
  else parts.push("In progress");

  if (entry.elapsedMs) parts.push(formatDuration(entry.elapsedMs));
  if (entry.moves) parts.push(`${entry.moves} ${entry.moves === 1 ? "move" : "moves"}`);

  const day =
    entry.kind === "daily" ? formatDealDay(entry.dateKey, entry.at) : formatDay(entry.at);
  if (day) parts.push(day);
  return parts.join(" · ");
}

function DashboardSkeleton() {
  return (
    <div className="mt-4 space-y-4" aria-busy="true">
      <div className="h-44 animate-pulse rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)]" />
      <div className="space-y-4">
        <div className="h-36 animate-pulse rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)]" />
        <div className="h-56 animate-pulse rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)]" />
      </div>
    </div>
  );
}

function GuestPanel() {
  return (
    <Surface className="mt-4">
      <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[color:var(--accent-strong)]">
        Start here
      </p>
      <h3 className="mt-2 text-xl font-black text-[color:var(--text-primary)]">
        Play a deal now, keep a record when you&apos;re ready
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[color:var(--text-secondary)]">
        Solo and today&apos;s Daily Challenge are open to everyone. An account
        adds the free ranked ladder, Elo, trophies and saved game reviews.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button href="/solitaire">Play solo</Button>
        <Button href="/daily" variant="secondary">
          Today&apos;s challenge
        </Button>
        <Button href="/sign-up" variant="secondary">
          Create account
        </Button>
        <Button href="/sign-in" variant="ghost">
          Sign in
        </Button>
      </div>
    </Surface>
  );
}

function DashboardError({ onRetry }: { onRetry: () => void }) {
  return (
    <Surface className="mt-4" tone="warning">
      <p className="text-sm font-bold text-[color:var(--text-primary)]">
        We couldn&apos;t load your dashboard
      </p>
      <p className="mt-1 text-sm leading-relaxed text-[color:var(--text-secondary)]">
        Your progress is safe. The read failed, so nothing is being shown rather
        than a number we can&apos;t verify. You can still play a deal below.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button href="/play/ranked" variant="secondary">
          Play ranked
        </Button>
      </div>
    </Surface>
  );
}

export default function PlayerDashboard({
  isLoaded,
  isSignedIn,
  dashboard,
  loading,
  error,
  onRetry,
}: PlayerDashboardProps) {
  const { t } = useTranslation();
  // Device-local practice record: a weak spot can turn the generic ladder
  // suggestion into one drill. Reading localStorage is not a request, and the
  // record itself never reaches the server.
  const { progress: practiceProgress, isProgressLoaded } = usePracticeProgress();
  const practiceFocus =
    isSignedIn && isProgressLoaded
      ? weakestPracticeFocus(practiceProgress)
      : null;

  if (!isLoaded) return <DashboardSkeleton />;
  if (!isSignedIn) return <GuestPanel />;
  if (loading && !dashboard) return <DashboardSkeleton />;
  if (!dashboard) return <DashboardError onRetry={onRetry} />;

  const { overview, recent } = dashboard;
  // One recommendation: a recorded practice weakness replaces a generic ladder
  // or review step, while onboarding and daily-habit steps keep priority.
  const recommendation = mergePracticeFocus(
    dashboard.recommendation,
    practiceFocus,
  );
  const level = overview.playerLevel;
  const tier = rankForRankKey(level.rankKey);
  const rankName = t(`playerLevel.ranks.${tier.key}`);
  const percent = Math.max(0, Math.min(100, Number(level.progressPercent) || 0));
  const nextLevel = Number(level.level) + 1;
  const ranked = overview.ranked;
  const streak = overview.streak;
  const solo = overview.solo;

  // The server's own record line; the client never derives a win rate.
  const record = ranked
    ? `${ranked.wins}W ${ranked.losses}L${
        ranked.draws > 0 ? ` ${ranked.draws}D` : ""
      } · ${ranked.winRate}%`
    : null;

  const gaps: Array<{ key: string; text: string; href: string; cta: string }> = [];
  if (!ranked) {
    gaps.push({
      key: "ranked",
      text: "No ranked matches yet — practice and daily games don't affect your rating.",
      href: "/play/ranked",
      cta: "Play your first ranked match",
    });
  }
  if (!solo || solo.games === 0) {
    gaps.push({
      key: "solo",
      text: "No solo games yet.",
      href: "/solitaire",
      cta: "Play a solo deal",
    });
  }

  return (
    <div className="mt-4">
      {error && (
        <p
          role="status"
          className="mb-3 rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-panel)] px-3 py-2 text-xs text-[color:var(--text-secondary)]"
        >
          We couldn&apos;t refresh your dashboard, so these are the last values we
          read.{" "}
          <button
            type="button"
            onClick={onRetry}
            className="font-semibold text-[color:var(--accent-strong)] underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      )}

      {dashboard.partial && (
        <p
          role="status"
          className="mb-3 rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-panel)] px-3 py-2 text-xs text-[color:var(--text-secondary)]"
        >
          Part of your dashboard didn&apos;t load.{" "}
          <button
            type="button"
            onClick={onRetry}
            className="font-semibold text-[color:var(--accent-strong)] underline underline-offset-2"
          >
            Refresh
          </button>
        </p>
      )}

      {/* ── 1. Player overview ─────────────────────────────────────────── */}
      <Surface>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <PlayerLevelBadge
              level={level.level}
              rankKey={level.rankKey}
              size="standard"
            />
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
                {rankName}
              </p>
              <p className="mt-0.5 text-xl font-black text-[color:var(--text-primary)]">
                Level {level.level}
                {level.complete && (
                  <span className="ml-2 rounded-full border border-[color:var(--state-gold)] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[color:var(--state-gold)]">
                    Max
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--text-muted)]">
              Trophies
            </p>
            <p className="text-2xl font-black tabular-nums text-[color:var(--state-gold)]">
              {number(overview.trophies?.total ?? level.currentTrophies)}
            </p>
            {Number(overview.trophies?.peak) > Number(overview.trophies?.total) && (
              <p className="text-[11px] text-[color:var(--text-muted)]">
                Peak {number(overview.trophies.peak)}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-end justify-between gap-3 text-xs font-semibold">
            <span className="text-[color:var(--text-secondary)]">
              {level.complete
                ? "Every level reached"
                : `${number(level.progressTrophies)} / ${number(level.nextLevelTrophies)} toward level ${nextLevel}`}
            </span>
            <span className="tabular-nums text-[color:var(--text-primary)]">
              {percent}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={
              level.complete
                ? "Trophy level progress: complete"
                : `Trophy progress to level ${nextLevel}`
            }
            className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full border border-[color:var(--border-hairline)] bg-[color:var(--bg-page)]"
          >
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${percent}%`,
                background: `linear-gradient(90deg, ${tier.deep}, ${tier.accent} 55%, ${tier.metal})`,
              }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-[color:var(--text-muted)]">
            {level.complete
              ? "Your trophy count still ranks the boards."
              : `${number(level.trophiesToNext)} more ${
                  Number(level.trophiesToNext) === 1 ? "trophy" : "trophies"
                } to level ${nextLevel}.`}
          </p>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Ranked Elo"
            value={ranked ? number(ranked.rating) : "Unrated"}
            hint={
              !ranked
                ? "Your first ranked match starts placement"
                : ranked.provisional
                  ? `Provisional · ${ranked.provisionalGamesRemaining} placement ${
                      ranked.provisionalGamesRemaining === 1 ? "game" : "games"
                    } left`
                  : record
            }
            tone="accent"
          />
          <StatTile
            label="Trophies"
            value={number(overview.trophies?.total)}
            hint={`${rankName} · Level ${level.level}`}
            tone="gold"
          />
          <StatTile
            label="Daily streak"
            value={streak ? `${streak.current}` : "—"}
            hint={
              !streak
                ? "Streak unavailable"
                : `Best ${streak.best} · ${
                    streak.creditedToday ? "counted today" : "not counted today yet"
                  }`
            }
          />
          <StatTile
            label="Fastest solve"
            value={
              overview.fastestSolveMs ? formatDuration(overview.fastestSolveMs) : "—"
            }
            hint={
              overview.fastestSolveMs
                ? "Solo or Daily"
                : "Complete a game to set a record"
            }
            tone="win"
          />
        </div>

      </Surface>

      <div className="mt-4 space-y-4">
        <div className="min-w-0 space-y-4">
          {/* ── 2. Recommended next action ──────────────────────────────── */}
          <Surface className="border-[color:var(--accent)]/45">
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[color:var(--accent-strong)]">
              Recommended next
            </p>
            <h3 className="mt-2 text-lg font-black text-[color:var(--text-primary)]">
              {recommendation.title}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-[color:var(--text-secondary)]">
              {recommendation.body}
            </p>
            <div className="mt-3">
              <Button href={recommendation.href}>{recommendation.ctaLabel}</Button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[color:var(--text-muted)]">
              <span className="font-bold uppercase tracking-wider">
                Why this?
              </span>{" "}
              {recommendation.reason}
            </p>
          </Surface>

          {/* ── 3. Recent activity ─────────────────────────────────────── */}
          <Surface>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-bold text-[color:var(--text-primary)]">
                Recent activity
              </h3>
              <Link
                href="/profil"
                className="text-[11px] font-semibold text-[color:var(--text-muted)] transition hover:text-[color:var(--text-primary)]"
              >
                Full history
              </Link>
            </div>

            {overview.lastRankedChange && (
              <p className="mt-2 rounded-lg bg-[color:var(--bg-panel)] px-3 py-2 text-[11px] text-[color:var(--text-muted)]">
                Latest ranked change:{" "}
                <span className="font-semibold text-[color:var(--text-secondary)]">
                  {signed(overview.lastRankedChange.ratingDelta)} Elo
                </span>{" "}
                ·{" "}
                <span className="font-semibold text-[color:var(--state-gold)]">
                  {signed(overview.lastRankedChange.trophyDelta)} trophies
                </span>
                {overview.lastRankedChange.at
                  ? ` · ${formatDay(overview.lastRankedChange.at)}`
                  : ""}
              </p>
            )}

            {recent.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-[color:var(--border-hairline)] px-3 py-4">
                <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                  No games yet
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-secondary)]">
                  Your ranked results, Solo games and Daily Challenges will appear
                  here with a link to the review.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button href="/play/ranked" size="sm">
                    Play ranked
                  </Button>
                  <Button href="/solitaire" size="sm" variant="secondary">
                    Play solo
                  </Button>
                </div>
              </div>
            ) : (
              <ul className="mt-2 divide-y divide-[color:var(--border-hairline)]">
                {recent.map((entry) => (
                  <li
                    key={entry.key}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                        {entryTitle(entry)}
                      </p>
                      <p className={`text-[11px] ${outcomeTone(entry.outcome)}`}>
                        {entryMeta(entry)}
                      </p>
                    </div>
                    <Link
                      href={entry.href}
                      className="shrink-0 text-[11px] font-semibold text-[color:var(--accent-strong)] transition hover:text-[color:var(--text-primary)]"
                    >
                      {entry.actionLabel}
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {recent.length > 0 && gaps.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t border-[color:var(--border-hairline)] pt-3">
                {gaps.map((gap) => (
                  <p key={gap.key} className="text-[11px] text-[color:var(--text-muted)]">
                    {gap.text}{" "}
                    <Link
                      href={gap.href}
                      className="font-semibold text-[color:var(--accent-strong)] underline underline-offset-2"
                    >
                      {gap.cta} →
                    </Link>
                  </p>
                ))}
              </div>
            )}
          </Surface>
        </div>
      </div>
    </div>
  );
}
