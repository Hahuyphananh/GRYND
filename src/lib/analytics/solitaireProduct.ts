// src/lib/analytics/solitaireProduct.ts
//
// Server-only aggregation for the Solitaire product & retention dashboard.
//
// SOURCES, and why each metric lives where it does:
//   * Postgres — the authoritative counts: accounts, completed/abandoned games,
//     ranked settlement, queue latency, live matches. These rows are written
//     after server-side validation, so they cannot be inflated by a client.
//   * PostHog — the funnel and retention stages, because they need per-person
//     ordering (landing → signup → onboarding → first game → ranked), which the
//     product tables do not store. PostHog is consent-gated, so those sections
//     are explicitly incomplete for visitors who declined analytics.
//
// Nothing here fabricates a value: an unavailable source returns null with a
// reason, and the UI renders it as unavailable.

import { sql } from "../../db/sql";
import { runHogQL } from "./solitaireDashboard";
import {
  buildFunnel,
  completionRate,
  median,
  percentile,
  previousRange,
  type FunnelStep,
  type MetricRange,
  utcRange,
} from "./solitaireProductCore";

export type Section<T> =
  | { available: true; value: T; limitations: string[] }
  | { available: false; value: null; reason: string; limitations: string[] };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : "query failed";

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function section<T>(work: () => Promise<T>, limitations: string[] = []): Promise<Section<T>> {
  try {
    return { available: true, value: await work(), limitations };
  } catch (error) {
    return { available: false, value: null, reason: reasonOf(error), limitations };
  }
}

// ── Overview ───────────────────────────────────────────────────────────────

export type Overview = {
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
  newUsersChange: number | null;
};

/**
 * One query unions every player-activity table; DAU/WAU/MAU are then distinct
 * ids over 1/7/30 days. The first-seen scan is bounded to the last 400 days so
 * this cannot become a full-history scan.
 */
