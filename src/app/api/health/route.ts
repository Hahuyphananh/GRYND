import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { getRedis } from "../../../lib/redis/client";

export const runtime = "nodejs";

/**
 * Uptime-monitoring endpoint (UptimeRobot, Pingdom, load balancers, etc.).
 *
 * Checks the two server-side dependencies:
 *  - Postgres (required) — a failing DB means the app is effectively down.
 *  - Redis (optional)    — the app degrades gracefully without it, so it is
 *    reported but does not fail the check.
 *
 * Returns 200 when healthy, 503 when Postgres is unreachable.
 */
export async function GET() {
  const startedAt = Date.now();
  const status: Record<string, unknown> = { ok: true };

  // Postgres — required. Use a lightweight query; the caller's uptime
  // monitor applies its own timeout if this hangs.
  try {
    await db.execute(sql`SELECT 1`);
    status.db = "ok";
  } catch (err) {
    status.db = "error";
    status.ok = false;
    console.error("[health] database check failed:", err);
  }

  // Redis — optional. Report status without failing the whole check.
  try {
    const redis = getRedis();
    if (redis) {
      await redis.ping();
      status.redis = "ok";
    } else {
      status.redis = "not-configured";
    }
  } catch (err) {
    status.redis = "error";
    console.error("[health] redis check failed:", err);
  }

  status.uptimeMs = Date.now() - startedAt;

  return NextResponse.json(status, { status: status.ok ? 200 : 503 });
}
