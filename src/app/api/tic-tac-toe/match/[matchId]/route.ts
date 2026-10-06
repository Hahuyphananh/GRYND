// src/app/api/tic-tac-toe/match/[matchId]/route.ts
//
// GET — the authoritative match state for the calling participant.
//
// The response is the viewer-projected DTO from the pure rules engine
// (`normalizeForViewer`), so the client never has to re-derive whose turn it is
// or whether the match is over. Non-participants get a 403 — Tic-Tac-Toe has no
// spectator mode.
//
// There is no clock and no deadline resolution: a read can never change the
// match state, so this route is a pure projection.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../lib/auth/guestSession";
import { logError } from "../../../../../lib/logError";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  fetchMatch,
  fetchMatchMoves,
  isMatchId,
} from "../../../../../lib/tic-tac-toe/serverStore";

function normaliseMove(row: {
  ply: number;
  playerId: string;
  boardIndex: number;
  cellIndex: number;
  createdAt: unknown;
}) {
  return {
    ply: row.ply,
    playerId: row.playerId,
    // Slot 0..8, or -1 for the sudden-death board.
    boardIndex: Number(row.boardIndex),
    cellIndex: Number(row.cellIndex),
    createdAt: row.createdAt,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await fetchMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    const match = result.match;

    // Move history + seat identity are adornments: a failure here must not
    // fail the match payload.
    let moves: unknown[] = [];
    try {
      const rows = await fetchMatchMoves(matchId);
      moves = rows.map(normaliseMove);
    } catch {
      moves = [];
    }

    let players = null;
    try {
      players = await getSeatIdentity(match.player1Id, match.player2Id ?? null);
    } catch {
      players = null;
    }

    return NextResponse.json({
      success: true,
      data: {
        matchId: match.id,
        ...result.dto,
        // Read-only timestamps for the client's result screen (match duration).
        // They carry no rules and cannot influence the board, the turn or the
        // outcome — `matchToDto` stays exactly as the store defines it.
        startedAt: match.startedAt ?? null,
        endedAt: match.endedAt ?? null,
        players,
        moves,
      },
    });
  } catch (error) {
    await logError({
      errorType: "tic_tac_toe_match_fetch_error",
      errorMessage:
        error instanceof Error ? error.message : "Tic-Tac-Toe match fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tic-tac-toe/match/[matchId]",
      game: "Tic-Tac-Toe",
      metadata: { operation: "fetch_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
