// src/lib/stats/queries.ts
//
// SERVER-SIDE reads for the GRYND PRO performance dashboard, plus the rank
// snapshot writer. The analytics maths lives in ./performance (pure, tested);
// this file fetches, aggregates and assembles.
//
// ── PERFORMANCE SHAPE (why the statements look like this) ──────────────────
//
// Every statement is per-PLAYER and index-assisted, so a dashboard render never
// scans a game table and never walks matches one by one:
//
//   * `rating_events` and `trophy_events` are indexed on
//     (user_id, game_key, created_at), and the `INNER JOIN users u ON u.id =
//     e.user_id` rides the unique clerk_id index — so a date range and an
//     optional game filter both prune before any row is returned;
//   * the summary is an AGGREGATE over a single GROUPING SETS query (the whole
//     filter + one row per game), never a JavaScript reduction over a capped
//     list: a chart cap must not be able to make the headline totals wrong;
//   * the progression series reads a BOUNDED slice of the most recent rows (a
//     chart plots hundreds of points, not a lifetime) and the cap is reported
//     in the payload;
//   * recent results are PAGINATED in SQL (LIMIT/OFFSET over the collapsed
//     per-match set), not sliced after fetching everything;
//   * rank history reads `player_rank_snapshots` by (user_id, bucket).
//
// ── ONE MATCH = ONE RESULT ────────────────────────────────────────────────
//
// A duel settles through BOTH writers, so a match has a row in each journal;
// the placement tables (Crash Arena, Tower Arena, Roulette PvP) have only a
// trophy row. `deduped` in the shared CTE collapses the union to ONE row per
// (game_key, match_id) — the Elo row wins when both exist, because both writers
// are handed the same settlement outcome — and the trophy columns are joined
// back onto that row so a result keeps its trophy delta without a second match
// row. Counting either journal alone would undercount the platform's results.
//
// ── CURRENCY OF THE RANK CURVE ────────────────────────────────────────────
//
// The journals give exact Elo and trophy history, but a RANK is a position
// among everyone else at one instant and only "now" is stored
// (rating_leaderboard_mv and the live Overall Elo board). Rank history
// therefore comes from `player_rank_snapshots`, written daily by
// /api/jobs/rank-snapshots and refreshed for the requesting player whenever
// they open the dashboard (idempotent on (user_id, bucket)). Nothing is
// reconstructed from today's rank: a player's curve begins the first day a
// snapshot exists for them, and the UI says so rather than inventing a line.

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { OVERALL_MIN_GAMES, PROVISIONAL_GAMES } from "../elo";
import { getRatingGameLabel } from "../rating";
import {
  buildOverallEloSeries,
  buildRatingSeries,
  buildTrophySeries,
  recentForm,
  seriesChange,
  toResultEvents,
  type GamePerformance,
  type OverallEloPoint,
  type PerformanceSummary,
  type ResultEvent,
  type SeriesPoint,
} from "./performance";

/**
 * How many recent per-match rows one dashboard render may pull for the charts.
 * A cap is required (a chart is a few hundred points, not a lifetime of
 * matches) and it is reported in the payload, so nothing implies the curve is
 * unbounded.
 */
export const SERIES_ROW_CAP = 4000;

/** Hard ceiling on the recent-results page size. */
export const RECENT_MAX_LIMIT = 50;

// Reads go through the SAME shared Drizzle client the settlement writers use
// (`db` from src/db, the pg-backed pool), and every statement is composed from
// `sql` fragments so the CTE below is written once and embedded by reference in
// the summary, the series and the recent page.
function rowsOf(result: unknown): any[] {
  if (Array.isArray(result)) return result as any[];
  const rows = (result as { rows?: unknown[] })?.rows;
  return Array.isArray(rows) ? (rows as any[]) : [];
}

