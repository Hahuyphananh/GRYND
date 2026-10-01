// src/app/api/sudoku-duel/available/route.ts
//
// GET — open Sudoku Duel lobbies for the lobby screen. Read-only; the lobby list
// is cheap to refetch, so there is no socket fan-out here (matching the Mini Golf
// / Tic-Tac-Toe polling model).
//
// The payload is deliberately narrow: a waiting lobby is visible to anyone, so it
// exposes only its id, its difficulty and when it was opened — no puzzle, no
// board, no solution, no seed and no player id.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { lobbyEntry, listOpenMatches } from "../../../../lib/sudoku-duel/serverStore";

export async function GET() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  try {
    const rows = await listOpenMatches({ limit: 30 });
    const data = rows.map((row) => {
      const entry = lobbyEntry(row);
      return {
        matchId: entry.matchId,
        variant: entry.variant,
        difficulty: entry.difficulty,
        givens: entry.givens,
        status: entry.status,
        createdAt: row.createdAt,
      };
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    await logError({
      errorType: "sudoku_duel_available_error",
      errorMessage: error instanceof Error ? error.message : "Sudoku Duel lobby listing failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/sudoku-duel/available",
      game: "Sudoku Duel",
      metadata: { operation: "list_open_matches" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
