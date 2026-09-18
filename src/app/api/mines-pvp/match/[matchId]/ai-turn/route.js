// POST — submit the server-controlled Mines Duel AI's pick.
// Called after the human picks (server-side) and as a recovery
// fallback from the client.
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { playAiTurn } from "../../../../../../lib/mines-pvp/serverStore";

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
    return NextResponse.json({
      success: true,
      data: {
        match: result.match,
        justResolved: Boolean(result.justResolved),
        alreadyPlayed: Boolean(result.alreadyPlayed),
      },
    });
  } catch (error) {
    console.error("[mines-pvp/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