/** UTC day key (`YYYY-MM-DD`) — the snapshot bucket. */
export function utcDayBucket(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export type DashboardFilters = {
  /** Rated game key, or null/`all` for every game. */
  game?: string | null;
  /** ISO instant, inclusive lower bound. */
  from?: string | null;
  /** ISO instant, inclusive upper bound. */
  to?: string | null;
};

/**
 * The shared CTE: the caller's results with the filters applied, collapsed to
 * one row per match. Composed as a fragment so the summary, the series and the
 * recent page all read the SAME definition of "one result".
 */
function matchResultsCte(clerkId: string, { game, from, to }: DashboardFilters = {}) {
  const gameKey = game && game !== "all" ? game : null;
  const fromAt = from ?? null;
  const toAt = to ?? null;
  return sql`
    WITH journal AS (
      SELECT
        e.user_id, e.game_key, e.match_id, e.outcome, e.created_at,
        e.rating_after AS rating, e.delta AS rating_delta,
        NULL::int AS trophies, NULL::int AS trophy_delta,
        o.name AS opponent_name, o.selected_icon AS opponent_icon
      FROM rating_events e
      INNER JOIN users u ON u.id = e.user_id
      LEFT JOIN users o ON o.id = e.opponent_id
      WHERE u.clerk_id = ${clerkId}
        AND (${gameKey}::text IS NULL OR e.game_key = ${gameKey}::text)
        AND (${fromAt}::timestamptz IS NULL OR e.created_at >= ${fromAt}::timestamptz)
        AND (${toAt}::timestamptz IS NULL OR e.created_at <= ${toAt}::timestamptz)
      UNION ALL
      SELECT
        t.user_id, t.game_key, t.match_id, t.outcome, t.created_at,
        NULL::int, NULL::int,
        t.trophies_after, t.delta,
        o.name, o.selected_icon
      FROM trophy_events t
      INNER JOIN users u ON u.id = t.user_id
      LEFT JOIN users o ON o.id = t.opponent_id
      WHERE u.clerk_id = ${clerkId}
        AND (${gameKey}::text IS NULL OR t.game_key = ${gameKey}::text)
        AND (${fromAt}::timestamptz IS NULL OR t.created_at >= ${fromAt}::timestamptz)
        AND (${toAt}::timestamptz IS NULL OR t.created_at <= ${toAt}::timestamptz)
    ),
    deduped AS (
      SELECT DISTINCT ON (game_key, match_id)
        user_id, game_key, match_id, outcome, created_at,
        rating, rating_delta, opponent_name, opponent_icon
      FROM journal
      -- Elo row first (a NULL rating sorts last), so the rated row is the one
      -- kept when a match is in both journals.
      ORDER BY game_key, match_id, (rating IS NULL), created_at DESC
    )
  `;
}

/** The projection shared by the series and the recent page. */
const RESULT_COLUMNS = sql`
  d.game_key AS "gameKey",
  d.match_id AS "matchId",
  d.outcome,
  d.created_at AS "at",
  d.rating,
  d.rating_delta AS "ratingDelta",
  t.trophies_after AS trophies,
  t.delta AS "trophyDelta",
  d.opponent_name AS "opponentName",
  d.opponent_icon AS "opponentIcon"
`;

/** The trophy row for the same match, when the game is trophy-ranked. */
const TROPHY_JOIN = sql`
  LEFT JOIN trophy_events t
    ON t.user_id = d.user_id
   AND t.game_key = d.game_key
   AND t.match_id = d.match_id
`;

export type JournalSummaryRow = {
  gameKey: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  firstAt: string | null;
  lastAt: string | null;
};

/**
 * Exact totals: one row for the whole filter (the empty grouping set) plus one
 * per game, from a single aggregate.
 */
export async function fetchJournalSummary(
  clerkId: string,
  filters: DashboardFilters = {},
): Promise<{ overall: JournalSummaryRow; perGame: JournalSummaryRow[] }> {
  const result = await db.execute(sql`
    ${matchResultsCte(clerkId, filters)}
    SELECT
      COALESCE(game_key, '') AS "gameKey",
      COUNT(*)::int AS matches,
      COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
      COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses,
      COUNT(*) FILTER (WHERE outcome = 'draw')::int AS draws,
      MIN(created_at) AS "firstAt",
      MAX(created_at) AS "lastAt"
    FROM deduped
    GROUP BY GROUPING SETS ((), (game_key))
  `);

  const empty: JournalSummaryRow = {
    gameKey: "",
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    firstAt: null,
    lastAt: null,
  };

  const rows = rowsOf(result).map<JournalSummaryRow>((row) => ({
    gameKey: String(row.gameKey ?? ""),
    matches: Number(row.matches ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    draws: Number(row.draws ?? 0),
    firstAt: row.firstAt ? new Date(row.firstAt).toISOString() : null,
    lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
  }));

  return {
    overall: rows.find((row) => row.gameKey === "") ?? empty,
    perGame: rows.filter((row) => row.gameKey !== ""),
  };
}

/**
 * The most recent matches (newest first, capped) used to rebuild the curves.
 * `LIMIT` keeps the newest rows; the pure layer restores chronological order.
 */
export async function fetchSeriesEvents(
  clerkId: string,
  filters: DashboardFilters = {},
  cap: number = SERIES_ROW_CAP,
): Promise<ResultEvent[]> {
  const limit = Math.max(1, Math.min(Math.trunc(cap) || SERIES_ROW_CAP, 20000));
  const result = await db.execute(sql`
    ${matchResultsCte(clerkId, filters)}
    SELECT ${RESULT_COLUMNS}
    FROM deduped d
    ${TROPHY_JOIN}
    ORDER BY d.created_at DESC, d.match_id DESC
    LIMIT ${limit}
  `);

  return toResultEvents(rowsOf(result));
}

/** One page of recent results, paginated in SQL over the collapsed set. */
export async function fetchRecentResults(
  clerkId: string,
  filters: DashboardFilters = {},
  { limit = 10, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<ResultEvent[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 10, RECENT_MAX_LIMIT));
  const safeOffset = Math.max(0, Math.trunc(offset) || 0);
  const result = await db.execute(sql`
    ${matchResultsCte(clerkId, filters)}
    SELECT ${RESULT_COLUMNS}
    FROM deduped d
    ${TROPHY_JOIN}
    ORDER BY d.created_at DESC, d.match_id DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `);

  return toResultEvents(rowsOf(result)).sort((a, b) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : a.matchId < b.matchId ? 1 : -1,
  );
}

/**
 * The player's CURRENT per-game values, from the authoritative rows (never
 * inferred from a capped series): rating + trophies per game. One query.
 */
export async function fetchCurrentTotals(
  clerkId: string,
): Promise<Map<string, { rating: number | null; trophies: number | null }>> {
  const result = await db.execute(sql`
    SELECT r.game_key AS "gameKey", r.rating AS rating, NULL::int AS trophies
    FROM player_ratings r
    INNER JOIN users u ON u.id = r.user_id
    WHERE u.clerk_id = ${clerkId}
    UNION ALL
    SELECT p.game_key AS "gameKey", NULL::int AS rating, p.trophies AS trophies
    FROM player_trophies p
    INNER JOIN users u ON u.id = p.user_id
    WHERE u.clerk_id = ${clerkId}
  `);

  const totals = new Map<string, { rating: number | null; trophies: number | null }>();
  for (const row of rowsOf(result)) {
    const gameKey = String(row.gameKey ?? "");
    if (!gameKey) continue;
    const current = totals.get(gameKey) ?? { rating: null, trophies: null };
    totals.set(gameKey, {
      rating: row.rating === null || row.rating === undefined ? current.rating : Number(row.rating),
      trophies:
        row.trophies === null || row.trophies === undefined
          ? current.trophies
          : Number(row.trophies),
    });
  }
  return totals;
}

export type RankHistoryPoint = {
  /** UTC day (`YYYY-MM-DD`). */
  bucket: string;
  overallElo: number | null;
  overallRank: number | null;
  eligibleGames: number;
  capturedAt: string | null;
};

function toRankPoint(row: any): RankHistoryPoint {
  return {
    bucket: String(row.bucket).slice(0, 10),
    overallElo:
      row.overallElo === null || row.overallElo === undefined ? null : Number(row.overallElo),
    overallRank:
      row.overallRank === null || row.overallRank === undefined ? null : Number(row.overallRank),
    eligibleGames: Number(row.eligibleGames ?? 0),
    capturedAt: row.capturedAt ? new Date(row.capturedAt).toISOString() : null,
  };
}

/** The player's recorded Overall Elo rank history, oldest first. */
export async function fetchRankHistory(
  clerkId: string,
  {
    from = null,
    to = null,
    limit = 400,
  }: { from?: string | null; to?: string | null; limit?: number } = {},
): Promise<RankHistoryPoint[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 400, 2000));
  const result = await db.execute(sql`
    SELECT
      s.bucket,
      s.overall_elo AS "overallElo",
      s.overall_rank AS "overallRank",
      s.eligible_games AS "eligibleGames",
      s.captured_at AS "capturedAt"
    FROM player_rank_snapshots s
    INNER JOIN users u ON u.id = s.user_id
    WHERE u.clerk_id = ${clerkId}
      AND (${from}::date IS NULL OR s.bucket >= ${from}::date)
      AND (${to}::date IS NULL OR s.bucket <= ${to}::date)
    ORDER BY s.bucket ASC
    LIMIT ${safeLimit}
  `);

  return rowsOf(result).map(toRankPoint);
}

