// POST — create a free human-vs-AI Memory Grid match.
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createAiMatch } from "../../../../lib/memory-grid/serverStore";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    isAi: Boolean(match.isAi),
    phase: match.phase,
    roundNumber: Number(match.roundNumber || 1),
    roundDeadline: match.roundDeadline,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
  };
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const result = await createAiMatch({ userId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }
    return NextResponse.json({
      success: true,
      data: { match: normaliseMatch(result.match), joined: true },
    });
  } catch (error) {
    console.error("[memory-grid/create-ai] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
