// src/app/api/solitaire-duel/create-or-join/route.ts
//
// POST — match the caller into an open Solitaire Duel lobby, or open a new one.
//
// Thin wrapper, exactly like every other game's: ALL matchmaking (the per-game
// advisory lock, the `FOR UPDATE` candidate, the conditional claim) lives in
// `createOrJoin` in src/lib/solitaire-duel/serverStore.ts, and NOTHING about the
// puzzle is decided here. The route's only jobs are authenticating the caller,
// returning the destination to navigate to, and — when this call filled the
// second seat — pushing the server's absolute GO instant so both seats count to
// one clock.
//
// There is no seed, no deal and no per-seat board in this file. The seed is
// minted once, server-side, when the lobby row is created (see
// `createWaitingMatch`), and the deal derived from it is already stored in BOTH
// seats' columns by the time this route returns.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createOrJoin } from "../../../../lib/solitaire-duel/serverStore";
import { READY_COUNTDOWN_MS } from "../../../../lib/solitaire-duel/constants";
import {
  SOLITAIRE_DUEL_EVENTS,
  broadcastMatchEvent,
  broadcastMatchUpdate,
} from "../../../../lib/solitaire-duel/rooms";

export async function POST() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  try {
    const result = await createOrJoin({ userId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    const matchId = result.match.id;
    const goAtMs = result.match.goAt ? new Date(result.match.goAt).getTime() : null;
    const deadlineAtMs = result.match.deadlineAt
      ? new Date(result.match.deadlineAt).getTime()
      : null;

    // Best-effort pushes. Both are notifications, never state transfers: the
    // match view joins `solitaire-duel:match:<id>` on mount and re-fetches the
    // authoritative snapshot, so a missed push costs a poll tick and nothing
    // else.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      joined: result.joined === true,
    });
    if (goAtMs != null && Number.isFinite(goAtMs)) {
      broadcastMatchEvent(matchId, SOLITAIRE_DUEL_EVENTS.COUNTDOWN, {
        goAtMs,
        deadlineAtMs,
        countdownMs: READY_COUNTDOWN_MS,
      });
      broadcastMatchEvent(matchId, SOLITAIRE_DUEL_EVENTS.MATCH_STARTED, {
        goAtMs,
        deadlineAtMs,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        status: result.match.status,
        joined: result.joined,
        goAtMs,
        deadlineAtMs,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_create_or_join_error",
      errorMessage:
        error instanceof Error ? error.message : "Solitaire Duel matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/create-or-join",
      game: "Solitaire Duel",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