/**
 * Record (or refresh) ONE player's snapshot for a UTC day.
 *
 * The rank is the same computation the Overall Elo board performs — the mean of
 * ESTABLISHED per-game ratings (`games_rated >= PROVISIONAL_GAMES`, at least
 * OVERALL_MIN_GAMES of them), ordered by that mean DESC and then by user id ASC
 * — so the stored position is the position the board showed at capture. A
 * player who is not ranked yet produces NO row (there is no position to
 * record), which is why the chart can honestly say the curve has not begun.
 *
 * Idempotent: ON CONFLICT (user_id, bucket) refreshes the day instead of
 * adding a second row.
 */
export async function captureRankSnapshot(
  clerkId: string,
  bucket: string = utcDayBucket(),
): Promise<RankHistoryPoint | null> {
  const result = await db.execute(sql`
    WITH me AS (
      SELECT u.id AS uid
      FROM users u
      WHERE u.clerk_id = ${clerkId}
      LIMIT 1
    ),
    eligible AS (
      SELECT
        r.user_id,
        AVG(r.rating)::numeric AS overall_rating,
        COUNT(*)::int AS eligible_games
      FROM player_ratings r
      WHERE r.games_rated >= ${PROVISIONAL_GAMES}
      GROUP BY r.user_id
      HAVING COUNT(*) >= ${OVERALL_MIN_GAMES}
    ),
    mine AS (
      SELECT e.user_id, e.overall_rating, e.eligible_games
      FROM eligible e
      INNER JOIN me ON me.uid = e.user_id
    ),
    ranked AS (
      SELECT
        m.user_id,
        ROUND(m.overall_rating)::int AS overall_elo,
        m.eligible_games,
        (
          1 + (
            SELECT COUNT(*)
            FROM eligible e2
            WHERE e2.overall_rating > m.overall_rating
               OR (e2.overall_rating = m.overall_rating AND e2.user_id < m.user_id)
          )
        )::int AS overall_rank
      FROM mine m
    )
    INSERT INTO player_rank_snapshots
      (user_id, bucket, overall_elo, overall_rank, eligible_games, captured_at)
    SELECT r.user_id, ${bucket}::date, r.overall_elo, r.overall_rank, r.eligible_games, now()
    FROM ranked r
    ON CONFLICT (user_id, bucket) DO UPDATE SET
      overall_elo = EXCLUDED.overall_elo,
      overall_rank = EXCLUDED.overall_rank,
      eligible_games = EXCLUDED.eligible_games,
      captured_at = EXCLUDED.captured_at
    RETURNING
      bucket,
      overall_elo AS "overallElo",
      overall_rank AS "overallRank",
      eligible_games AS "eligibleGames",
      captured_at AS "capturedAt"
  `);

  const row = rowsOf(result)[0];
  return row ? toRankPoint(row) : null;
}