async function overview(range: MetricRange): Promise<Overview> {
  const activity = `
    WITH activity AS (
      SELECT user_id AS uid, created_at AS at FROM solitaire_solo_results WHERE created_at >= now() - interval '400 days'
      UNION ALL SELECT user_id, created_at FROM solitaire_daily_results WHERE created_at >= now() - interval '400 days'
      UNION ALL SELECT player1_id, created_at FROM solitaire_duel_matches WHERE created_at >= now() - interval '400 days'
      UNION ALL SELECT player2_id, created_at FROM solitaire_duel_matches WHERE player2_id IS NOT NULL AND created_at >= now() - interval '400 days'
      UNION ALL SELECT user_id, created_at FROM solitaire_puzzle_attempts WHERE created_at >= now() - interval '400 days'
    )`;

  const [signups, active, firstSeen, games, ranked, daily] = await Promise.all([
    sql.query(`SELECT count(*)::int AS n FROM users WHERE created_at >= $1 AND created_at < $2`, [
      range.start,
      range.end,
    ]),
    sql.query(
      `${activity}
       SELECT
         count(DISTINCT uid) FILTER (WHERE at >= $2::timestamptz - interval '1 day')::int AS dau,
         count(DISTINCT uid) FILTER (WHERE at >= $2::timestamptz - interval '7 days')::int AS wau,
         count(DISTINCT uid) FILTER (WHERE at >= $2::timestamptz - interval '30 days')::int AS mau,
         count(DISTINCT uid) FILTER (WHERE at >= $1 AND at < $2)::int AS period
       FROM activity`,
      [range.start, range.end],
    ),
    sql.query(
      `${activity}, first_seen AS (SELECT uid, min(at) AS first_at FROM activity GROUP BY uid)
       SELECT count(*)::int AS n FROM first_seen WHERE first_at >= $1 AND first_at < $2`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT
         (SELECT count(*)::int FROM solitaire_solo_results WHERE created_at >= $1 AND created_at < $2)
       + (SELECT count(*)::int FROM solitaire_daily_results WHERE created_at >= $1 AND created_at < $2)
       + (SELECT count(*)::int FROM solitaire_duel_matches WHERE player2_id IS NOT NULL AND status <> 'cancelled' AND created_at >= $1 AND created_at < $2) AS started,
       (SELECT count(*)::int FROM solitaire_solo_results WHERE created_at >= $1 AND created_at < $2 AND completed)
       + (SELECT count(*)::int FROM solitaire_daily_results WHERE created_at >= $1 AND created_at < $2 AND completed)
       + (SELECT count(*)::int FROM solitaire_duel_matches WHERE status = 'finished' AND created_at >= $1 AND created_at < $2) AS completed`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT count(*)::int AS n FROM solitaire_duel_matches
        WHERE status = 'finished' AND is_ai = false AND created_at >= $1 AND created_at < $2`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT count(*)::int AS n FROM solitaire_daily_results
        WHERE completed AND created_at >= $1 AND created_at < $2`,
      [range.start, range.end],
    ),
  ]);

  const started = num(games.rows[0]?.started);
  const completed = num(games.rows[0]?.completed);
  return {
    signups: num(signups.rows[0]?.n),
    firstTimePlayers: num(firstSeen.rows[0]?.n),
    uniquePlayers: num(active.rows[0]?.period),
    dau: num(active.rows[0]?.dau),
    wau: num(active.rows[0]?.wau),
    mau: num(active.rows[0]?.mau),
    gamesStarted: started,
    gamesCompleted: completed,
    completionRate: completionRate(started, completed),
    rankedMatchesCompleted: num(ranked.rows[0]?.n),
    dailyCompleted: num(daily.rows[0]?.n),
    newUsersChange: null,
  };
}

// ── Activation funnel (PostHog, unique users, ordered) ─────────────────────

const FUNNEL_STAGES = [
  { key: "landing", label: "Landing page visitor", event: "landing_page_viewed" },
  { key: "signup", label: "Signup completed", event: "signup_completed" },
  { key: "onboarding_started", label: "Onboarding started", event: "onboarding_started" },
  { key: "onboarding_completed", label: "Onboarding completed", event: "onboarding_completed" },
  { key: "first_game_started", label: "First Solitaire game started", event: "solitaire_game_started" },
  { key: "first_game_completed", label: "First Solitaire game completed", event: "solitaire_game_completed" },
  { key: "ranked_queue", label: "First Ranked queue started", event: "ranked_queue_started" },
  { key: "ranked_completed", label: "First Ranked match completed", event: "ranked_match_completed" },
] as const;

function funnelQuery(range: MetricRange): string {
  const columns = FUNNEL_STAGES.map(
    (stage, index) => `minIf(timestamp, event = '${stage.event}') AS s${index + 1}`,
  ).join(", ");
  const events = FUNNEL_STAGES.map((stage) => `'${stage.event}'`).join(", ");
  const cumulative: string[] = [];
  const select = FUNNEL_STAGES.map((_, index) => {
    cumulative.push(`s${index + 1} IS NOT NULL`);
    // Ordered: every later stage must happen at or after the earlier one.
    for (let prior = 0; prior < index; prior += 1) {
      cumulative.push(`s${index + 1} >= s${prior + 1}`);
    }
    return `countIf(${cumulative.join(" AND ")}) AS u${index + 1}`;
  }).join(", ");
  return `SELECT ${select} FROM (
      SELECT distinct_id, ${columns}
      FROM events
      WHERE timestamp >= toDateTime('${range.start.toISOString()}')
        AND timestamp < toDateTime('${range.end.toISOString()}')
        AND event IN (${events})
      GROUP BY distinct_id
    )`;
}

async function funnelFor(range: MetricRange, previous: MetricRange): Promise<FunnelStep[]> {
  const [current, before] = await Promise.all([runHogQL(funnelQuery(range)), runHogQL(funnelQuery(previous))]);
  if (!current.ok || !current.rows?.length) {
    throw new Error(current.error ?? "No funnel result");
  }
  const row = current.rows[0];
  const previousRow = before.ok ? before.rows?.[0] : null;
  return buildFunnel(
    FUNNEL_STAGES.map((stage, index) => ({
      key: stage.key,
      label: stage.label,
      users: current.ok ? num(row?.[index]) : null,
      previousUsers: previousRow ? num(previousRow[index]) : null,
    })),
  );
}

// ── Retention (PostHog cohorts) ────────────────────────────────────────────

function retentionQuery(range: MetricRange): string {
  // The cohort is "users whose FIRST signup_completed falls in the window".
  // Day-N activity is any NON-pageview event N UTC days later, so a session
  // that only loads pages does not count as retained.
  return `SELECT dateDiff('day', toDate(c.first_seen), toDate(e.timestamp)) AS day_offset,
                 uniq(e.distinct_id) AS users
          FROM events e
          INNER JOIN (
            SELECT distinct_id, min(timestamp) AS first_seen
            FROM events
            WHERE event = 'signup_completed'
              AND timestamp >= toDateTime('${range.start.toISOString()}')
              AND timestamp < toDateTime('${range.end.toISOString()}')
            GROUP BY distinct_id
          ) c ON e.distinct_id = c.distinct_id
          WHERE e.timestamp >= c.first_seen
            AND e.event NOT IN ('$pageview', 'landing_page_viewed')
          GROUP BY day_offset
          ORDER BY day_offset
          LIMIT 60`;
}

type Retention = {
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
};

async function retention(range: MetricRange): Promise<Retention> {
  const [ph, cohort, completing] = await Promise.all([
    runHogQL(retentionQuery(range)),
    sql.query(
      `SELECT count(*)::int AS n FROM users WHERE created_at >= $1 AND created_at < $2`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT count(DISTINCT uid)::int AS n FROM (
         SELECT user_id AS uid FROM solitaire_solo_results WHERE completed AND created_at >= $1 AND created_at < $2
         UNION ALL SELECT user_id FROM solitaire_daily_results WHERE completed AND created_at >= $1 AND created_at < $2
         UNION ALL SELECT player1_id FROM solitaire_duel_matches WHERE status='finished' AND created_at >= $1 AND created_at < $2
         UNION ALL SELECT player2_id FROM solitaire_duel_matches WHERE status='finished' AND player2_id IS NOT NULL AND created_at >= $1 AND created_at < $2
       ) t`,
      [range.start, range.end],
    ),
  ]);
  if (!ph.ok) throw new Error(ph.error ?? "Retention query failed");

  const byOffset = new Map<number, number>();
  for (const row of ph.rows ?? []) byOffset.set(num(row[0]), num(row[1]));
  const size = num(cohort.rows[0]?.n);
  const rate = (retained: number | null) =>
    retained === null || size <= 0 ? null : Math.min(100, (retained / size) * 100);

  return {
    cohortDefinition:
      "Users whose first signup_completed event falls in the selected window (UTC days). A user is retained on day N if they fire any non-pageview event exactly N days later.",
    cohort: size,
    day1: byOffset.get(1) ?? null,
    day7: byOffset.get(7) ?? null,
    day30: byOffset.get(30) ?? null,
    day1Rate: rate(byOffset.get(1) ?? null),
    day7Rate: rate(byOffset.get(7) ?? null),
    day30Rate: rate(byOffset.get(30) ?? null),
    returningPlayers: null, // derived below in the route from overview
    completingPlayers: num(completing.rows[0]?.n),
  };
}

