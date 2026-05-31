import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getCacheStats, resetCacheStats, cacheDeletePattern } from "../../../../lib/redis/cache";
import {
  invalidateAllLeaderboards,
  invalidateRecentGames,
  invalidateBigWins,
} from "../../../../lib/redis/invalidation";
import { auditLog } from "../../../../lib/security/auditLog";

// ── Admin guard ──────────────────────────────────────────────────
// Shared with /api/admin/flush-cache and other admin routes.
function isAdmin(userId: string): boolean {
  const admins = (process.env.CHAT_ADMIN_CLERK_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return admins.includes(userId);
}

// ── Domain name map ──────────────────────────────────────────────

const DOMAIN_LABELS: Record<string, string> = {
  lb: "leaderboards",
  user: "user-stats",
  "recent-games": "recent-games",
  "big-wins": "big-wins",
};

// ── GET: read stats ──────────────────────────────────────────────

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    if (!isAdmin(userId))
      return NextResponse.json(
        { success: false, error: "Forbidden — admin access required" },
        { status: 403 },
      );

    const raw = getCacheStats();
    const domains: Record<string, unknown> = {};

    for (const [key, stats] of Object.entries(raw)) {
      if (key === "__all__") continue;
      const label = DOMAIN_LABELS[key] || key;
      domains[label] = {
        prefix: key,
        ...stats,
      };
    }

    const all = raw["__all__"] || {
      hits: 0,
      misses: 0,
      forceFresh: 0,
      sets: 0,
      deletes: 0,
    };

    const totalRequests = all.hits + all.misses + all.forceFresh;
    const hitRate =
      totalRequests > 0
        ? ((all.hits / totalRequests) * 100).toFixed(1) + "%"
        : "n/a";

    return NextResponse.json(
      {
        success: true,
        summary: {
          ...all,
          totalRequests,
          hitRate,
        },
        domains,
        mode: {
          verboseLogging:
            process.env.CACHE_VERBOSE_LOGGING === "1" ? "enabled" : "disabled",
          logFilter: process.env.CACHE_LOG_FILTER || "none",
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[admin:cache-stats] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}

// ── DELETE: reset stats (optionally also flush cache) ────────────

export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    if (!isAdmin(userId))
      return NextResponse.json(
        { success: false, error: "Forbidden — admin access required" },
        { status: 403 },
      );

    // Check ?flush=1 query param for combined reset+flush
    const url = new URL(req.url);
    const shouldFlush = url.searchParams.get("flush") === "1";

    const flushed: string[] = [];
    if (shouldFlush) {
      await invalidateAllLeaderboards();
      flushed.push("leaderboards");
      await cacheDeletePattern("goonbet:user:stats:*");
      flushed.push("user-stats");
      await invalidateRecentGames();
      flushed.push("recent-games");
      await invalidateBigWins();
      flushed.push("big-wins");
    }

    resetCacheStats();
    auditLog("admin_cache_stats_reset", { userId, flushRequested: shouldFlush });

    return NextResponse.json(
      {
        success: true,
        message: shouldFlush
          ? "Cache flushed and stats reset"
          : "Cache stats reset",
        flushed: shouldFlush ? flushed : undefined,
        resetBy: userId,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[admin:cache-stats] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
