// GET /api/streaks/competitive — the signed-in player's current and best
// ranked win streak for BOTH competitive ladders, read from the authoritative
// `user_competitive_streaks` rows.
//
// Read-only. The only writer remains `recordCompetitiveResult`, called inside
// the solitaire-duel / solitaire-puzzle settlement transactions. Signed-out
// callers get a 200 with empty values so the result/profile surface can stay
// quiet instead of treating a normal state as an error.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import {
  COMPETITIVE_STREAK_GAME_KEYS,
  normalizeCompetitiveStreaks,
} from "../../../../lib/competitiveStreakModel";
import { readCompetitiveStreaksForClerkId } from "../../../../lib/competitiveStreak";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({
      success: true,
      signedIn: false,
      streaks: normalizeCompetitiveStreaks([], COMPETITIVE_STREAK_GAME_KEYS),
    });
  }

  try {
    const streaks = await readCompetitiveStreaksForClerkId(userId);
    return NextResponse.json({ success: true, signedIn: true, streaks });
  } catch (error) {
    console.error("Error reading competitive streaks:", error);
    // A missing migration/table must not turn a result screen into an error.
    return NextResponse.json({
      success: true,
      signedIn: true,
      streaks: normalizeCompetitiveStreaks([], COMPETITIVE_STREAK_GAME_KEYS),
    });
  }
}
