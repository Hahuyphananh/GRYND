// POST — run due server-controlled Keno AI catches for a free match.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { playAiTurn } from "../../../../../../lib/keno-pvp/serverStore";

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await playAiTurn({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Do not return the raw match row: it contains the live opponent
    // ticket. The normal match GET applies viewer-aware scrubbing.
    const match = result.match || null;
    return NextResponse.json({
      success: true,
      data: {
        match: match
          ? {
              id: match.id,
              status: match.status,
              currentRound: Number(match.currentRound || 1),
              actions: Number(result.actions || 0),
            }
          : null,
        actions: Number(result.actions || 0),
        alreadyPlayed: Boolean(result.alreadyPlayed),
      },
    });
  } catch (error) {
    console.error("[keno-pvp/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
