// src/app/api/barricade/create-or-join/route.ts
//
// POST — match the caller into the oldest open Barricade lobby, or open a new
// one. Thin wrapper: all matchmaking (advisory lock, FOR UPDATE candidate,
// joining, initial state) lives in the server store.
//
// GATED BY THE AGE-VERIFIED ACCOUNT GATE, deliberately not by the guest-capable
// practice gate: Barricade's guest policy is the platform's — a signed-out
// visitor plays the free vs-AI practice board (which is entirely client-side and
// has no API), while ONLINE matchmaking always carries a real, age-verified
// `user_…` seat (see src/lib/auth/guestSession.ts and migration 0206).

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createOrJoin } from "../../../../lib/barricade/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/barricade/rooms";

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

    // Best-effort push so a host already on the match page flips
    // waiting → playing without waiting for the next poll.
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
      errorType: "barricade_create_or_join_error",
      errorMessage:
        error instanceof Error ? error.message : "Barricade matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/barricade/create-or-join",
      game: "Barricade",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