/**
 * The daily sweep: ONE statement records every ranked player's position for a
 * UTC day. Idempotent on (user_id, bucket), so re-running it — or racing the
 * read-path capture — can never duplicate a player's day.
 */
export async function captureRankSnapshotsForAllRanked(
  bucket: string = utcDayBucket(),
): Promise<number> {
  const result = await db.execute(sql`
    WITH eligible AS (
      SELECT
        r.user_id,
        AVG(r.rating)::numeric AS overall_rating,
        COUNT(*)::int AS eligible_games
      FROM player_ratings r
      WHERE r.games_rated >= ${PROVISIONAL_GAMES}
      GROUP BY r.user_id
      HAVING COUNT(*) >= ${OVERALL_MIN_GAMES}
    ),
    ranked AS (
      SELECT
        e.user_id,
        ROUND(e.overall_rating)::int AS overall_elo,
        e.eligible_games,
        (ROW_NUMBER() OVER (
           ORDER BY e.overall_rating DESC, e.user_id ASC
         ))::int AS overall_rank
      FROM eligible e
    )
    INSERT INTO player_rank_snapshots
      (user_id, bucket, overall_elo, overall_rank, eligible_games, captured_at)
    SELECT r.user_id, ${bucket}::date, r.overall_elo, r.overall_rank, r.eligible_games, now()
    FROM ranked r
    ON CONFLICT (user_id, bucket) DO UPDATE SET
      overall_elo = EXCLUDED.overall_elo,
      overall_rank = EXCLUDED.overall_rank,
      eligible_games = EXCLUDED.eligible_games,
      captured_at = EXCLUDED.captured_at
  `);

  const rows = rowsOf(result);
  if (rows.length) return rows.length;
  return Number((result as { rowCount?: number })?.rowCount ?? 0);
}

