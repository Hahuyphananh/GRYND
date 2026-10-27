// src/app/api/hillstrike/create-or-join/route.ts
//
// POST — match the caller into the oldest open Hillstrike lobby, or open a new
// one. Thin wrapper: all matchmaking (advisory lock, FOR UPDATE candidate,
// joining, seed draw, initial battlefield) lives in the server store.
//
// GATED BY THE AGE-VERIFIED ACCOUNT GATE, deliberately not by the guest-capable
// practice gate: Hillstrike's free vs-AI board is entirely client-side and needs
// no account, while ONLINE matchmaking always carries a real, age-verified
// `user_…` seat.
//
// Hillstrike online is UNSTAKED: the body carries nothing but the CLOCK the
// caller wants (5 / 10 / 15 minutes), and no wager, pot or escrow exists anywhere
// on this path. Matchmaking only pairs callers who asked for the same clock, so
// the two seats always play the same timed match.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createOrJoin } from "../../../../lib/hillstrike/serverStore";
import { broadcastMatchUpdate } from "../../../../lib/hillstrike/rooms";
import { isMatchDurationMs } from "../../../../lib/hillstrike/constants";

export async function POST(req: Request) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  // The clock is the only thing the lobby sends. A body-less request (an older
  // tab) is accepted with the default clock.
  let durationMs: unknown = undefined;
  try {
    const body = (await req.json()) as Record<string, unknown> | null;
    if (body && body.durationMs !== undefined) durationMs = body.durationMs;
  } catch {
    durationMs = undefined;
  }
  if (durationMs !== undefined && !isMatchDurationMs(durationMs)) {
    return NextResponse.json(
      { success: false, error: "Unknown match duration" },
      { status: 400 },
    );
  }

  try {
    const result = await createOrJoin({ userId, durationMs });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Best-effort push so a host already waiting flips waiting → playing
    // without waiting for the next poll.
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
        durationMs: Number(result.match.durationMs),
      },
    });
  } catch (error) {
    await logError({
      errorType: "hillstrike_create_or_join_error",
      errorMessage:
        error instanceof Error ? error.message : "Hillstrike matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/hillstrike/create-or-join",
      game: "Hillstrike",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
