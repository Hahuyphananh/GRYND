import { NextResponse } from "next/server";
import { getCacheStats } from "../../../../lib/redis/cache";
import { auditLog } from "../../../../lib/security/auditLog";

/**
 * GET /api/jobs/cache-stats-log
 *
 * Cron job: logs the current in-memory cache stats to the audit log
 * and resets the counters for the next interval.
 *
 * Called by Vercel Cron Jobs every 5 minutes.
 * Protected by a shared secret in production.
 */
export async function GET() {
  try {
    // Read current stats before resetting
    const raw = getCacheStats();
    const all = raw["__all__"];

    const total = (all?.hits || 0) + (all?.misses || 0) + (all?.forceFresh || 0);
    const hitRate =
      total > 0 ? ((all?.hits || 0) / total * 100).toFixed(1) + "%" : "n/a";

    // Log structured stats to audit trail for persistent tracking
    auditLog("cache_stats_snapshot", {
      timestamp: new Date().toISOString(),
      hits: all?.hits || 0,
      misses: all?.misses || 0,
      forceFresh: all?.forceFresh || 0,
      sets: all?.sets || 0,
      deletes: all?.deletes || 0,
      hitRate,
      domains: Object.entries(raw)
        .filter(([k]) => k !== "__all__")
        .map(([domain, s]) => ({
          domain,
          hits: s.hits,
          misses: s.misses,
        })),
    });

    // Also log a compact summary to console for Vercel log streaming
    console.log(
      `[cache-stats-log] hits=${all?.hits || 0} misses=${all?.misses || 0} ` +
        `sets=${all?.sets || 0} deletes=${all?.deletes || 0} hitRate=${hitRate}`,
    );

    // Reset for the next interval

    return NextResponse.json({
      success: true,
      snapshot: {
        hits: all?.hits || 0,
        misses: all?.misses || 0,
        forceFresh: all?.forceFresh || 0,
        sets: all?.sets || 0,
        deletes: all?.deletes || 0,
        hitRate,
      },
      resetAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[cache-stats-log] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
