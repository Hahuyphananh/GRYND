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
  completedAt?: string;
  completionWindow: "created_at" | "started_at" | "completed_at" | "none";
  parentId: string;
  playerColumns?: string[];
  completionStatus?: string[];
  completionRequiresTimestamp?: boolean;
  limitations?: string[];
};

// Every definition counts the canonical parent row exactly once. Child rounds,
// actions, and lobby rows are deliberately excluded from the game totals.
const lifecycleDefinitions: LifecycleDefinition[] = [
  { game: "roulette", table: "roulette_games", parentId: "id", completionWindow: "none", playedAt: "created_at", startedAt: "created_at", limitations: ["Legacy row has no reliable completion timestamp or terminal status."] },
  { game: "crash", table: "crash_games", parentId: "id", completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completionStatus: ["crashed", "cashed_out", "finished", "completed"], limitations: ["Completion uses the parent result/status; created_at is used only for the activity window."] },
  { game: "blackjack", table: "blackjack_games", parentId: "id", completionWindow: "none", playedAt: "created_at", startedAt: "created_at", limitations: ["Legacy row has no reliable completion timestamp or terminal status."] },
  { game: "mines", table: "mines_games", parentId: "id", completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completionStatus: ["lost", "won", "cashed_out", "finished", "completed"], limitations: ["Completion uses the parent result/status; created_at is used only for the activity window."] },
  { game: "lane-runner", table: "lane_runner_games", parentId: "id", completionWindow: "none", playedAt: "created_at", startedAt: "created_at", limitations: ["Legacy row has no reliable completion timestamp or terminal status."] },
  { game: "plinko", table: "plinko_games", parentId: "id", completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completionStatus: ["lost", "won", "finished", "completed"], limitations: ["Completion uses the parent result/status; created_at is used only for the activity window."] },
  { game: "rps", table: "rps_games", parentId: "id", completionWindow: "none", playedAt: "created_at", startedAt: "created_at", limitations: ["Legacy row has no reliable completion timestamp or terminal status."] },
  { game: "uno", table: "uno_games", parentId: "id", completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completionStatus: ["finished"], limitations: ["Completion uses the parent status; created_at is used only for the activity window. Waiting rows are excluded."] },
  { game: "keno", table: "keno_games", parentId: "id", completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completionStatus: ["finished", "completed"], limitations: ["Completion uses the parent status; created_at is used only for the activity window."] },
  { game: "chess", table: "chess_games", parentId: "id", completionWindow: "none", playedAt: "started_at", startedAt: "started_at", limitations: ["This table has no completion timestamp; completed is unavailable rather than inferred from creation or result."] },
  { game: "four-in-a-row", table: "four_in_a_row_games", parentId: "id", completionWindow: "none", playedAt: "started_at", startedAt: "started_at", limitations: ["This table has no completion timestamp; completed is unavailable rather than inferred from creation or result."] },
  { game: "hex-duel", table: "hex_duel_games", parentId: "id", completionWindow: "none", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"], limitations: ["No terminal timestamp is available in the deployed table; completion uses terminal status only."] },
  { game: "dice", table: "dice_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"], limitations: ["Canonical parent has created_at, status, winner_id but no started_at or ended_at; completion uses terminal status only."] },
  { game: "pool", table: "pool_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"], limitations: ["Canonical parent has created_at, status, winner_id but no started_at or ended_at; completion uses terminal status only."] },
  { game: "rps-pvp", table: "rps_pvp_games", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", limitations: ["This table has created_at, status, and winner_id but no started_at or terminal timestamp; completed is unavailable."] },
  { game: "lane-rush-duel", table: "lane_rush_duel_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "started_at", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "roulette-pvp", table: "roulette_pvp_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "started_at", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "blackjack-pvp", table: "blackjack_pvp_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "started_at", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "mines-pvp", table: "mines_pvp_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "started_at", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "memory-grid", table: "memory_grid_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "started_at", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "plinko-pvp", table: "plinko_pvp_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "started_at", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "keno-pvp", table: "keno_pvp_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "started_at", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "dots-and-boxes", table: "dots_and_boxes_games", parentId: "id", completionWindow: "none", playedAt: "started_at", startedAt: "started_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"] },
  { game: "precision", table: "precision_matches", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completionStatus: ["finished", "completed"], limitations: ["Completion uses the parent status and winner_id; created_at is used only for the activity window."] },
  { game: "odds", table: "odds_games", parentId: "id", playerColumns: ["player1_id", "player2_id"], completionWindow: "created_at", playedAt: "created_at", startedAt: "created_at", completedAt: undefined, completionStatus: ["finished", "completed", "closed"], limitations: ["No terminal timestamp is available in the deployed table; completion uses terminal status only."] },
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
    return completed ? `${prefix}status IN ('finished','completed','closed')` : `${prefix}status NOT IN ('waiting','cancelled')`;
  }
  if (["dice_matches", "pool_matches"].includes(table)) {
    return completed ? `${prefix}status IN ('finished','completed','closed')` : `${prefix}player2_id IS NOT NULL AND ${prefix}status NOT IN ('waiting','cancelled')`;
  }
  if (["chess_games", "four_in_a_row_games", "hex_duel_games", "dots_and_boxes_games"].includes(table)) {
    return completed ? `${prefix}status IN ('finished','completed','closed')` : `${prefix}status NOT IN ('waiting','cancelled','expired')`;
  }
  if (table.endsWith("_matches") && !table.endsWith("_games")) {
    return completed ? `${prefix}status::text IN ('finished','completed','closed')` : `${prefix}status::text NOT IN ('waiting','cancelled')`;
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
  const completedPredicate = definition.completionStatus
    ? `status::text IN (${definition.completionStatus.map((status) => `'${status}'`).join(",")})`
    : statusPredicate(definition.table, "", true);
  const completedPopulation = completedTime
    ? `${completedPredicate} AND ${completedTime} >= $1 AND ${completedTime} < $2`
    : definition.completionStatus
      ? `${completedPredicate} AND ${startedTime} >= $1 AND ${startedTime} < $2`
      : "FALSE";
  const windowParams = [start, end];
  const completionIsAvailable = Boolean(completedTime || definition.completionStatus);
  const diagnostic = await sql.query(
    `SELECT COUNT(*)::int AS matching_rows, COUNT(DISTINCT ${definition.parentId})::int AS matching_parent_ids
       FROM ${definition.table}
      WHERE ${completedPopulation}`,
    completedPopulation.includes("$1") ? windowParams : [],
  );
  console.info("[pm analytics completion trace]", {
    table: definition.table,
    parentId: definition.parentId,
    matchingRows: diagnostic.rows[0]?.matching_rows,
    matchingParentIds: diagnostic.rows[0]?.matching_parent_ids,
    predicate: completedPredicate,
    usesDistinct: true,
    join: false,
    source: definition.table,
  });
  const result = await sql.query(
    `SELECT
       COUNT(DISTINCT ${definition.parentId}) FILTER (WHERE ${startedPredicate} AND ${playedTime} >= $1 AND ${playedTime} < $2)::int AS played,
       COUNT(DISTINCT ${definition.parentId}) FILTER (WHERE ${startedPredicate} AND ${startedTime} >= $1 AND ${startedTime} < $2)::int AS started,
       COUNT(DISTINCT ${definition.parentId}) FILTER (WHERE ${completedPopulation})::int AS completed
     FROM ${definition.table}`,
    windowParams,
  );
  const row = result.rows[0] ?? {};
  return {
    game: definition.game,
    played: number(row.played),
    started: number(row.started),
    completed: completionIsAvailable ? number(row.completed) : 0,
    status: definition.limitations?.length || !completionIsAvailable ? "partial" : "reliable",
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
  const completedExceedsStarted = games.filter((row) => row.completed > row.started || row.started > row.played);

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
      completion_rate: row.started > 0 && row.completed <= row.started && row.started <= row.played ? row.completed / row.started : null,
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
    ...(completedExceedsStarted.length ? ["Completion invariant violated for: " + completedExceedsStarted.map((row) => row.game).join(", ")] : []),
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
