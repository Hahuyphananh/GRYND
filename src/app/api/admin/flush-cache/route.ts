import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  invalidateAllLeaderboards,
  invalidateRecentGames,
  invalidateBigWins,
} from "../../../../lib/redis/invalidation";
import { cacheDeletePattern, resetCacheStats } from "../../../../lib/redis/cache";
import { auditLog } from "../../../../lib/security/auditLog";

// ── Admin guard ──────────────────────────────────────────────────
// Reads from CHAT_ADMIN_CLERK_IDS, a comma-separated list of Clerk
// user IDs that are allowed to access admin endpoints.
// This env var is reused across /api/chat/moderate, /api/security/metrics,
// and now /api/admin/flush-cache.

function isAdmin(userId: string): boolean {
  const admins = (process.env.CHAT_ADMIN_CLERK_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return admins.includes(userId);
}

// ── Supported flush scopes ───────────────────────────────────────

type FlushScope =
  | "all"
  | "leaderboards"
  | "user-stats"
  | "recent-games"
  | "big-wins";

const ALL_SCOPES: FlushScope[] = [
  "all",
  "leaderboards",
  "user-stats",
  "recent-games",
  "big-wins",
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

    if (!isAdmin(userId)) {
      return NextResponse.json(
        { success: false, error: "Forbidden — admin access required" },
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
      await cacheDeletePattern("goonbet:user:stats:*");
      flushed.push("user-stats");
    }

    if (scope === "all" || scope === "recent-games") {
      await invalidateRecentGames();
      flushed.push("recent-games");
    }

    if (scope === "all" || scope === "big-wins") {
      await invalidateBigWins();
      flushed.push("big-wins");
    }

    // Reset in-memory stats so hit-rate numbers align post-flush
    resetCacheStats();

    auditLog("admin_cache_flush", { userId, scope, flushed });

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
