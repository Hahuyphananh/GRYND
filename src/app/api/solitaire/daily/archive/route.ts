// /api/solitaire/daily/archive
//
// THE PRO DAILY ARCHIVE LIST.
//
// Today's challenge stays free (see ../route.ts). This endpoint lists the past
// deals behind it, and answers a FREE caller with a locked payload and NO deal
// dates at all — the entitlement is resolved from the subscription row, never
// from the request. The list is the player's calendar, not a leaderboard: each
// day carries only that player's own result, or nothing when they did not play.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { desc, eq } from "drizzle-orm";

import { db } from "../../../../../db/client";
import { solitaireDailyResults } from "../../../../../db/schema";
import { getMembershipTier } from "../../../../../lib/stripe/subscriptions";
import { dailyDateKey } from "../../../../../lib/solitaire-duel/soloStats.js";
import { dailyArchiveDateKeys } from "../../../../../lib/solitaire-duel/dailyArchive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const today = dailyDateKey();
  const { userId } = await auth();

  // No session, or a free session: today's deal is still available from the
  // free endpoint. The archive itself is PRO-only and reveals nothing here.
  if (!userId) {
    return NextResponse.json({
      success: true,
      data: { pro: false, locked: true, today, days: [] },
    });
  }

  const pro = (await getMembershipTier(userId)) === "pro";
  if (!pro) {
    return NextResponse.json({
      success: true,
      data: { pro: false, locked: true, today, days: [] },
    });
  }

  try {
    const keys = dailyArchiveDateKeys(today);
    const rows = await db
      .select({
        challengeDate: solitaireDailyResults.challengeDate,
        completed: solitaireDailyResults.completed,
        moves: solitaireDailyResults.moves,
        elapsedMs: solitaireDailyResults.elapsedMs,
      })
      .from(solitaireDailyResults)
      .where(eq(solitaireDailyResults.userId, userId))
      .orderBy(desc(solitaireDailyResults.challengeDate));

    const byDate = new Map(rows.map((row) => [String(row.challengeDate), row]));

    return NextResponse.json({
      success: true,
      data: {
        pro: true,
        locked: false,
        today,
        days: keys.map((dateKey) => {
          const row = byDate.get(dateKey);
          return {
            dateKey,
            completed: row?.completed === true,
            moves: Number(row?.moves) || 0,
            elapsedMs: Number(row?.elapsedMs) || 0,
          };
        }),
      },
    });
  } catch (error) {
    console.error(
      "[solitaire] daily archive failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { success: false, error: "Could not load the archive" },
      { status: 500 },
    );
  }
}
