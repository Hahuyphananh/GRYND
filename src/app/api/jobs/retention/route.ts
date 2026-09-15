import { sql } from "../../../../db/sql";
import { pruneStalePresence } from "../../../../lib/gamePresenceStore";

/**
 * GET /api/jobs/retention
 *
 * Daily storage-retention sweep to keep Neon Free (0.5 GB) from filling up
 * as finished matches accumulate. The infrastructure audit found that the
 * server-authoritative PvP match/round tables and Crash Arena grow
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
 * Wire into Vercel Cron Jobs (see vercel.json): schedule daily off-peak.
 */
export async function GET() {
  const RETENTION_DAYS = 45;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const deletedByTable: Record<string, number> = {};

  // Purge one parent match table. Terminal states only; ended_at must be
  // older than the cutoff. Child rows cascade from the parent.
  const purge = async (
    table: string,
    statuses: string[],
    on: "ended_at" | "created_at" = "ended_at",
  ) => {
    const statusList = statuses.map((s) => `'${s}'`).join(",");
    const column = on === "ended_at" ? "ended_at" : "created_at";
    try {
      const res = await sql.query(
        `DELETE FROM ${table}
         WHERE status IN (${statusList})
           AND ${column} < $1`,
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
  await purge("plinko_pvp_matches", FINISHED);
  await purge("roulette_pvp_matches", FINISHED);
  await purge("blackjack_pvp_matches", FINISHED);
  await purge("lane_rush_duel_matches", FINISHED);
  await purge("lane_runner_pvp_matches", FINISHED);
  await purge("precision_matches", FINISHED);
  await purge("odds_games", FINISHED);
  await purge("dots_and_boxes_games", FINISHED);
  await purge("rps_pvp_games", FINISHED);
  // Cascades to hex_duel_actions.
  await purge("hex_duel_games", FINISHED);

  // ── Chess games → cascades to chess_moves (also terminal 'expired') ──
  await purge("chess_games", ["finished", "cancelled", "expired"]);

  // ── Crash Arena: closed tables cascade players/rounds/entries/txns ────
  await purge("crash_arena_tables", ["closed"], "created_at");

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

  return Response.json({
    ok: true,
    runAt: new Date().toISOString(),
    cutoff: cutoff.toISOString(),
    deletedByTable,
  });
}