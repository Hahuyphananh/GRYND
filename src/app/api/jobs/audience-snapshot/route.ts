// src/app/api/jobs/audience-snapshot/route.ts
//
// GET /api/jobs/audience-snapshot — scheduled every 15 minutes (vercel.json;
// the self-hosted deployment needs an equivalent timer).
//
// WHY
//   `user_presence` is overwritten per user and `users.last_played_game_date`
//   only remembers the latest day, so neither can answer "what was peak
//   concurrency yesterday". This job samples the live numbers into
//   `audience_daily_snapshots` (migration 0250) so the Operations dashboard can
//   show a trend.
//
// WHAT IT WRITES (one row per UTC day, upserted)
//   * peak_online  — GREATEST(stored, online right now), a high-water mark,
//   * players      — users whose last_played_game_date is today,
//   * signups      — accounts created today (UTC),
//   * pro_members  — distinct active/trialing/past_due subscribers right now.
//
// IDEMPOTENT: re-running only raises peak_online and refreshes the other three.
// A missed run costs a lower peak for that day, never a wrong total.

import { sql } from "../../../../db/sql";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const result = await sql`
    INSERT INTO audience_daily_snapshots (
      day,
      peak_online,
      players,
      signups,
      pro_members,
      updated_at
    )
    VALUES (
      (NOW() AT TIME ZONE 'UTC')::date,
      (SELECT count(*) FROM user_presence
        WHERE last_seen > NOW() - INTERVAL '10 minutes'),
      (SELECT count(*) FROM users
        WHERE last_played_game_date = (NOW() AT TIME ZONE 'UTC')::date),
      (SELECT count(*) FROM users
        WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')),
      (SELECT count(DISTINCT clerk_id) FROM token_subscriptions
        WHERE status IN ('active', 'trialing', 'past_due')),
      NOW()
    )
    ON CONFLICT (day) DO UPDATE SET
      peak_online = GREATEST(
        audience_daily_snapshots.peak_online,
        EXCLUDED.peak_online
      ),
      players = EXCLUDED.players,
      signups = EXCLUDED.signups,
      pro_members = EXCLUDED.pro_members,
      updated_at = NOW()
    RETURNING
      day,
      peak_online,
      players,
      signups,
      pro_members,
      updated_at
  `;

  return Response.json({ ok: true, snapshot: result.rows[0] ?? null });
}
