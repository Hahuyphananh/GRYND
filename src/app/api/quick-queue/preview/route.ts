import { and, eq, isNull, inArray } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db";
import { matchLifecycle } from "../../../../db/schema";
import { findCompatibleQuickQueueCandidate, normalizeQuickQueueRequest } from "../../../../lib/quickQueue";

export const dynamic = "force-dynamic";

function enabled() {
  return process.env.QUICK_QUEUE_PREVIEW_ENABLED === "1";
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!enabled()) return NextResponse.json({ success: false, error: "Quick Queue preview is disabled" }, { status: 404 });

  try {
    const body = await req.json().catch(() => ({}));
    const request = normalizeQuickQueueRequest({ ...body, userId });
    const rows = await db
      .select({ gameKey: matchLifecycle.gameKey, mode: matchLifecycle.mode, playerCount: matchLifecycle.playerCount, queuedAt: matchLifecycle.queuedAt })
      .from(matchLifecycle)
      .where(and(eq(matchLifecycle.status, "queued"), inArray(matchLifecycle.gameKey, request.preferredGames), isNull(matchLifecycle.endedAt)))
      .limit(100);

    const candidate = findCompatibleQuickQueueCandidate(request, rows.map((row) => ({
      gameKey: row.gameKey as never,
      mode: row.mode,
      region: null,
      playerCount: row.playerCount,
      queuedAt: row.queuedAt.getTime(),
      available: true,
    })));

    return NextResponse.json({
      success: true,
      preview: candidate ? { gameKey: candidate.gameKey, mode: candidate.mode, playerCount: candidate.playerCount } : null,
      joined: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Quick Queue request";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
