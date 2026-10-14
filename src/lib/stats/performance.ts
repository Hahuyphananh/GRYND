// src/lib/stats/performance.ts
//
// PURE PERFORMANCE ANALYTICS — no database, no I/O, no clock.
//
// Every number the GRYND PRO dashboard shows is computed here from the
// AUTHORITATIVE journals the settlement writers already maintain, so the maths
// is unit-testable and the API route is only a query + a call into this file.
//
// ── WHERE THE DATA COMES FROM (and what it cannot say) ─────────────────────
//
//   * `rating_events` — one row per player per RATED match: game, match id,
//     opponent, outcome (`win` | `loss` | `draw`), rating before/after, delta.
//     Written by applyRatingResult inside the settlement transaction.
//   * `trophy_events` — the same shape for the ranked trophy ladder, written by
//     applyTrophyResult / applyPlacementTrophies.
//
// The two journals overlap for duel games (one match writes a row in each) and
// do NOT fully overlap: the multi-seat TABLES (Crash Arena, Tower Arena,
// Roulette PvP) settle trophies through the placement ladder and never write an
// Elo row. A match is therefore counted ONCE per (game, match id) across the
// UNION of both journals — counting either journal alone would undercount the
// platform's real results.
//
// ── OUTCOMES ARE NOT UNIFORM, AND ARE NOT REINTERPRETED HERE ──────────────
//
// The outcome stored on the row is the authoritative one the game's own
// settlement derived, and this module never re-derives it:
//   * duels record win / loss, and DRAW where the game can draw (Tic-Tac-Toe,
//     Solitaire Duel, Sudoku Duel);
//   * a placement table records `win` for first place and `loss` for EVERY
//     other seat (see applyPlacementTrophies — that is the product's own
//     definition of winning a table).
//
// Games whose results are not settled at all (Hex Duel accepts a
// client-supplied winner, so it is deliberately unrated; every solo/AI mode has
// no opponent) write no journal rows and therefore appear NOWHERE in this
// module — they are never shown as a 0% win rate. That is the whole reason the
// dashboard reads the journals instead of counting matches itself.
//
// ── WIN RATE ──────────────────────────────────────────────────────────────
//
// `winRate = wins / (wins + losses)`, i.e. draws are excluded from the
// denominator, and `null` (not 0) when nothing has been decided. That is the
// platform's existing definition: `applyLeaderboardCounters` — which maintains
// the `user_stats.win_rate` the leaderboards rank — has no draw branch at all,
// so a draw never enters those counters, and `player_ratings.games_rated`
// records wins/losses/draws so a game's record can always be shown in full
// alongside the rate.

import {
  OVERALL_MIN_GAMES,
  PROVISIONAL_GAMES,
  overallEloFromRatings,
} from "../elo";

export type MatchOutcome = "win" | "loss" | "draw";

/**
 * One player's authoritative result in ONE match, already merged across the
 * two journals (see `mergeJournalRows`). `rating`/`trophies` are the values
 * AFTER the match — null means that journal has no row for this match.
 */
export type ResultEvent = {
  gameKey: string;
  matchId: string;
  outcome: MatchOutcome;
  /** ISO instant the result was settled. */
  at: string;
  rating: number | null;
  trophies: number | null;
  /** Elo delta applied by this match, when the game is Elo-rated. */
  ratingDelta?: number | null;
  /** Trophy delta applied by this match, when the game is trophy-ranked. */
  trophyDelta?: number | null;
  /** Opponent's display name, when the journal row still has one. */
  opponentName?: string | null;
  /** Opponent's icon key, when the journal row still has one. */
  opponentIcon?: string | null;
};

/** One point on a progression chart. */
export type SeriesPoint = { at: string; value: number };

export type OverallEloPoint = {
  at: string;
  overallElo: number;
  eligibleGames: number;
};

export type PerformanceSummary = {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  /** wins + losses — the win-rate denominator. */
  decided: number;
  /** Percentage with two decimals, or null when nothing has been decided. */
  winRate: number | null;
  firstAt: string | null;
  lastAt: string | null;
};

export type GamePerformance = PerformanceSummary & {
  gameKey: string;
  label: string;
  /** Latest Elo in this game, when the game is Elo-rated. */
  rating: number | null;
  /** Latest trophy count in this game, when the game is trophy-ranked. */
  trophies: number | null;
};

const OUTCOMES: readonly MatchOutcome[] = ["win", "loss", "draw"];

