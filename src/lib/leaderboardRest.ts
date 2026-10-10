// src/lib/leaderboardRest.ts
//
// The leaderboard read path WITHOUT the Cloudflare Worker.
//
// ── Why this exists ─────────────────────────────────────────────────────
// A Cloudflare Worker gets 10 ms of CPU per request and measured leaderboard
// page renders needed 38–937 ms, so 5–20% of page loads died with error 1102
// (exceededCpu). These boards are public, read-only data — the browser can read
// them from PostgREST directly, and the CPU the Worker was spending on them
// disappears entirely rather than being optimised.
//
// ── The contract that makes this safe ───────────────────────────────────
// The eight public views (migrations 0209–0213) are verified to return the same
// rows, in the same order, with the same values as the query layer behind the
// routes. This module is only the transport: it builds the PostgREST query for
// a board and returns `{ items, me, games }`, the exact shape the board UI
// already consumes from `/api/leaderboard/*`. Nothing downstream changes.
//
// Two deliberate differences from the routes, both recorded in `DELTAS` below:
//
//   1. `me` is resolved from the page the reader already has. The routes also
//      resolve a TRUE rank for a signed-in player who is off-page, with a
//      second uncached per-user query; that belongs to the Clerk-JWT path and
//      is not reproduced here. A player outside the visible page has no `me`
//      row rather than a wrong one.
//   2. `profileFrame` is absent, because the views do not expose
//      `equipped_cosmetics` (the routes strip it server-side). The board renders
//      without profile frames until the cosmetics catalog is joined.
//
// ── Why the rank columns are renamed ────────────────────────────────────
// A single view carries one rank column per category (`rank_wins`,
// `rank_games`, …) so one relation serves every tab. The board UI expects a
// single `rank` field, so the requested category's column is renamed and the
// other rank columns are dropped — otherwise a row would carry seven competing
// rank values.

/** The eight public boards the leaderboard UI can show. */
export type LeaderboardTab =
  | "trophies"
  | "overall"
  | "per-game"
  | "daily-current"
  | "daily-best"
  | "weekly-streak"
  | "weekly-best"
  | "all-time";

/** All-time category keys, mirroring LEADERBOARD_CATEGORIES server-side. */
export type AllTimeCategory =
  | "wins"
  | "win_rate"
  | "games"
  | "best_streak"
  | "pvp_wins"
  | "net_wins"
  | "win_loss_ratio"
  | "current_streak";

/**
 * Board -> the view that serves it, plus which column is that board's rank.
 * `rankColumn` is a function of the requested category for `all-time`.
 */
export function leaderboardRestKey(
  tab: LeaderboardTab,
  options: { category?: string; game?: string } = {},
): string {
  const { category = "wins", game = "" } = options;
  // Namespaced so it can never collide with an /api/… SWR key, and stable so
  // the persisted cache keeps working across reloads.
  return `pg:leaderboard:${tab}:${category}:${game}`;
}

/** True for the four tabs whose rows carry a selectable rank column. */
function rankColumnFor(tab: LeaderboardTab, category: string): string {
  if (tab === "all-time") return `rank_${category}`;
  if (tab === "daily-current") return "rank_daily_streak_current";
  if (tab === "daily-best") return "rank_daily_streak_best";
  if (tab === "weekly-streak") return "rank_weekly_streak_current";
  if (tab === "weekly-best") return "rank_weekly_streak_best";
  return "rank";
}

/** The view + query for one board. */
export function leaderboardRestView(
  tab: LeaderboardTab,
  options: { category?: string; game?: string } = {},
): { view: string; params: Record<string, string> } {
  const { category = "wins", game = "" } = options;
  switch (tab) {
    case "trophies":
      return { view: "leaderboard_overall_trophies", params: { order: "rank" } };
    case "overall":
      return { view: "leaderboard_overall_elo", params: { order: "rank" } };
    case "per-game":
      return {
        view: "leaderboard_game_ratings",
        params: { game_key: `eq.${game}`, order: "rank" },
      };
    case "daily-current":
    case "daily-best":
    case "weekly-streak":
    case "weekly-best":
      return { view: "leaderboard_streaks", params: {} };
    case "all-time":
      return { view: "leaderboard_all_time", params: {} };
  }
}

type Row = Record<string, unknown>;

