// src/app/api/dominoes/create-or-join/route.ts
//
// POST — match the caller into the oldest open Dominoes lobby, or open a new
// one. Thin wrapper: all matchmaking (advisory lock, `FOR UPDATE` candidate,
// joining, the deal) lives in the server store.
//
// GATED BY THE AGE-VERIFIED ACCOUNT GATE, like every other online duel: Dominoes
// is 1v1 only and has no guest seat, so online matchmaking always carries a
// real `user_…` identity (see src/lib/auth/requireAgeVerified.ts).
//
// THE REQUEST BODY IS IGNORED ENTIRELY. There is no stake to validate (Dominoes
// is unstaked by design), no seat to choose, no deal to send and no opponent to
// name: the store seats the caller and, when the second seat lands, mints the
// deal itself.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createOrJoin } from "../../../../lib/dominoes/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/dominoes/rooms";

export async function POST(_req: Request) {
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

    // Best-effort push so a host already on the match page flips
    // waiting → playing without waiting for the next read.
    broadcastMatchUpdate(result.match.id, {
      status: result.match.status,
      version: result.match.ply,
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
      errorType: "dominoes_create_or_join_error",
      errorMessage:
        error instanceof Error ? error.message : "Dominoes matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/dominoes/create-or-join",
      game: "Dominoes",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