/** Coerce a journal value to the outcome vocabulary; unknown ⇒ `loss` is NEVER guessed. */
export function normalizeOutcome(value: unknown): MatchOutcome | null {
  const outcome = String(value ?? "").toLowerCase();
  return (OUTCOMES as readonly string[]).includes(outcome)
    ? (outcome as MatchOutcome)
    : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Turn journal rows into validated result events.
 *
 * One row per (game, match id) is expected: the SQL side already collapsed the
 * two journals (`DISTINCT ON (game_key, match_id)`, Elo row preferred) and
 * joined the trophy row onto it, so this only has to reject anything it cannot
 * interpret — a row with no game, no match id, an outcome outside the
 * vocabulary, or an unreadable timestamp is DROPPED rather than coerced. An
 * unreadable result must never become a fabricated win or loss.
 *
 * Output is chronological (oldest first); ties break on game + match id so every
 * series is deterministic.
 */
export function toResultEvents(rows: unknown[] = []): ResultEvent[] {
  const events: ResultEvent[] = [];

  for (const row of rows as any[]) {
    const gameKey = String(row?.gameKey ?? row?.game_key ?? "");
    const matchId = String(row?.matchId ?? row?.match_id ?? "");
    const outcome = normalizeOutcome(row?.outcome);
    const at = toIso(row?.at ?? row?.createdAt ?? row?.created_at);
    if (!gameKey || !matchId || !outcome || !at) continue;

    events.push({
      gameKey,
      matchId,
      outcome,
      at,
      rating: toNumberOrNull(row?.rating ?? row?.ratingAfter ?? row?.rating_after),
      trophies: toNumberOrNull(row?.trophies ?? row?.trophiesAfter ?? row?.trophies_after),
      ratingDelta: toNumberOrNull(row?.ratingDelta ?? row?.rating_delta ?? row?.delta),
      trophyDelta: toNumberOrNull(row?.trophyDelta ?? row?.trophy_delta),
      opponentName: String(row?.opponentName ?? row?.opponent_name ?? "") || null,
      opponentIcon: String(row?.opponentIcon ?? row?.opponent_icon ?? "") || null,
    });
  }

  return dedupeEvents(events).sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.gameKey !== b.gameKey) return a.gameKey < b.gameKey ? -1 : 1;
    return a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0;
  });
}

/**
 * One event per (game, match id) — the same rule the SQL collapse applies, so a
 * caller that hands over both journals row-for-row cannot double-count a match.
 * The first occurrence wins (callers order Elo rows first).
 */
