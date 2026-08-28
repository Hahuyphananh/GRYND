import { NextResponse } from "next/server";
import { sql } from "../../../../db/sql";

export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 60 * 60 * 1000;

type MetricStatus = "reliable" | "partial" | "unavailable";
type Metric<T> = { value: T; status: MetricStatus; error?: string };

type GameRow = {
  game: string;
  played: number;
  started: number;
  completed: number;
  status: MetricStatus;
  limitations: string[];
};

type LifecycleDefinition = {
  game: string;
  table: string;
  playedAt: string;
  startedAt: string;
  completedAt: string;
  limitations?: string[];
};

// Every definition counts the canonical parent row exactly once. Child rounds,
// actions, and lobby rows are deliberately excluded from the game totals.
const lifecycleDefinitions: LifecycleDefinition[] = [
  { game: "roulette", table: "roulette_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy one-shot row has no separate started_at/ended_at."] },
  { game: "crash", table: "crash_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy row completion is represented by result/status; timestamps are row creation timestamps."] },
  { game: "blackjack", table: "blackjack_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy one-shot row has no separate started_at/ended_at."] },
  { game: "mines", table: "mines_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy row completion is represented by result/status; timestamps are row creation timestamps."] },
  { game: "lane-runner", table: "lane_runner_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy row has no separate lifecycle timestamps."] },
  { game: "plinko", table: "plinko_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy row has no separate lifecycle timestamps."] },
  { game: "rps", table: "rps_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy one-shot row has no separate started_at/ended_at."] },
  { game: "uno", table: "uno_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["UNO rows are created for waiting online lobbies; played/started therefore include only persisted rows, not a canonical start timestamp."] },
  { game: "keno", table: "keno_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Legacy Keno has no separate started_at/ended_at."] },
  { game: "chess", table: "chess_games", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at", limitations: ["Waiting/cancelled games are excluded from played and started."] },
  { game: "connect-four", table: "connect_four_games", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at", limitations: ["Waiting games are excluded from played and started."] },
  { game: "hex-duel", table: "hex_duel_games", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at", limitations: ["Only rows with started_at are counted as played/started."] },
  { game: "dice", table: "dice_matches", playedAt: "created_at", startedAt: "created_at", completedAt: "ended_at", limitations: ["The match parent is canonical; dice_lobbies are excluded. This table has no started_at, so a match row is the best persisted start signal."] },
  { game: "pool", table: "pool_matches", playedAt: "created_at", startedAt: "created_at", completedAt: "ended_at", limitations: ["The match parent is canonical; pool_lobbies are excluded. This table has no started_at."] },
  { game: "rps-pvp", table: "rps_pvp_games", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["The match table has no started_at/ended_at; only matched/finished rows count as played/started/completed population."] },
  { game: "lane-rush-duel", table: "lane_rush_duel_matches", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "roulette-pvp", table: "roulette_pvp_matches", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "blackjack-pvp", table: "blackjack_pvp_matches", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "mines-pvp", table: "mines_pvp_matches", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "memory-grid", table: "memory_grid_matches", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "plinko-pvp", table: "plinko_pvp_matches", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "keno-pvp", table: "keno_pvp_matches", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "dots-and-boxes", table: "dots_and_boxes_games", playedAt: "started_at", startedAt: "started_at", completedAt: "ended_at" },
  { game: "precision", table: "precision_matches", playedAt: "created_at", startedAt: "created_at", completedAt: "created_at", limitations: ["Precision match has no started_at/ended_at; match status and winner are used for lifecycle predicates."] },
  { game: "odds", table: "odds_games", playedAt: "created_at", startedAt: "created_at", completedAt: "ended_at", limitations: ["Odds has no started_at; waiting rows are excluded from played/started."] },
];

const COMPLETED_STATUS = ["finished", "completed", "closed"];
const STARTED_STATUS = ["ready", "active", "in_progress", "matched", "finished", "completed", "closed"];

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metric<T>(value: T, status: MetricStatus, error?: string): Metric<T> {
  return error ? { value, status, error } : { value, status };
}

function statusPredicate(table: string, prefix: string, completed: boolean): string {
  if (table === "rps_pvp_games") {
    return `${prefix}status::text IN (${(completed ? COMPLETED_STATUS : STARTED_STATUS).map((s) => `'${s}'`).join(",")})`;
  }
  if (table === "precision_matches") {
    return completed ? `${prefix}status NOT IN ('waiting') AND ${prefix}winner_id IS NOT NULL` : `${prefix}status NOT IN ('waiting','cancelled')`;
  }
  if (table === "odds_games") {
    return completed ? `${prefix}status IN ('finished','completed','closed') OR ${prefix}ended_at IS NOT NULL` : `${prefix}status NOT IN ('waiting','cancelled')`;
  }
  if (["dice_matches", "pool_matches"].includes(table)) {
    return completed ? `${prefix}ended_at IS NOT NULL OR ${prefix}status IN ('finished','completed','closed')` : `${prefix}${table === "dice_matches" ? "player2_id" : "player2_id"} IS NOT NULL AND ${prefix}status NOT IN ('waiting','cancelled')`;
  }
  if (["chess_games", "connect_four_games", "hex_duel_games", "dots_and_boxes_games"].includes(table)) {
    return completed ? `${prefix}ended_at IS NOT NULL OR ${prefix}status IN ('finished','completed','closed')` : `${prefix}status NOT IN ('waiting','cancelled','expired')`;
  }
  if (table.endsWith("_matches") && !table.endsWith("_games")) {
    return completed ? `${prefix}ended_at IS NOT NULL OR ${prefix}status::text IN ('finished','completed','closed')` : `${prefix}status::text NOT IN ('waiting','cancelled')`;
  }
  if (table === "uno_games") {
    return completed ? `${prefix}status = 'finished'` : `${prefix}status IN ('active','finished')`;
  }
  if (table === "keno_games") return completed ? `${prefix}status NOT IN ('pending','active','waiting')` : `${prefix}status NOT IN ('pending','waiting')`;
  if (["crash_games", "mines_games", "plinko_games"].includes(table)) {
    return completed ? `${prefix}status NOT IN ('pending','active','waiting') AND ${prefix}result NOT IN ('pending','active','waiting')` : `${prefix}status NOT IN ('waiting')`;
  }
  return completed ? `${prefix}result IS NOT NULL AND LOWER(${prefix}result::text) NOT IN ('pending','active','waiting')` : "TRUE";
}

async function queryDefinition(definition: LifecycleDefinition, start: Date, end: Date): Promise<GameRow> {
  const startedTime = definition.startedAt;
  const playedTime = definition.playedAt;
  const completedTime = definition.completedAt;
  const startedPredicate = statusPredicate(definition.table, "", false);
  const completedPredicate = statusPredicate(definition.table, "", true);
  const result = await sql.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${startedPredicate} AND ${playedTime} >= $1 AND ${playedTime} < $2)::int AS played,
       COUNT(*) FILTER (WHERE ${startedPredicate} AND ${startedTime} >= $1 AND ${startedTime} < $2)::int AS started,
       COUNT(*) FILTER (WHERE ${completedPredicate} AND ${completedTime} >= $1 AND ${completedTime} < $2)::int AS completed
     FROM ${definition.table}`,
    [start, end],
  );
  const row = result.rows[0] ?? {};
  return {
    game: definition.game,
    played: number(row.played),
    started: number(row.started),
    completed: number(row.completed),
    status: definition.limitations?.length ? "partial" : "reliable",
    limitations: definition.limitations ?? [],
  };
}

async function queryPostHog(start: Date, end: Date) {
  const host = (process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
  const key = process.env.POSTHOG_PERSONAL_API_KEY || process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!key) throw new Error("POSTHOG_PERSONAL_API_KEY or POSTHOG_API_KEY is not configured");
  if (!projectId) throw new Error("POSTHOG_PROJECT_ID is not configured");
  const response = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: `SELECT count(DISTINCT person_id) AS users FROM events WHERE timestamp >= toDateTime('${start.toISOString()}') AND timestamp < toDateTime('${end.toISOString()}')` } }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`PostHog query failed (${response.status})`);
  const body = await response.json();
  return number(body?.results?.[0]?.[0] ?? body?.results?.[0]?.users);
}

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.PM_API_KEY}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_MS);
  const previousStart = new Date(start.getTime() - WINDOW_MS);
  const errors: string[] = [];
  const [current, previous, posthogCurrent, posthogPrevious] = await Promise.all([
    Promise.all(lifecycleDefinitions.map((definition) => queryDefinition(definition, start, end))).catch((error) => { errors.push(`database current: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
    Promise.all(lifecycleDefinitions.map((definition) => queryDefinition(definition, previousStart, start))).catch((error) => { errors.push(`database comparison: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
    queryPostHog(start, end).catch((error) => { errors.push(`PostHog current: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
    queryPostHog(previousStart, start).catch((error) => { errors.push(`PostHog comparison: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
  ]);

  const games = current ?? [];
  const oldGames = new Map<string, GameRow>((previous ?? []).map((row) => [row.game, row]));
  const totalPlayed = games.reduce((sum, row) => sum + row.played, 0);
  const totalStarted = games.reduce((sum, row) => sum + row.started, 0);
  const totalCompleted = games.reduce((sum, row) => sum + row.completed, 0);

  const byGame = games.map((row) => {
    const previousRow = oldGames.get(row.game);
    const previousCount = previousRow?.played ?? 0;
    const change = row.played - previousCount;
    const percentage = previousCount === 0 ? null : (change / previousCount) * 100;
    const classification = row.status !== "reliable" && row.status !== "partial"
      ? "insufficient_data"
      : previousCount === 0
        ? row.played === 0 ? "unchanged" : "insufficient_data"
        : change > 0 ? "growing" : change < 0 ? "declining" : "unchanged";
    return {
      game: row.game,
      played: row.played,
      started: row.started,
      completed: row.completed,
      completion_rate: row.started > 0 ? row.completed / row.started : null,
      popularity_share: totalPlayed > 0 ? row.played / totalPlayed : null,
      trend: { classification, current_count: row.played, previous_count: previousCount, absolute_change: change, percentage_change: percentage },
      metric_status: row.status,
    };
  });

  const pvpMatchesCount = games.filter((row) => row.game.includes("pvp") || row.game.includes("duel") || ["dice", "pool", "precision", "dots-and-boxes"].includes(row.game)).reduce((sum, row) => sum + row.played, 0);
  const active = metric(posthogCurrent, posthogCurrent === null ? "unavailable" : "reliable");
  const returning = metric(null, "unavailable", "Returning users require historical person-level activity; this endpoint does not infer it from aggregate counts.");
  const limitations = [
    "Totals count canonical parent game/match rows only; lobbies, rounds, actions, and child history rows are excluded.",
    "Legacy one-shot tables without lifecycle timestamps are partial because created_at is the only persisted event time.",
    "Modern matches with started_at/ended_at use those fields; waiting/cancelled rows are excluded from played/started.",
    "Metrics remain partial where the repository has no separate start or completion timestamp.",
    "PostHog is supplemental only and does not override database counts.",
    ...games.flatMap((row) => row.limitations.map((limitation) => `${row.game}: ${limitation}`)),
    ...errors,
  ];

  return NextResponse.json({
    metadata: { generated_at: end.toISOString(), current_window: { start: start.toISOString(), end: end.toISOString() }, comparison_window: { start: previousStart.toISOString(), end: start.toISOString() } },
    users: { active, returning },
    games: {
      total_played: metric(totalPlayed, current ? "partial" : "unavailable"),
      total_started: metric(totalStarted, current ? "partial" : "unavailable"),
      total_completed: metric(totalCompleted, current ? "partial" : "unavailable"),
      most_played: [...byGame].sort((a, b) => b.played - a.played).slice(0, 5),
      least_played: byGame.filter((game) => game.played > 0).sort((a, b) => a.played - b.played).slice(0, 5),
      by_game: byGame,
      growing: byGame.filter((game) => game.trend.classification === "growing"),
      declining: byGame.filter((game) => game.trend.classification === "declining"),
    },
    pvp: {
      average_players_per_match: metric(pvpMatchesCount > 0 ? 2 : null, current ? "partial" : "unavailable", "Modern PvP metrics use canonical match parent rows; player counts are not inferred from child rows."),
      win_distribution: metric(null, "unavailable", "Game-specific winner/result formats are not uniform enough for a safe cross-game aggregate."),
    },
    data_quality: { limitations, posthog_comparison_users: posthogPrevious },
  });
}
