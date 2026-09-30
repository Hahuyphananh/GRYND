// src/app/api/tic-tac-toe/create-or-join/route.ts
//
// POST — match the caller into an open Tic-Tac-Toe lobby, or open a new one.
//
// Thin wrapper: all matchmaking (advisory lock, FOR UPDATE candidate, joining,
// initial state) lives in the server store. The response is just the
// destination the client should navigate to.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createOrJoin } from "../../../../lib/tic-tac-toe/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/tic-tac-toe/rooms";

export async function POST() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  try {
    const result = await createOrJoin({ userId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    // Best-effort push so a player already on the match page flips
    // waiting → playing without waiting for the next poll (silently no-ops in
    // split-process deploys; the client poll covers that case).
    broadcastMatchUpdate(result.match.id, {
      status: result.match.status,
      joined: result.joined,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        status: result.match.status,
        joined: result.joined,
      },
    });
  } catch (error) {
    await logError({
      errorType: "tic_tac_toe_create_or_join_error",
      errorMessage:
        error instanceof Error ? error.message : "Tic-Tac-Toe matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tic-tac-toe/create-or-join",
      game: "Tic-Tac-Toe",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