// ── Gameplay by mode ───────────────────────────────────────────────────────

export type ModeRow = {
  mode: "solo" | "daily" | "ranked" | "ai" | "puzzle";
  starts: number;
  completions: number;
  abandonments: number | null;
  completionRate: number | null;
  averageDurationSeconds: number | null;
  players: number;
  limitations: string[];
};

async function gameplay(range: MetricRange): Promise<ModeRow[]> {
  const [solo, daily, duels, puzzles] = await Promise.all([
    sql.query(
      `SELECT count(*)::int AS starts, count(*) FILTER (WHERE completed)::int AS completions,
              count(DISTINCT user_id)::int AS players,
              avg(elapsed_ms) FILTER (WHERE completed)::int AS avg_ms
         FROM solitaire_solo_results WHERE created_at >= $1 AND created_at < $2`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT count(*)::int AS starts, count(*) FILTER (WHERE completed)::int AS completions,
              count(DISTINCT user_id)::int AS players,
              avg(elapsed_ms) FILTER (WHERE completed)::int AS avg_ms
         FROM solitaire_daily_results WHERE created_at >= $1 AND created_at < $2`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT
         count(*) FILTER (WHERE is_ai)::int AS ai_starts,
         count(*) FILTER (WHERE is_ai AND status='finished')::int AS ai_completions,
         count(*) FILTER (WHERE is_ai AND status='cancelled')::int AS ai_cancelled,
         count(*) FILTER (WHERE NOT is_ai AND player2_id IS NOT NULL AND status<>'cancelled')::int AS human_starts,
         count(*) FILTER (WHERE NOT is_ai AND status='finished')::int AS human_completions,
         count(*) FILTER (WHERE NOT is_ai AND status='cancelled')::int AS human_cancelled,
         count(DISTINCT player1_id) FILTER (WHERE is_ai)::int AS ai_players,
         count(DISTINCT player1_id) FILTER (WHERE NOT is_ai)::int AS human_players,
         avg(EXTRACT(EPOCH FROM (ended_at - started_at))) FILTER (WHERE is_ai AND status='finished' AND started_at IS NOT NULL)::int AS ai_avg_s,
         avg(EXTRACT(EPOCH FROM (ended_at - started_at))) FILTER (WHERE NOT is_ai AND status='finished' AND started_at IS NOT NULL)::int AS human_avg_s
       FROM solitaire_duel_matches WHERE created_at >= $1 AND created_at < $2`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT count(*)::int AS starts, count(*) FILTER (WHERE correct)::int AS completions,
              count(DISTINCT user_id)::int AS players
         FROM solitaire_puzzle_attempts WHERE created_at >= $1 AND created_at < $2`,
      [range.start, range.end],
    ),
  ]);

  const row = (mode: ModeRow["mode"], source: Record<string, unknown>, limits: string[] = []): ModeRow => ({
    mode,
    starts: num(source.starts),
    completions: num(source.completions),
    abandonments: source.abandonments === undefined ? null : num(source.abandonments),
    completionRate: completionRate(num(source.starts), num(source.completions)),
    averageDurationSeconds: source.avg_s === null || source.avg_s === undefined ? null : num(source.avg_s),
    players: num(source.players),
    limitations: limits,
  });

  const soloRow = solo.rows[0] ?? {};
  const dailyRow = daily.rows[0] ?? {};
  const duelRow = duels.rows[0] ?? {};
  const puzzleRow = puzzles.rows[0] ?? {};

  return [
    row("solo", {
      starts: soloRow.starts,
      completions: soloRow.completions,
      abandonments: num(soloRow.starts) - num(soloRow.completions),
      avg_s: soloRow.avg_ms === null || soloRow.avg_ms === undefined ? null : num(soloRow.avg_ms) / 1000,
      players: soloRow.players,
    }, [
      "Abandonments are attempts recorded without a completion; a closed tab that never submitted leaves no row.",
    ]),
    row("daily", {
      starts: dailyRow.starts,
      completions: dailyRow.completions,
      // Daily is one attempt per player per UTC day; it has no abandonment row.
      avg_s: dailyRow.avg_ms === null || dailyRow.avg_ms === undefined ? null : num(dailyRow.avg_ms) / 1000,
      players: dailyRow.players,
    }, ["Daily has no abandonment row: it only stores a solved board."]),
    row("ranked", {
      starts: duelRow.human_starts,
      completions: duelRow.human_completions,
      abandonments: num(duelRow.human_cancelled),
      avg_s: duelRow.human_avg_s,
      players: duelRow.human_players,
    }, ["Includes recorded-human (ghost) matches; they settle as human seats."]),
    row("ai", {
      starts: duelRow.ai_starts,
      completions: duelRow.ai_completions,
      abandonments: num(duelRow.ai_cancelled),
      avg_s: duelRow.ai_avg_s,
      players: duelRow.ai_players,
    }, ["Practice matches are unrated and never settle."]),
    row("puzzle", {
      starts: puzzleRow.starts,
      completions: puzzleRow.completions,
      players: puzzleRow.players,
    }, [
      "Puzzle sessions are one answer per puzzle; 'completions' means the answer was correct.",
    ]),
  ];
}

// ── Matchmaking ────────────────────────────────────────────────────────────

export type Matchmaking = {
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
};

async function matchmaking(range: MetricRange): Promise<Matchmaking> {
  const [queue, waits, live] = await Promise.all([
    sql.query(
      `SELECT
         count(*)::int AS attempts,
         count(*) FILTER (WHERE player2_id IS NOT NULL)::int AS found,
         count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM solitaire_duel_matches
       WHERE created_at >= $1 AND created_at < $2 AND is_ai = false`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT array_agg(EXTRACT(EPOCH FROM (started_at - created_at))::float8) AS waits
         FROM solitaire_duel_matches
        WHERE created_at >= $1 AND created_at < $2
          AND is_ai = false AND player2_id IS NOT NULL AND started_at IS NOT NULL`,
      [range.start, range.end],
    ),
    sql.query(
      `SELECT
         count(*) FILTER (WHERE status = 'playing' AND is_ai = false AND player2_id NOT LIKE 'solitaire_ghost_%')::int AS live_human,
         count(*) FILTER (WHERE status = 'playing' AND player2_id LIKE 'solitaire_ghost_%')::int AS recorded_human,
         count(*) FILTER (WHERE status = 'playing' AND is_ai = true)::int AS ai_live
       FROM solitaire_duel_matches`,
    ),
  ]);

  const attempts = num(queue.rows[0]?.attempts);
  const found = num(queue.rows[0]?.found);
  const waitsSeconds = ((waits.rows[0]?.waits as number[] | null) ?? [])
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const average = waitsSeconds.length
    ? waitsSeconds.reduce((sum, value) => sum + value, 0) / waitsSeconds.length
    : null;

  return {
    queueAttempts: attempts,
    matchesFound: found,
    cancellations: num(queue.rows[0]?.cancelled),
    // Success rate is "found / attempts" among HUMAN queue rows.
    successRate: completionRate(attempts, found),
    averageWaitSeconds: average === null ? null : Math.round(average),
    medianWaitSeconds: median(waitsSeconds) === null ? null : Math.round(median(waitsSeconds) as number),
    p90WaitSeconds: percentile(waitsSeconds, 0.9) === null ? null : Math.round(percentile(waitsSeconds, 0.9) as number),
    liveHumanMatches: num(live.rows[0]?.live_human),
    recordedHumanMatches: num(live.rows[0]?.recorded_human),
    aiMatches: num(live.rows[0]?.ai_live),
    sampleSize: waitsSeconds.length,
  };
}

