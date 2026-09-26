// src/app/api/mini-golf/match/[matchId]/route.ts
//
// GET — the authoritative match state for the calling participant.
//
// The response is the viewer-projected DTO from the pure rules engine
// (`normalizeForViewer`), so the client never has to re-derive turn or
// hole-complete flags. Non-participants get a 403 — Mini Golf has no
// spectator mode.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  fetchMatch,
  fetchMatchShots,
  isMatchId,
} from "../../../../../lib/mini-golf/serverStore";

function normaliseShot(row: {
  shotSeq: number;
  holeNumber: number;
  playerId: string;
  strokeNumber: number;
  angle: unknown;
  power: unknown;
  result: unknown;
  createdAt: unknown;
}) {
  return {
    shotSeq: row.shotSeq,
    holeNumber: row.holeNumber,
    playerId: row.playerId,
    strokeNumber: row.strokeNumber,
    angle: Number(row.angle),
    power: Number(row.power),
    result: row.result,
    createdAt: row.createdAt,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
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

    // Shot history + seat identity are adornments: a failure here must not
    // fail the match payload.
    let shots: unknown[] = [];
    try {
      const rows = await fetchMatchShots(matchId);
      shots = rows.map(normaliseShot);
    } catch {
      shots = [];
    }

    let players = null;
    try {
      players = await getSeatIdentity(
        result.match.player1Id,
        result.match.player2Id ?? null,
      );
    } catch {
      players = null;
    }

    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        ...result.dto,
        players,
        shots,
      },
    });
  } catch (error) {
    await logError({
      errorType: "mini_golf_match_fetch_error",
      errorMessage:
        error instanceof Error ? error.message : "Mini Golf match fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/mini-golf/match/[matchId]",
      game: "Mini Golf",
      metadata: { operation: "fetch_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
