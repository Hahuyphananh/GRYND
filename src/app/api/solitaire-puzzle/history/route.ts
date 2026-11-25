// src/app/api/solitaire-puzzle/history/route.ts
//
// GET — the caller's settled Puzzle Ranked matches.
//
// Each entry is built from the caller's OWN stored seat plus the result that is
// already public to both participants: puzzles solved by each seat, the
// server-stamped final-solve instants, the result, and the caller's own applied
// rating/trophy deltas (read from the shared journals). It never carries a
// start state, a stock order, a solution, the opponent's board or the
// opponent's private progression.
//
// History lives in the SAME source of truth the rest of the platform reads: the
// settled session row plus `rating_events` / `trophy_events`, so Puzzle Ranked
// results appear consistently without a second competitive record.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { getSeatIdentity } from "../../../../lib/seatIdentity";
import { listPuzzleRankedHistory } from "../../../../lib/solitaire-puzzle/serverStore";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const limitRaw = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, limitRaw) : 20;

  try {
    const entries = await listPuzzleRankedHistory({ userId, limit });

    // Opponent identity is an ADORNMENT (name/icon): a failure here must never
    // fail the history payload, and it is resolved through the platform's own
    // seat resolver so nothing but public profile chrome is exposed.
    const items = await Promise.all(
      entries.map(async (entry) => {
        let opponent = null;
        if (entry.opponentId) {
          try {
            const seats = await getSeatIdentity(entry.opponentId, null);
            opponent = seats?.player1 ?? null;
          } catch {
            opponent = null;
          }
        }
        return { ...entry, opponent };
      }),
    );

    return NextResponse.json({ success: true, data: { items, limit } });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_history_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle Ranked history failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/history",
      game: "Puzzle Ranked",
      metadata: { operation: "history" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
