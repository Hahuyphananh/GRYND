import { sql } from "../../../../db/sql";
import { pruneStalePresence } from "../../../../lib/gamePresenceStore";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

/**
 * GET /api/jobs/retention
 *
 * Daily storage-retention sweep to keep Neon Free (0.5 GB) from filling up
 * as finished matches accumulate. The infrastructure audit found that the
 * server-authoritative PvP match/round tables grow
 * unboundedly. Child rows (rounds, actions, moves, entries) have
 * `ON DELETE CASCADE` from their parent match rows, so deleting a terminal
 * match row cleans the whole subtree in one statement — no per-round scans.
 *
 * SAFETY: only rows whose `status` is truly terminal (`finished` /
 * `cancelled`) AND whose `ended_at` is older than the retention window are
 * deleted. In-progress/waiting matches are never touched, so multiplayer
 * gameplay and live rooms are unaffected. Solo cash-game history tables
 * (which back the bet-history UI) are intentionally left alone — retaining
 * them is a product decision, not an infra one.
 *
 * It also prunes stale per-game PRESENCE rows (`user_game_presence`) older than
 * a day. Those are already excluded from the lobby's active-player counts long
 * before that (a 3-minute activity window), so this is storage hygiene rather
 * than a correctness step — and putting it here keeps one retention sweep
 * instead of adding another cron.
 *
 * Scheduled on Oracle by the systemd timer `grynd-job-retention.timer`
 * (deploy/jobs/), daily off-peak, with the same CRON_SECRET bearer token
 * verification as the other jobs. Any platform scheduler works.
 */
export async function GET(request: Request) {
  // Authenticate cron request before performing global state changes
  const authError = verifyCronRequest(request);
  if (authError) return authError;
  const RETENTION_DAYS = 45;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const deletedByTable: Record<string, number> = {};

  // Purge one parent match table. Terminal states only; ended_at must be
  // older than the cutoff. Child rows cascade from the parent.
  const purge = async (
    table: string,
    /** null for a table that is terminal by construction and has no status. */
    statuses: string[] | null,
    on: "ended_at" | "created_at" = "ended_at",
  ) => {
    const statusList = statuses ? statuses.map((s) => `'${s}'`).join(",") : null;
    const column = on === "ended_at" ? "ended_at" : "created_at";
    try {
      const res = await sql.query(
        `DELETE FROM ${table}
         ${statusList ? `WHERE status IN (${statusList}) AND ${column} < $1` : `WHERE ${column} < $1`}`,
        [cutoff],
      );
      deletedByTable[table] = res.rowCount ?? 0;
    } catch (err) {
      console.error(`[retention] purge failed for ${table}:`, err);
      deletedByTable[table] = -1;
    }
  };

  const FINISHED = ["finished", "cancelled"];

  // ── PvP matches (ON DELETE CASCADE removes rounds / picks / actions) ──
  await purge("mines_pvp_matches", FINISHED);
  await purge("memory_grid_matches", FINISHED);
  await purge("keno_pvp_matches", FINISHED);
  // Lane Runner's PvP table is `lane_rush_duel_matches` (purged here). There is
  // no `lane_runner_pvp_matches` table: the legacy `lane_runner_games` table is
  // the SOLO lane runner, whose history is retained on purpose like the other
  // solo cash-game tables. Purging a table name that does not exist throws on
  // every run, which is why a failed purge now fails the sweep (below).
  await purge("lane_rush_duel_matches", FINISHED);
  await purge("precision_matches", FINISHED);
  await purge("speed_typing_matches", FINISHED);
  await purge("tic_tac_toe_matches", FINISHED);
  // Cascades to battleship_fleets and battleship_attacks. `phase` is the game's
  // own vocabulary, so a cancelled lobby (never played) is purged with the rest.
  await purge("battleship_matches", ["finished", "cancelled"]);
  await purge("solitaire_duel_matches", FINISHED);
  await purge("sudoku_duel_matches", FINISHED);
  await purge("odds_games", FINISHED);
  await purge("dots_and_boxes_games", FINISHED);
  await purge("rps_pvp_games", FINISHED);
  // Cascades to hex_duel_actions.
  await purge("hex_duel_games", FINISHED);
  // Retired LAST RUN table (migration 0233) — the game is no longer playable,
  // but its historical results stay inside the same retention window as every
  // other game. One row exists per COMPLETED match and the table has no
  // `status` column, so it is filtered on `ended_at` alone.
  await purge("last_run_matches", null);

  // ── Chess games → cascades to chess_moves (also terminal 'expired') ──
  await purge("chess_games", ["finished", "cancelled", "expired"]);

  // ── Presence: drop rows nobody has touched for a day ──────────────────
  // The lobby's "N playing" badge only counts rows inside a 3-minute activity
  // window (src/lib/gamePresence.js), so anything this old is already excluded
  // from every read. This is pure storage hygiene — the table is bounded by
  // users × games anyway — and it runs here instead of in its own cron so
  // there is still exactly one retention sweep.
  //
  // The DELETE lives in the presence store (the module that owns every access
  // to user_game_presence) rather than being spelled out here a second time.
  try {
    deletedByTable["user_game_presence"] = await pruneStalePresence();
  } catch (err) {
    console.error("[retention] purge failed for user_game_presence:", err);
    deletedByTable["user_game_presence"] = -1;
  }

  // ── Game Review analysis cache: no orphaned analyses ─────────────────
  // A cached analysis is only meaningful while its game exists. Duel matches
  // are purged above after 45 days; solo/daily rows are retained until account
  // deletion (which also removes their cached analyses). This sweep covers the
  // gap: any analysis whose parent row is gone is deleted. Runs AFTER the
  // match purge so a duel that was just removed is cleaned in the same pass.
  //
  // `game_id` is a polymorphic text id, hence three NOT EXISTS probes rather
  // than one foreign key. The (game_kind, game_id) index serves the lookup.
  try {
    const res = await sql.query(
      `DELETE FROM solitaire_analysis_cache c
       WHERE (c.game_kind = 'duel' AND NOT EXISTS (
                SELECT 1 FROM solitaire_duel_matches m WHERE m.id::text = c.game_id))
          OR (c.game_kind = 'solo' AND NOT EXISTS (
                SELECT 1 FROM solitaire_solo_results r WHERE r.id::text = c.game_id))
          OR (c.game_kind = 'daily' AND NOT EXISTS (
                SELECT 1 FROM solitaire_daily_results r WHERE r.id::text = c.game_id))`,
    );
    deletedByTable["solitaire_analysis_cache"] = res.rowCount ?? 0;
  } catch (err) {
    console.error("[retention] purge failed for solitaire_analysis_cache:", err);
    deletedByTable["solitaire_analysis_cache"] = -1;
  }

  // A table that could not be purged (for example a renamed or dropped one) is
  // recorded as -1 above. Returning `ok: true` regardless is how a stale table
  // name can keep failing on every run while the job reports success — the
  // sweep exists precisely to stop unbounded growth, so a partial sweep must
  // be visible to whatever scheduled it (systemd timer, cron, CI).
  const failedTables = Object.entries(deletedByTable)
    .filter(([, count]) => count < 0)
    .map(([table]) => table);
  const ok = failedTables.length === 0;

  return Response.json(
    {
      ok,
      runAt: new Date().toISOString(),
      cutoff: cutoff.toISOString(),
      deletedByTable,
      ...(ok ? {} : { failedTables }),
    },
    { status: ok ? 200 : 500 },
  );
}