export function dedupeEvents(events: ResultEvent[]): ResultEvent[] {
  const seen = new Set<string>();
  const unique: ResultEvent[] = [];
  for (const event of events) {
    const key = `${event.gameKey}\u0000${event.matchId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

/** Keep only the events inside `[from, to]` (ISO strings, inclusive; either may be null). */
export function filterByDateRange(
  events: ResultEvent[],
  { from = null, to = null }: { from?: string | null; to?: string | null } = {},
): ResultEvent[] {
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  return events.filter((event) => {
    const ms = Date.parse(event.at);
    if (!Number.isFinite(ms)) return false;
    if (fromMs !== null && Number.isFinite(fromMs) && ms < fromMs) return false;
    if (toMs !== null && Number.isFinite(toMs) && ms > toMs) return false;
    return true;
  });
}

/** Keep only one game's events. `null`/`"all"` keeps every game. */
export function filterByGame(
  events: ResultEvent[],
  gameKey: string | null | undefined,
): ResultEvent[] {
  if (!gameKey || gameKey === "all") return events;
  return events.filter((event) => event.gameKey === gameKey);
}

/** Totals for a set of results. Draws are reported and excluded from the rate. */
export function summarizeResults(events: ResultEvent[]): PerformanceSummary {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const event of events) {
    if (event.outcome === "win") wins += 1;
    else if (event.outcome === "loss") losses += 1;
    else draws += 1;

    if (!firstAt || event.at < firstAt) firstAt = event.at;
    if (!lastAt || event.at > lastAt) lastAt = event.at;
  }

  const decided = wins + losses;
  return {
    matches: events.length,
    wins,
    losses,
    draws,
    decided,
    winRate: decided > 0 ? roundTo(wins / decided * 100, 2) : null,
    firstAt,
    lastAt,
  };
}

/**
 * This game's Elo curve, one point per rated match, oldest first.
 *
 * Only matches with an Elo row are points: a trophy-only table has no rating to
 * plot and is left out entirely rather than shown as a flat line at 1000.
 */
export function buildRatingSeries(events: ResultEvent[]): SeriesPoint[] {
  return events
    .filter((event) => event.rating !== null)
    .map((event) => ({ at: event.at, value: event.rating as number }));
}

/**
 * Trophies over time.
 *
 * For ONE game (or a single-game filter) the curve is that game's own count.
 * With no game filter it is the player's TOTAL across games — maintained the
 * way the platform defines it (`getTotalTrophiesForUser` sums the per-game
 * rows), i.e. each game's most recent recorded count, summed.
 */
export function buildTrophySeries(
  events: ResultEvent[],
  gameKey: string | null = null,
): SeriesPoint[] {
  if (gameKey && gameKey !== "all") {
    return events
      .filter((event) => event.trophies !== null)
      .map((event) => ({ at: event.at, value: event.trophies as number }));
  }

  const latestByGame = new Map<string, number>();
  const points: SeriesPoint[] = [];
  for (const event of events) {
    if (event.trophies === null) continue;
    latestByGame.set(event.gameKey, event.trophies);
    let total = 0;
    for (const value of latestByGame.values()) total += value;
    points.push({ at: event.at, value: total });
  }
  return points;
}

/**
 * Overall Elo over time — rebuilt from the player's OWN journal, never stored.
 *
 * Overall Elo is not a rating: it is the mean of a player's ESTABLISHED per-game
 * ratings (see overallEloFromRatings), so it has no row and no writer. Walking
 * the rated matches in order and re-aggregating the ratings known at that
 * instant reproduces exactly what the aggregate would have said then — the last
 * point therefore equals the value the profile badge shows today (a property
 * the tests assert), which is what makes this history real rather than invented.
 *
 * Points appear only once the player is ranked (3+ established games); before
 * that the series is empty and the UI says the metric is not available yet.
 */
export function buildOverallEloSeries(events: ResultEvent[]): OverallEloPoint[] {
  const ratingsByGame = new Map<string, { rating: number; gamesRated: number }>();
  const points: OverallEloPoint[] = [];

  for (const event of events) {
    if (event.rating === null) continue;
    const previous = ratingsByGame.get(event.gameKey);
    ratingsByGame.set(event.gameKey, {
      rating: event.rating,
      gamesRated: (previous?.gamesRated ?? 0) + 1,
    });

    const aggregate = overallEloFromRatings([...ratingsByGame.values()]);
    if (aggregate.overallElo === null) continue;
    points.push({
      at: event.at,
      overallElo: aggregate.overallElo,
      eligibleGames: aggregate.eligibleGames,
    });
  }

  return points;
}

/**
 * Collapse a series to one point per UTC day (that day's LAST value), keeping
 * the final point always. Charts stay readable and the payload stays bounded
 * without dropping the current value or inventing intermediate readings.
 */
export function toDailySeries<T extends { at: string }>(
  points: T[],
): T[] {
  const byDay = new Map<string, T>();
  for (const point of points) byDay.set(point.at.slice(0, 10), point);
  const collapsed = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, point]) => point);
  const last = points[points.length - 1];
  if (last && collapsed[collapsed.length - 1] !== last) collapsed.push(last);
  return collapsed;
}

export type RecentForm = {
  /** Outcomes of the most recent matches, newest first. */
  outcomes: MatchOutcome[];
  /** Win rate over those matches (draws excluded), or null. */
  winRate: number | null;
  /** Consecutive same-outcome run at the head of the list (0 when empty). */
  streak: { outcome: MatchOutcome; length: number } | null;
};

/** Recent form from the newest matches — the "last 10" strip and streak badge. */
export function recentForm(events: ResultEvent[], size = 10): RecentForm {
  const newestFirst = [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const window = newestFirst.slice(0, Math.max(0, size));
  const summary = summarizeResults(window);

  let streak: RecentForm["streak"] = null;
  for (const event of window) {
    if (!streak) streak = { outcome: event.outcome, length: 1 };
    else if (streak.outcome === event.outcome) streak.length += 1;
    else break;
  }

  return {
    outcomes: window.map((event) => event.outcome),
    winRate: summary.winRate,
    streak,
  };
}

/** Movement of a series across its window: last − first (null when < 2 points). */
export function seriesChange(points: SeriesPoint[]): number | null {
  if (points.length < 2) return null;
  return points[points.length - 1].value - points[0].value;
}

/** The platform's ranking eligibility rule, exposed for the UI's copy. */
export const RANK_ELIGIBILITY = Object.freeze({
  provisionalGames: PROVISIONAL_GAMES,
  overallMinGames: OVERALL_MIN_GAMES,
});

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
