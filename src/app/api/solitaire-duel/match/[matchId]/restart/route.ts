// src/app/api/solitaire-duel/match/[matchId]/restart/route.ts
//
// POST — abandon a PRACTICE match and deal a fresh one.
//
// "Start over with a different deal." The old row is cancelled (it settles
// nothing at all) and a new practice match is minted from a fresh server seed,
// so the new puzzle is a genuinely different deal. The route is a thin wrapper:
// every rule — the caller must own the row, the row must be `isAi`, the old row
// is cancelled without a queue mirror or a settlement — lives in
// `restartAiMatch` in src/lib/solitaire-duel/serverStore.ts.
//
// A RATED duel cannot be restarted. Discarding a bad board at will would make
// the race meaningless, so a rated player's only exits remain a resign (which
// loses) and the ordinary rematch from the result screen.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import { isMatchId, restartAiMatch } from "../../../../../../lib/solitaire-duel/serverStore";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
  }

  // The only client-authored value is the bot tier, and only to carry the
  // player's existing choice across the restart. Anything unrecognised coerces
  // onto the shared scale inside the store.
  const body = (await req.json().catch(() => ({}))) as { difficulty?: unknown };

  try {
    const result = await restartAiMatch({
      userId,
      matchId,
      difficulty: body?.difficulty,
    });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        status: result.match.status,
        practice: true,
        aiDifficulty: result.match.aiDifficulty ?? null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_restart_error",
      errorMessage: error instanceof Error ? error.message : "Solitaire Duel restart failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]/restart",
      game: "Solitaire Duel",
      metadata: { operation: "restart_ai" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
