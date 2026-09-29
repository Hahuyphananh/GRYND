// src/app/api/speed-typing/create-or-join/route.ts
//
// POST — match the caller into an open Speed Typing lobby, or open a new one.
//
// Thin wrapper, exactly like every other game's: ALL matchmaking (the per-game
// advisory lock, the `FOR UPDATE` candidate, the conditional claim) lives in
// `createOrJoin` in src/lib/speed-typing/serverStore.ts. This route's only jobs
// are authenticating the caller and returning the destination to navigate to.
//
// The realtime push is a best-effort notification, never a state transfer: the
// match view joins `speed-typing:match:<id>` on mount and re-fetches the
// authoritative snapshot, so a missed push costs a poll tick and nothing else.
// When this call is the one that fills the second seat the race is ARMED, so
// the absolute GO instant is broadcast here as both the countdown and the start
// signal. That instant is the server's (`armedRaceValues`), which is what keeps
// both seats counting to one clock.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createOrJoin } from "../../../../lib/speed-typing/serverStore";
import { RACE_COUNTDOWN_MS } from "../../../../lib/speed-typing/constants";
import {
  SPEED_TYPING_EVENTS,
  broadcastMatchEvent,
  broadcastMatchUpdate,
} from "../../../../lib/speed-typing/realtime";

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

    // Best-effort: the caller's own seat is told the lobby changed, and — when
    // this call armed the race — both seats get the server's GO instant.
    const matchId = result.match.id;
    const goAt = result.match.goAt ? new Date(result.match.goAt).getTime() : null;
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      joined: result.joined === true,
    });
    if (goAt != null && Number.isFinite(goAt)) {
      broadcastMatchEvent(matchId, SPEED_TYPING_EVENTS.COUNTDOWN, {
        goAtMs: goAt,
        countdownMs: RACE_COUNTDOWN_MS,
      });
      broadcastMatchEvent(matchId, SPEED_TYPING_EVENTS.MATCH_STARTED, { goAtMs: goAt });
    }

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
      errorType: "speed_typing_create_or_join_error",
      errorMessage:
        error instanceof Error
          ? error.message
          : "Speed Typing matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/speed-typing/create-or-join",
      game: "Speed Typing",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
