// POST — create a free human-vs-AI Mines Duel match.
// No stake is escrowed; the match starts immediately in `ready`
// state with the bot in seat 2.
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { createAiMatch } from "../../../../lib/mines-pvp/serverStore";
import { MIN_MINES, MAX_MINES } from "../../../../lib/mines-pvp/constants";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    minesCount: match.minesCount,
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
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

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const minesCount = Number(body?.minesCount ?? 3);
  if (!Number.isInteger(minesCount) || minesCount < MIN_MINES || minesCount > MAX_MINES) {
    return NextResponse.json(
      {
        success: false,
        error: `Mines count must be an integer in [${MIN_MINES}, ${MAX_MINES}]`,
      },
      { status: 400 },
    );
  }

  try {
    // `difficulty` is the lobby picker's tier; the store coerces it (absent
    // or invalid → normal), so an older client still creates a match.
    const result = await createAiMatch({
      userId,
      minesCount,
      difficulty: body?.difficulty,
    });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(result.match),
        joined: true,
      },
    });
  } catch (error) {
    console.error("[mines-pvp/create-ai] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
