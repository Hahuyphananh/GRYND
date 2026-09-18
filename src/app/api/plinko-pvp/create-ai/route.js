// POST — create a free human-vs-AI Plinko Duel match.
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { createAiMatch, enrichMatchesWithUsers } from "../../../../lib/plinko-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/plinko-pvp/rooms";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentBall: Number(match.currentBall || 1),
    roundDeadline: match.roundDeadline,
    roundTimer: Number(match.roundTimerSeconds || 20),
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
  };
}

export async function POST(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  // Keep this endpoint JSON-compatible with the app API proxy/content
  // validation, even though the AI match currently needs no options.
  try {
    if (req?.headers?.get("content-type")?.includes("application/json")) {
      await req.json();
    }
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
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

    let match = result.match;
    try {
      match = await enrichMatchesWithUsers(match);
    } catch {
      // Player-name enrichment is best-effort; the match remains usable.
    }
    broadcastMatchUpdate(match.id, { status: match.status, created: true, isAi: true });

    return NextResponse.json({
      success: true,
      data: { match: normaliseMatch(match), joined: true },
    });
  } catch (error) {
    console.error("[plinko-pvp/create-ai] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
