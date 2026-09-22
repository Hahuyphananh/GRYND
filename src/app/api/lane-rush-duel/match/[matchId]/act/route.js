// src/app/api/lane-rush-duel/match/[matchId]/act/route.js
//
// POST — a player action on the shared bridge:
//   * TILE SELECTION — `action: "jump"` (or the legacy alias `"pick"`) with the
//     `row` the player is standing on and the `tile` they chose; or
//   * MEMORY FLAG — `action: "flag"` with the `row`/`tile` of a tile THIS player
//     personally landed on safely (max 2 per match, public, append-only, and it
//     never consumes the turn).
// The server store validates the action inside one row-locked transaction and
// applies it through the single authoritative transition.
//
// The client stamps every action with:
//   * `actionId` — a unique id, so a retried POST is an idempotent
//     no-op instead of a second resolution (double advance / double
//     fall) — and
//   * `row` — the row the click was rendered against, so a stale click
//     is rejected instead of resolving on a row the player never saw.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { act } from "../../../../../../lib/lane-rush-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/lane-rush-duel/rooms";

export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  const resolvedParams = (await params) || {};
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const action = String(body?.action || "");
  // TILE SELECTION (`jump`) sends the `row` the player is standing on plus the
  // `tile` they chose; a MEMORY FLAG (`flag`) sends the row/tile to flag.
  const row = body?.row ?? null;
  const tile = body?.tile ?? null;
  const actionId = body?.actionId ?? null;

  try {
    const result = await act({ userId, matchId, action, row, tile, actionId });

    if (result.error) {
      // A tile that arrived after its 15s window still MOVED the match (the
      // attempt ended and the turn switched), so push it — otherwise the
      // opponent's board would wait for its next poll to see the timeout.
      if (result.timedOut) {
        broadcastMatchUpdate(matchId, {
          status: result.matchStatus,
          action: "timeout",
        });
      }
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          timedOut: result.timedOut === true,
        },
        { status: result.status || 400 },
      );
    }

    // A duplicate (already-resolved actionId) is a success no-op — the
    // action landed on the first attempt, so nothing changed and there
    // is nothing new to broadcast.
    if (result.duplicate) {
      return NextResponse.json({
        success: true,
        data: {
          status: result.status,
          duplicate: true,
          result: null,
          winnerId: null,
        },
      });
    }

    // Best-effort live push to the per-match room so BOTH seats' status poll
    // fires inside ~50ms instead of waiting for the 5s safety net.
    //
    // BROKEN-TILE UPDATE: a tile that was just stepped on stays broken for the
    // rest of the match and is public from that moment, so the exact tile rides
    // this existing event (null on a safe choice). The payload carries only
    // public information — the one tile that broke plus the public broken list —
    // never the bridge layout, and a safe tile is never revealed.
    broadcastMatchUpdate(matchId, {
      status: result.status,
      action,
      brokeTile: result.newlyBroken ? result.brokeTile : null,
      broken: Array.isArray(result.broken) ? result.broken : undefined,
      // MEMORY FLAGS are PUBLIC: a newly placed flag (null when this action was
      // a tile choice) plus both seats' full flag lists, so both players see it
      // immediately. Flags only ever mark a tile that seat landed on safely, so
      // nothing hidden is revealed by them.
      flagPlaced: result.flagPlaced ?? null,
      p1Flags: Array.isArray(result.p1Flags) ? result.p1Flags : undefined,
      p2Flags: Array.isArray(result.p2Flags) ? result.p2Flags : undefined,
    });

    return NextResponse.json({
      success: true,
      data: {
        status: result.status,
        duplicate: false,
        result: result.result ?? null,
        winnerId: result.winnerId ?? null,
      },
    });
  } catch (error) {
    console.error("[lane-rush-duel/act] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
