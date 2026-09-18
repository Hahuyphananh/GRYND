// POST — run the server-controlled Memory Grid AI reconstruction when due.
import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { playAiTurn } from "../../../../../../lib/memory-grid/serverStore";

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
    const match = result.match || null;
    // Never return the raw match row here: it contains the hidden
    // server board and seed. The client follows with a normal status
    // fetch, which applies the regular viewer-scrubbing rules.
    return NextResponse.json({
      success: true,
      data: {
        match: match
          ? {
              id: match.id,
              status: match.status,
              phase: match.phase,
              roundNumber: Number(match.roundNumber || 1),
              p1Submitted: Boolean(match.p1Submitted),
              p2Submitted: Boolean(match.p2Submitted),
            }
          : null,
        justResolved: Boolean(result.justResolved),
        alreadyPlayed: Boolean(result.alreadyPlayed),
        waiting: Boolean(result.waiting),
      },
    });
  } catch (error) {
    console.error("[memory-grid/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