// ── Game Review ────────────────────────────────────────────────────────────

export type ReviewStats = {
  openedUsers: number | null;
  completedUsers: number | null;
  practiceClicks: number | null;
  adoptionRate: number | null;
  practiceExercisesStarted: number | null;
  practiceExercisesCompleted: number | null;
  limitations: string[];
};

function reviewQuery(range: MetricRange, event: string): string {
  return `SELECT uniq(distinct_id) AS users, count() AS events FROM events
          WHERE event = '${event}'
            AND timestamp >= toDateTime('${range.start.toISOString()}')
            AND timestamp < toDateTime('${range.end.toISOString()}')`;
}

async function review(range: MetricRange, completedGames: number): Promise<ReviewStats> {
  const [opened, completed, practice, drillsStarted, drillsCompleted] = await Promise.all([
    runHogQL(reviewQuery(range, "solitaire_review_opened")),
    runHogQL(reviewQuery(range, "solitaire_review_completed")),
    runHogQL(reviewQuery(range, "review_practice_clicked")),
    runHogQL(reviewQuery(range, "practice_drill_started")),
    runHogQL(reviewQuery(range, "practice_drill_completed")),
  ]);
  const openedUsers = opened.ok ? num(opened.rows?.[0]?.[0]) : null;
  const completedUsers = completed.ok ? num(completed.rows?.[0]?.[0]) : null;
  const practiceClicks = practice.ok ? num(practice.rows?.[0]?.[1]) : null;

  return {
    openedUsers,
    completedUsers,
    practiceClicks,
    // Adoption compares REVIEW USERS with completed games, so it can exceed
    // 100% (one player can review several games). It is capped and labelled.
    adoptionRate:
      openedUsers === null || completedGames <= 0
        ? null
        : Math.min(100, (openedUsers / completedGames) * 100),
    practiceExercisesStarted: drillsStarted.ok ? num(drillsStarted.rows?.[0]?.[1]) : null,
    practiceExercisesCompleted: drillsCompleted.ok
      ? num(drillsCompleted.rows?.[0]?.[1])
      : null,
    limitations: [
      "Practice starts/completions are client events (consent-gated), so they undercount visitors who declined analytics.",
      "Review users are consenting visitors only; declined consent is not represented.",
      "Adoption is users who opened a review per completed game — a ratio across different units, capped at 100%.",
      "No causal claim is made: this is correlational.",
    ],
  };
}

