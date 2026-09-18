// POST — submit the deterministic AI launch for the current Plinko ball.
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { playAiTurn } from "../../../../../../lib/plinko-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/plinko-pvp/rooms";

export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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

    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      aiTurn: true,
      justResolved: Boolean(result.justResolved),
    });

    // Do not return the raw match row because it contains the bot's
    // committed inputs. The normal match GET remains the visibility gate.
    return NextResponse.json({
      success: true,
      data: {
        match: result.match
          ? {
              id: result.match.id,
              status: result.match.status,
              currentBall: Number(result.match.currentBall || 1),
            }
          : null,
        justResolved: Boolean(result.justResolved),
        alreadyPlayed: Boolean(result.alreadyPlayed),
      },
    });
  } catch (error) {
    console.error("[plinko-pvp/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