export type DashboardPayload = {
  summary: PerformanceSummary;
  perGame: GamePerformance[];
  series: {
    game: string | null;
    /** This game's Elo curve — only when a single game is selected. */
    rating: SeriesPoint[];
    ratingChange: number | null;
    /** Overall Elo (cross-game aggregate) curve. */
    overallElo: OverallEloPoint[];
    overallEloChange: number | null;
    /** Trophy curve: the selected game's count, or the cross-game total. */
    trophy: SeriesPoint[];
    trophyChange: number | null;
    /** Per-match rows the curves were rebuilt from (bounded). */
    rowsUsed: number;
    capped: boolean;
  };
  recent: ResultEvent[];
  recentForm: ReturnType<typeof recentForm>;
  rankHistory: RankHistoryPoint[];
  eligibility: { provisionalGames: number; overallMinGames: number };
  generatedAt: string;
};

function winRateOf(wins: number, losses: number): number | null {
  const decided = wins + losses;
  if (decided <= 0) return null;
  return Math.round((wins / decided) * 100 * 100) / 100;
}

/**
 * Assemble the whole dashboard payload for one player.
 *
 * `includeRankCapture` refreshes today's rank snapshot as a side effect of the
 * player opening the dashboard — the "when necessary after a ranking update"
 * half of the snapshot policy (the daily job covers everyone else). It is
 * best-effort: a snapshot failure must never fail the dashboard.
 */
export async function getPerformanceDashboard({
  clerkId,
  filters = {},
  recentLimit = 10,
  recentOffset = 0,
  includeRankCapture = false,
}: {
  clerkId: string;
  filters?: DashboardFilters;
  recentLimit?: number;
  recentOffset?: number;
  includeRankCapture?: boolean;
}): Promise<DashboardPayload> {
  const gameKey = filters.game && filters.game !== "all" ? filters.game : null;

  if (includeRankCapture) {
    try {
      await captureRankSnapshot(clerkId);
    } catch (error) {
      console.error("[stats] rank snapshot capture failed:", error);
    }
  }

  const [summaryRows, current, events, recent, rankHistory] = await Promise.all([
    fetchJournalSummary(clerkId, filters),
    fetchCurrentTotals(clerkId),
    fetchSeriesEvents(clerkId, filters),
    fetchRecentResults(clerkId, filters, { limit: recentLimit, offset: recentOffset }),
    fetchRankHistory(clerkId, { from: filters.from ?? null, to: filters.to ?? null }),
  ]);

  const { overall } = summaryRows;

  const summary: PerformanceSummary = {
    matches: overall.matches,
    wins: overall.wins,
    losses: overall.losses,
    draws: overall.draws,
    decided: overall.wins + overall.losses,
    winRate: winRateOf(overall.wins, overall.losses),
    firstAt: overall.firstAt,
    lastAt: overall.lastAt,
  };

  const perGame: GamePerformance[] = summaryRows.perGame
    .map((row) => ({
      gameKey: row.gameKey,
      label: getRatingGameLabel(row.gameKey),
      matches: row.matches,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      decided: row.wins + row.losses,
      winRate: winRateOf(row.wins, row.losses),
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      rating: current.get(row.gameKey)?.rating ?? null,
      trophies: current.get(row.gameKey)?.trophies ?? null,
    }))
    .sort((a, b) => (b.matches !== a.matches ? b.matches - a.matches : a.label.localeCompare(b.label)));

  const ratingSeries = gameKey ? buildRatingSeries(events) : [];
  const overallSeries = buildOverallEloSeries(events);
  const trophySeries = buildTrophySeries(events, gameKey);

  return {
    summary,
    perGame,
    series: {
      game: gameKey,
      rating: ratingSeries,
      ratingChange: seriesChange(ratingSeries),
      overallElo: overallSeries,
      overallEloChange: seriesChange(overallSeries.map((p) => ({ at: p.at, value: p.overallElo }))),
      trophy: trophySeries,
      trophyChange: seriesChange(trophySeries),
      rowsUsed: events.length,
      capped: events.length >= SERIES_ROW_CAP,
    },
    recent,
    recentForm: recentForm(events),
    rankHistory,
    eligibility: {
      provisionalGames: PROVISIONAL_GAMES,
      overallMinGames: OVERALL_MIN_GAMES,
    },
    generatedAt: new Date().toISOString(),
  };
}
