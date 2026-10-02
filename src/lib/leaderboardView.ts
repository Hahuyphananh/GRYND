import { sql } from "../db/sql";

/** The view created by migration 0200_rating_leaderboard_mv.sql. */
const VIEW = "rating_leaderboard_mv";

/**
 * Rebuild the materialized leaderboard ranks.
 *
 * `fetchRatingLeaderboard` used to run a `ROW_NUMBER()` over every rated row of
 * a game plus a full-table `GROUP BY` for the cross-game Overall-Elo badge —
 * both recomputed per request, and neither prunable by the outer LIMIT/OFFSET.
 * The view computes them once; this rebuilds it.
 *
 * CONCURRENTLY is used first because it does not take an ACCESS EXCLUSIVE lock,
 * so leaderboard reads keep working while the view rebuilds. It cannot run
 * inside a transaction (and requires the view to already be populated), so the
 * callers below are plain route handlers/crons with no surrounding
 * transaction, and the plain REFRESH is the fallback.
 *
 * Returns true when the view was rebuilt. Never throws — a failed refresh must
 * not take down the cron that also settles weekly state.
 */
export async function refreshRatingLeaderboardView(): Promise<boolean> {
  try {
    await sql.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${VIEW}`);
    return true;
  } catch (concurrentError) {
    try {
      await sql.query(`REFRESH MATERIALIZED VIEW ${VIEW}`);
      return true;
    } catch (blockingError) {
      console.error(
        "[leaderboardView] refresh failed:",
        concurrentError,
        blockingError,
      );
      return false;
    }
  }
}
