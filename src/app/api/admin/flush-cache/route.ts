import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  invalidateAllLeaderboards,
  invalidateRecentGames,
} from "../../../../lib/redis/invalidation";
import { cacheDeletePattern, resetCacheStats } from "../../../../lib/redis/cache";
import { adminAuditLog } from "../../../../lib/security/adminAuditLog";
import { isAdmin } from "../../../../lib/auth/isAdmin";

// ── Supported flush scopes ───────────────────────────────────────

type FlushScope =
  | "all"
  | "leaderboards"
  | "user-stats"
  | "recent-games";

const ALL_SCOPES: FlushScope[] = [
  "all",
  "leaderboards",
  "user-stats",
  "recent-games",
];

// ── Handler ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Auth
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    if (!(await isAdmin(userId))) {
      return NextResponse.json(
        { success: false, error: "Forbidden. Admin access required" },
        { status: 403 },
      );
    }

    // 2. Parse scope from body (default: "all")
    let scope: FlushScope = "all";
    try {
      const body = await req.json();
      if (body.scope && typeof body.scope === "string") {
        scope = body.scope as FlushScope;
        if (!ALL_SCOPES.includes(scope)) {
          return NextResponse.json(
            {
              success: false,
              error: `Invalid scope "${body.scope}". Valid scopes: ${ALL_SCOPES.join(", ")}`,
            },
            { status: 400 },
          );
        }
      }
    } catch {
      // No body or invalid JSON — default to "all"
    }

    // 3. Flush caches based on scope
    const flushed: string[] = [];

    if (scope === "all" || scope === "leaderboards") {
      await invalidateAllLeaderboards();
      flushed.push("leaderboards");
    }

    if (scope === "all" || scope === "user-stats") {
      // Flush all user-stats keys via pattern; there's no singular
      // "invalidateAllUserStats" helper, so use cacheDeletePattern directly.
      await cacheDeletePattern("grynd:user:stats:*");
      flushed.push("user-stats");
    }

    if (scope === "all" || scope === "recent-games") {
      await invalidateRecentGames();
      flushed.push("recent-games");
    }

    // Reset in-memory stats so hit-rate numbers align post-flush
    resetCacheStats();

    // Persist to admin_audit_logs table + console
    adminAuditLog("admin_cache_flush", {
      clerkId: userId,
      details: { scope, flushed },
    }).catch(() => {});

    return NextResponse.json(
      {
        success: true,
        message: `Cache flushed (${new Date().toISOString()})`,
        flushed,
        flushedBy: userId,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[admin:flush-cache] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
