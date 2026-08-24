// POST — run the server-controlled Blackjack AI for a free match.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { playAiTurn } from "../../../../../../lib/blackjack-pvp/serverStore";

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams.matchId);
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

    return NextResponse.json({
      success: true,
      data: {
        match: result.match,
        actions: Number(result.actions || 0),
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