/** Number-ify the PostgREST string forms of numeric columns. */
function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Attach the Overall Elo badge exactly as the route's `decorateOverallElo`
 * does: the snake_case pair becomes `overallElo`/`overallGames`, and BOTH are
 * dropped when the aggregate does not exist yet (`<= 0` or absent), so the
 * badge auto-hides for an ineligible player.
 *
 * This is not cosmetic. The route emits `overallElo` and never the snake_case
 * pair for these boards, and the UI reads `overallElo`. Returning the raw
 * column here would leave the badge permanently missing once ratings data
 * exists — a regression the current empty `player_ratings` would hide.
 */
function decorateOverallElo(row: Row): Row {
  const { overall_elo, overall_games, ...rest } = row;
  const elo = Number(overall_elo);
  if (!Number.isFinite(elo) || elo <= 0) return rest;
  return { ...rest, overallElo: elo, overallGames: asNumber(overall_games) };
}

/**
 * Normalise one view row into the shape the board UI expects.
 *
 * `rankColumn` is renamed to `rank` and every other `rank_*` column is removed,
 * so a row never carries competing ranks.
 *
 * The two AGGREGATE boards also get the camelCase aliases their routes add via
 * `toOverallShape` / `toOverallTrophyShape`. Those routes keep the snake_case
 * originals too, so the aliases are added alongside rather than replacing them.
 */
function shapeRow(row: Row, rankColumn: string, tab: LeaderboardTab): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === rankColumn) continue;
    if (key.startsWith("rank_") || key === "rank") continue;
    out[key] = value;
  }
  out.rank = asNumber(row[rankColumn]);

  if (tab === "overall") {
    out.label = "Overall Elo";
    out.overallElo = asNumber(row.overall_elo);
    out.eligibleGames = asNumber(row.eligible_games);
    return out;
  }
  if (tab === "trophies") {
    out.label = "Overall Trophies";
    out.overallTrophies = asNumber(row.overall_trophies);
    out.gamesPlayed = asNumber(row.games_played);
    return out;
  }
  // Every other board can carry the cross-game Overall Elo badge.
  return decorateOverallElo(out);
}

export type LeaderboardBoard = {
  items: Row[];
  me: Row | null;
  /** Only the per-game tab needs this; the views carry no game catalog. */
  games?: Array<{ key: string; label: string }>;
};

/** Read one board from PostgREST with the publishable key. */
export async function fetchLeaderboardBoard(
  key: string,
  options: {
    limit?: number;
    /** The viewer's Clerk id, so their own row can be marked. */
    clerkId?: string | null;
    /** Game catalog, supplied by the caller for the per-game tab. */
    games?: Array<{ key: string; label: string }>;
  } = {},
): Promise<LeaderboardBoard> {
  const [, , tab, category, game] = key.split(":");
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
  if (!base || !apiKey) {
    throw new Error(
      "Leaderboard reads need NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY.",
    );
  }

  const { view, params } = leaderboardRestView(tab as LeaderboardTab, {
    category,
    game,
  });
  const rankColumn = rankColumnFor(tab as LeaderboardTab, category);
  if (tab === "per-game" && !game) return { items: [], me: null };

  const search = new URLSearchParams({ select: "*", limit: String(options.limit ?? 50) });
  for (const [name, value] of Object.entries(params)) search.set(name, value);
  // The rank column is the board's order. For the win-rate tabs the view makes
  // ineligible rows NULL, so excluding them IS the sample-size rule — see
  // migration 0211.
  search.set("order", `${rankColumn}.asc`);
  if (rankColumn === "rank_win_rate") search.set("rank_win_rate", "not.is.null");

  const response = await fetch(`${base}/rest/v1/${view}?${search.toString()}`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Leaderboard read failed (${response.status}) for ${view}.`);
  }

  const rows = (await response.json()) as Row[];
  const items = rows.map((row) => shapeRow(row, rankColumn, tab as LeaderboardTab));
  const clerkId = options.clerkId ?? null;
  const me = clerkId ? items.find((row) => row.clerk_id === clerkId) ?? null : null;

  const board: LeaderboardBoard = { items, me };
  if (tab === "per-game" && options.games) board.games = options.games;
  return board;
}

/**
 * Deliberate differences from `/api/leaderboard/*`, so a future reader does not
 * mistake them for bugs. Kept next to the code rather than in a comment above it
 * so it is exported and testable.
 */
export const DELTAS = {
  me: "resolved from the fetched page only; the routes additionally resolve a true rank for an off-page signed-in player via an uncached per-user query (needs the Clerk-JWT path)",
  profileFrame: "absent — the views do not expose equipped_cosmetics",
  superset: "rows carry every metric the view exposes, not only the requested category's, because one relation serves all tabs; the routes return just the requested fields. A superset is safe for consumers (nothing the route provided is missing) but is not byte-identical",
} as const;
