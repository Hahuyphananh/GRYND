// src/app/api/jobs/daily-reset/route.ts
//
// GET /api/jobs/daily-reset — Vercel Cron (see vercel.json: "0 0 * * *").
//
// Zeroes the daily responsible-play counters (users.daily_wagered /
// users.daily_won) at midnight UTC so "down X tokens today" always refers
// to the current UTC day. The `WHERE daily_wagered <> 0 OR daily_won <> 0`
// guard keeps the write set to players who actually wagered today instead
// of touching every users row.
//
// These counters are bumped on every real-money settlement
// (applyLeaderboardCounters + the PvP server stores) and read by
// GET /api/user/daily-loss for the DailyLossGuard / navbar chip.

import { sql } from "../../../../db/sql";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

export async function GET(request: Request) {
  // Authenticate cron request before performing global state changes
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const result = await sql`
    UPDATE users
    SET daily_wagered = 0, daily_won = 0
    WHERE daily_wagered <> 0 OR daily_won <> 0
  `;
  return Response.json({ ok: true, reset: result.rowCount ?? 0 });
}