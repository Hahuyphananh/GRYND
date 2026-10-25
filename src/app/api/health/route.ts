import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { getRedis, REDIS_TIMEOUT_MS } from "../../../lib/redis/client";
import { withTimeout } from "../../../lib/security/withTimeout";

export const runtime = "nodejs";

/**
 * Ceiling on each dependency check.
 *
 * This endpoint exists to TELL A HUMAN whether the box can reach its
 * dependencies — it is the first thing to curl after a self-hosted deploy. It
 * must therefore always answer, promptly, even when a dependency is
 * blackholed: a health check that hangs is indistinguishable from a dead
 * server and sends you hunting in the wrong place. The value sits just above
 * the pool's own 5s connect timeout, so a slow-but-working database still
 * reports `ok` while a stalled handshake is reported as `timeout`.
 */
const CHECK_TIMEOUT_MS = 6_000;

/**
 * Uptime-monitoring endpoint (UptimeRobot, Pingdom, load balancers, etc.).
 *
 * Checks the two server-side dependencies:
 *  - Postgres (required) — a failing DB means the app is effectively down.
 *  - Redis (optional)    — the app degrades gracefully without it, so it is
 *    reported but does not fail the check.
 *
 * Returns 200 when healthy, 503 when Postgres is unreachable. A dependency that
 * does not answer within CHECK_TIMEOUT_MS is reported as `timeout` instead of
 * holding the response open.
 */
export async function GET() {
  const startedAt = Date.now();
  const status: Record<string, unknown> = { ok: true };

  // Postgres — required. Use a lightweight query. A hung connection is bounded
  // here as well as by the pool so the check always produces an answer.
  try {
    const dbResult = await withTimeout(
      db.execute(sql`SELECT 1`).then(() => "ok" as const),
      CHECK_TIMEOUT_MS,
      "timeout" as const,
    );
    status.db = dbResult;
    if (dbResult !== "ok") status.ok = false;
  } catch (err) {
    status.db = "error";
    status.ok = false;
    console.error("[health] database check failed:", err);
  }

  // Redis — optional. Report status without failing the whole check. The
  // client itself already carries a per-request deadline (REDIS_TIMEOUT_MS);
  // the race below keeps this endpoint's promise bounded regardless.
  try {
    const redis = getRedis();
    if (redis) {
      const ping = await withTimeout(
        redis.ping().then(() => "ok" as const),
        REDIS_TIMEOUT_MS + 500,
        "timeout" as const,
      );
      status.redis = ping;
    } else {
      status.redis = "not-configured";
    }
  } catch (err) {
    status.redis = "error";
    console.error("[health] redis check failed:", err);
  }

  status.uptimeMs = Date.now() - startedAt;

  // A health check must never be cached: the whole value is "right now".
  return NextResponse.json(status, {
    status: status.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
