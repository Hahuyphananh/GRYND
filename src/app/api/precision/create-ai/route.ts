import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { armMatchRound, PRECISION_AI_USER_ID, precisionMatchStore } from "../../../../lib/precision/serverStore";
import { makeInitialMatch } from "../../../../lib/precision/matchmaking";
import type { PrecisionPlayer } from "../../../../lib/precision/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    await req.json().catch(() => ({}));

    const matchId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const players: PrecisionPlayer[] = [
      {
        seat: 1,
        userId,
        name: "You",
        isReady: true,
        isConnected: true,
      },
      {
        seat: 2,
        userId: PRECISION_AI_USER_ID,
        name: "GRYND AI",
        isReady: true,
        isConnected: true,
      },
    ];
    const match = makeInitialMatch(matchId, 0, players, "ready_up", 1, true);
    precisionMatchStore.set(matchId, match);
    armMatchRound(matchId);

    return NextResponse.json({ success: true, matchId });
  } catch (error) {
    console.error("[precision/create-ai] error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to create AI match" },
      { status: 500 },
    );
  }
}
