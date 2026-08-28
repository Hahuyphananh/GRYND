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
};

const persistedGames = [
  { game: "roulette", table: "roulette_games", userColumn: "user_id", resultColumn: "result" },
  { game: "crash", table: "crash_games", userColumn: "user_id", resultColumn: "result" },
  { game: "blackjack", table: "blackjack_games", userColumn: "user_id", resultColumn: "result" },
  { game: "mines", table: "mines_games", userColumn: "user_id", resultColumn: "result" },
  { game: "lane-runner", table: "lane_runner_games", userColumn: "user_id", resultColumn: "result" },
  { game: "plinko", table: "plinko_games", userColumn: "user_id", resultColumn: "result" },
  { game: "rps", table: "rps_games", userColumn: "user_id", resultColumn: "result" },
  { game: "uno", table: "uno_games", userColumn: "user_id", resultColumn: "result" },
  { game: "keno", table: "keno_games", userColumn: "user_id", resultColumn: "status" },
  { game: "chess", table: "chess_games", userColumn: "player_white_id", resultColumn: "result" },
  { game: "connect-four", table: "connect_four_games", userColumn: "host_clerk_id", resultColumn: "result" },
  { game: "hex-duel", table: "hex_duel_games", userColumn: "player1_id", resultColumn: "result" },
] as const;

const pvpMatches = [
  { game: "dice", table: "dice_matches", players: ["player1_id", "player2_id"], status: "status", ended: "ended_at", winner: "winner_id" },
  { game: "pool", table: "pool_matches", players: ["player1_id", "player2_id"], status: "status", ended: "ended_at", winner: "winner_id" },
  { game: "rps-pvp", table: "rps_pvp_games", players: ["player1_id", "player2_id"], status: "status", ended: null, winner: "winner_id" },
  { game: "connect-four", table: "connect_four_games", players: ["host_clerk_id", "guest_clerk_id"], status: "status", ended: "ended_at", winner: "winner_clerk_id" },
  { game: "hex-duel", table: "hex_duel_games", players: ["player1_id", "player2_id"], status: "status", ended: "ended_at", winner: null },
] as const;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metric<T>(value: T, status: MetricStatus, error?: string): Metric<T> {
  return error ? { value, status, error } : { value, status };
}

async function queryGameRows(start: Date, end: Date): Promise<GameRow[]> {
  const queries = persistedGames.map(async (game) => {
    const result = await sql.query(
      `SELECT COUNT(*)::int AS played, COUNT(*)::int AS started,
              COUNT(*) FILTER (WHERE ${game.resultColumn} IS NOT NULL
                AND LOWER(${game.resultColumn}::text) NOT IN ('pending', 'active', 'waiting'))::int AS completed
       FROM ${game.table}
       WHERE created_at >= $1 AND created_at < $2`,
      [start, end],
    );
    const row = result.rows[0] ?? {};
    return {
      game: game.game,
      played: number(row.played),
      started: number(row.started),
      completed: number(row.completed),
    };
  });
  return Promise.all(queries);
}

async function queryPvpRows(start: Date, end: Date) {
  const queries = pvpMatches.map(async (game) => {
    const result = await sql.query(
      `SELECT COUNT(*)::int AS matches,
              COUNT(*) FILTER (WHERE LOWER(status::text) IN ('finished', 'completed', 'closed'))::int AS completed,
              COUNT(*) FILTER (WHERE ${game.players[0]} IS NOT NULL AND ${game.players[1]} IS NOT NULL)::int AS complete_players
       FROM ${game.table}
       WHERE created_at >= $1 AND created_at < $2`,
      [start, end],
    );
    return { game: game.game, ...(result.rows[0] ?? {}) };
  });
  return Promise.all(queries);
}

