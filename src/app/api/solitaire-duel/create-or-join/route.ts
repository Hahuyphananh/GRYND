// src/app/api/solitaire-duel/create-or-join/route.ts
//
// POST — match the caller into an open Solitaire Duel lobby, or open a new one.
//
// Thin wrapper, exactly like every other game's: ALL matchmaking (the per-game
// advisory lock, the `FOR UPDATE` candidate, the conditional claim) lives in
// `createOrJoin` in src/lib/solitaire-duel/serverStore.ts, and NOTHING about the
// puzzle is decided here.
//
// Ranked Solitaire is FREE. A match carries no stake, no escrow, no pot and no
// payout; the competitive reward is the shared Elo rating and trophies. The
// store already treats a zero stake as free play, and this route never reads a
// client-supplied stake at all.

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
    const result = await createOrJoin({ userId, stake: 0 });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    const matchId = result.match.id;
    const goAtMs = result.match.goAt ? new Date(result.match.goAt).getTime() : null;

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
        countdownMs: READY_COUNTDOWN_MS,
      });
      broadcastMatchEvent(matchId, SOLITAIRE_DUEL_EVENTS.MATCH_STARTED, {
        goAtMs,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        status: result.match.status,
        joined: result.joined,
        goAtMs,
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
