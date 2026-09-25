// POST — create a free human-vs-AI Memory Grid match.
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
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

export async function POST(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  // The lobby's AI-difficulty pick travels in the body. An absent/invalid
  // value coerces to `normal` in the store, so older clients keep working.
  let body = {};
  try {
    if (req?.headers?.get("content-type")?.includes("application/json")) {
      body = (await req.json()) || {};
    }
  } catch {
    body = {};
  }

  try {
    const result = await createAiMatch({ userId, difficulty: body?.difficulty });
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
