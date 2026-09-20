// src/app/api/lane-rush-duel/match/[matchId]/act/route.js
//
// POST — perform a row action: pick a tile (`action: "pick"` with
// `tileIndex`), flag a tile (`action: "flag"`), peek (`action:
// "peek"`) or bank your run (`action: "hold"`). The server store
// validates the action inside one row-locked transaction and applies
// it through the single authoritative transition.
//
// The client stamps every action with:
//   * `actionId` — a unique id, so a retried POST is an idempotent
//     no-op instead of a second resolution (double points / double
//     bust) — and
//   * `round` — the lane the click was rendered against, so a stale
//     click is rejected instead of resolving on a row the player
//     never saw.

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
  const path = String(body?.path || "");
  const tileIndex = body?.tileIndex;
  const actionId = body?.actionId ?? null;
  const round = body?.round ?? null;

  try {
    const result = await act({
      userId,
      matchId,
      action,
      path,
      tileIndex,
      actionId,
      round,
    });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
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

    // Best-effort live push to the per-match room so the opponent's
    // status poll fires inside ~50ms instead of waiting 1.5s.
    broadcastMatchUpdate(matchId, {
      status: result.status,
      action,
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
