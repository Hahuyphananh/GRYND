// app/api/leaderboard/my-rank/route.ts
//
// GET /api/leaderboard/my-rank
//
// The signed-in player's TRUE weekly leaderboard rank (wins board — the
// canonical weekly ranking, identical ordering to /classement's weekly
// "Wins" tab: weekly_wins DESC, weekly_losses ASC, user_id ASC), plus the
// rank they held BEFORE their most recent settled match.
//
// The before/after deltas come from last_settled_wins_delta /
// last_settled_losses_delta (written by applyLeaderboardCounters at every
// settlement, migration 0151), so "RANK ↑ N" is real movement caused by the
// match that just ended — the rank with this match's weekly win/loss delta
// removed, everyone else held constant — never an invented number.
//
// Rank is computed with COUNT comparisons (players strictly above the
// player's (weekly_wins, weekly_losses, user_id) tuple in the board's
// ordering), not a full ROW_NUMBER scan. Uncached: per-user data.

import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const sql = getNeonSql();
    const rows = await sql.query(
      `
        WITH me AS (
          SELECT
            s.user_id AS uid,
            COALESCE(s.weekly_wins, 0)::int AS w,
            COALESCE(s.weekly_losses, 0)::int AS l,
            COALESCE(u.last_settled_wins_delta, 0)::int AS wd,
            COALESCE(u.last_settled_losses_delta, 0)::int AS ld
          FROM user_stats s
          INNER JOIN users u ON u.id = s.user_id
          WHERE u.clerk_id = $1
          LIMIT 1
        ),
        ranked AS (
          SELECT
            me.uid,
            (
              SELECT COUNT(*)::int + 1
              FROM user_stats s2
              WHERE COALESCE(s2.weekly_wins, 0) > me.w
                 OR (COALESCE(s2.weekly_wins, 0) = me.w AND COALESCE(s2.weekly_losses, 0) < me.l)
                 OR (COALESCE(s2.weekly_wins, 0) = me.w AND COALESCE(s2.weekly_losses, 0) = me.l AND s2.user_id < me.uid)
            ) AS rank_after,
            (
              SELECT COUNT(*)::int + 1
              FROM user_stats s2
              WHERE COALESCE(s2.weekly_wins, 0) > GREATEST(0, me.w - me.wd)
                 OR (
                      COALESCE(s2.weekly_wins, 0) = GREATEST(0, me.w - me.wd)
                      AND COALESCE(s2.weekly_losses, 0) < GREATEST(0, me.l - me.ld)
                    )
                 OR (
                      COALESCE(s2.weekly_wins, 0) = GREATEST(0, me.w - me.wd)
                      AND COALESCE(s2.weekly_losses, 0) = GREATEST(0, me.l - me.ld)
                      AND s2.user_id < me.uid
                    )
            ) AS rank_before
          FROM me
        )
        SELECT
          uid,
          rank_after AS rank,
          rank_before AS rank_before,
          (rank_before - rank_after) AS delta
        FROM ranked
      `,
      [userId],
    );

    const row = rows?.[0];
    if (!row || row.rank == null) {
      return Response.json({
        success: true,
        rank: null,
        rankBefore: null,
        delta: null,
      });
    }

    return Response.json({
      success: true,
      rank: Number(row.rank),
      rankBefore: Number(row.rank_before),
      delta: Number(row.delta),
    });
  } catch (error) {
    console.error(" Failed to load my leaderboard rank:", error);
    return Response.json(
      { success: false, error: "Unable to load your rank" },
      { status: 500 },
    );
  }
}