async function queryPostHog(start: Date, end: Date) {
  const host = (process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
  const key = process.env.POSTHOG_PERSONAL_API_KEY || process.env.POSTHOG_API_KEY;
  if (!key) throw new Error("POSTHOG_PERSONAL_API_KEY or POSTHOG_API_KEY is not configured");

  const response = await fetch(`${host}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: `SELECT count(DISTINCT person_id) AS users FROM events WHERE timestamp >= toDateTime('${start.toISOString()}') AND timestamp < toDateTime('${end.toISOString()}')`,
      },
    }),
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

  const [currentGames, previousGames, currentPvp, posthogCurrent, posthogPrevious] = await Promise.all([
    queryGameRows(start, end).catch((error) => { errors.push(`database current: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
    queryGameRows(previousStart, start).catch((error) => { errors.push(`database comparison: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
    queryPvpRows(start, end).catch((error) => { errors.push(`pvp: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
    queryPostHog(start, end).catch((error) => { errors.push(`PostHog current: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
    queryPostHog(previousStart, start).catch((error) => { errors.push(`PostHog comparison: ${error instanceof Error ? error.message : "query failed"}`); return null; }),
  ]);

  const games = currentGames ?? [];
  const oldGames = new Map<string, GameRow>(
    (previousGames ?? []).map((row) => [row.game, row] as [string, GameRow]),
  );
  const totalPlayed = games.reduce((sum, row) => sum + row.played, 0);
  const totalStarted = games.reduce((sum, row) => sum + row.started, 0);
  const totalCompleted = games.reduce((sum, row) => sum + row.completed, 0);

  const byGame = games.map((row) => {
    const previous = oldGames.get(row.game)?.played ?? 0;
    const change = row.played - previous;
    const percentage = previous === 0 ? null : (change / previous) * 100;
    const classification = previous === 0
      ? row.played === 0 ? "unchanged" : "insufficient_data"
      : change > 0 ? "growing" : change < 0 ? "declining" : "unchanged";
    return {
      game: row.game,
      played: row.played,
      started: row.started,
      completed: row.completed,
      completion_rate: row.started ? row.completed / row.started : null,
      popularity_share: totalPlayed ? row.played / totalPlayed : null,
      trend: { classification, current_count: row.played, previous_count: previous, absolute_change: change, percentage_change: percentage },
    };
  });

  const active = metric(posthogCurrent, posthogCurrent === null ? "unavailable" : "reliable");
  const returning = metric(null, "unavailable", "Returning users require historical person-level activity; this endpoint does not infer it from presence or aggregate counts.");
  const pvpMatchesCount = (currentPvp ?? []).reduce((sum, row) => sum + number(row.matches), 0);
  const completePlayerMatches = (currentPvp ?? []).reduce((sum, row) => sum + number(row.complete_players), 0);
  const averagePlayers = pvpMatchesCount ? completePlayerMatches * 2 / pvpMatchesCount : null;

  return NextResponse.json({
    metadata: { generated_at: end.toISOString(), current_window: { start: start.toISOString(), end: end.toISOString() }, comparison_window: { start: previousStart.toISOString(), end: start.toISOString() } },
    users: { active, returning },
    games: {
      total_played: metric(totalPlayed, currentGames ? "partial" : "unavailable"),
      total_started: metric(totalStarted, currentGames ? "partial" : "unavailable"),
      total_completed: metric(totalCompleted, currentGames ? "partial" : "unavailable"),
      most_played: [...byGame].sort((a, b) => b.played - a.played).slice(0, 5),
      least_played: byGame.filter((game) => game.played > 0).sort((a, b) => a.played - b.played).slice(0, 5),
      by_game: byGame,
      growing: byGame.filter((game) => game.trend.classification === "growing"),
      declining: byGame.filter((game) => game.trend.classification === "declining"),
    },
    pvp: {
      average_players_per_match: metric(averagePlayers, currentPvp ? "partial" : "unavailable", "Only listed PvP match tables with two non-null player identifiers are included."),
      win_distribution: metric({ wins: 0, losses: 0, draws: 0, unknown: pvpMatchesCount }, "unavailable", "Game-specific winner/result formats are not uniform enough for a safe cross-game aggregate without per-game normalization.") ,
    },      data_quality: { limitations: [
      "Database coverage is limited to the explicitly enumerated persisted game and match tables.",
      "Games with no canonical registry are omitted from zero-activity least-played results.",
      "Completion status semantics differ by game; the aggregate is partial and uses non-pending result/status values.",
      "Returning users are unavailable until PostHog historical person-level activity can be queried reliably.",
      ...errors,
    ], posthog_comparison_users: posthogPrevious },
  });
}