// ── Snapshot ───────────────────────────────────────────────────────────────

export type ProductSnapshot = {
  range: { start: string; end: string; days: number };
  previous: { start: string; end: string; days: number };
  generatedAt: string;
  overview: Section<Overview>;
  funnel: Section<{ steps: FunnelStep[] }>;
  retention: Section<Retention>;
  gameplay: Section<ModeRow[]>;
  matchmaking: Section<Matchmaking>;
  review: Section<ReviewStats>;
  definitions: Record<string, string>;
};

export async function loadProductSnapshot(days: number): Promise<ProductSnapshot> {
  const range = utcRange(days);
  const previous = previousRange(range);

  const overviewSection = await section(() => overview(range));
  const [funnelSection, retentionSection, gameplaySection, matchmakingSection] = await Promise.all([
    section(() => funnelFor(range, previous).then((steps) => ({ steps }))),
    section(() => retention(range)),
    section(() => gameplay(range)),
    section(() => matchmaking(range)),
  ]);

  const completedGames = overviewSection.available ? overviewSection.value.gamesCompleted : 0;
  const reviewSection = await section(() => review(range, completedGames));

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString(), days },
    previous: { start: previous.start.toISOString(), end: previous.end.toISOString(), days },
    generatedAt: new Date().toISOString(),
    overview: overviewSection,
    funnel: funnelSection,
    retention: retentionSection,
    gameplay: gameplaySection,
    matchmaking: matchmakingSection,
    review: reviewSection,
    definitions: {
      unique_players: "Distinct ids with at least one solo/daily/duel/puzzle row in the window.",
      dau: "Distinct ids active in the 24h before the window end.",
      wau: "Distinct ids active in the 7 days before the window end.",
      mau: "Distinct ids active in the 30 days before the window end.",
      signups: "users.created_at rows in the window (server-created accounts).",
      first_time_players:
        "Distinct ids whose FIRST recorded activity (400-day lookback) falls in the window.",
      games_started:
        "Solo rows + daily rows + non-cancelled duel rows with a second seat. Practice and ranked are both included.",
      games_completed: "Solo/daily completed rows + duel rows with status finished.",
      ranked_matches_completed: "Duel rows with status finished and is_ai = false.",
      funnel:
        "Unique consenting users, ordered: each stage must occur at or after the previous one. PostHog only.",
      retention:
        "Cohort = first signup_completed in the window; retained on day N = any non-pageview event exactly N UTC days later.",
      queue_attempt: "A non-AI duel row created (the open lobby is a row).",
      matches_found: "A non-AI duel row that acquired a second seat.",
      wait_time: "started_at - created_at for non-AI matches that found a seat.",
      recorded_human:
        "A ghost seat (solitaire_ghost_ prefix) replaying a recorded run — never counted as a live human.",
    },
  };
}
