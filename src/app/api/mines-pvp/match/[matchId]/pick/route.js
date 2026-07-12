// src/app/api/mines-pvp/match/[matchId]/pick/route.js
//
// POST — submit a per-match tile pick. Server-side authoritative:
//   • turn enforcement (currentTurnUserId must match caller)
//   • cellIndex 0-24 row-major validation
//   • rejects duplicate picks (own + opponent's)
//   • rejects post-deadline (server-side AFK auto-pick fires from
//     /status poll instead, so the client just has to wait for the
//     next poll to see the new state)
//
// The route is intentionally thin: it forwards (cellIndex) to
// `pickTile` in the server store, which performs:
//   • participant + active-state validation
//   • FOR UPDATE row lock so two parallel pickTile calls can't race
//   • conditional UPDATE on `match.status` to refuse stale POSTs
//   • synchronous state advancement (p1 → p2, p2 → finished)
//
// Anti-cheat considerations baked into `pickTile`:
//   * only the player whose turn it is can pick (server-trusted
//     clerkId from Clerk's `auth()`)
//   * the board column is never exposed mid-match (scrubbed at the
//     /status response layer)
//   * a stale submission (post-deadline) is rejected with 400 so
//     the client knows to wait for the next poll to trigger the
//     server-side AFK auto-pick
//   * duplicate picks are rejected with 409 (Cell already picked)

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { pickTile } from "../../../../../../lib/mines-pvp/serverStore";
import { GRID_CELLS } from "../../../../../../lib/mines-pvp/constants";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";

function normalisePickResult(match) {
  if (!match) return null;
  // Only return the cellIndex of each pick (not pickIsMine) so the
  // POST response can't leak the board state. The full reveal
  // comes from the subsequent /status poll (where viewer-aware
  // scrubbing governs visibility per the spec).
  return {
    id: match.id,
    status: match.status,
    p1Pick: match.p1Pick ?? null,
    p2Pick: match.p2Pick ?? null,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
  };
}

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Next.js 15+/16: API route `params` is a Promise — must await before
  // reading properties. Accessing it synchronously yields `undefined`,
  // which `Number(undefined)` coerces to `NaN`, which the finite-check
  // below rejects with "Invalid matchId" — masking the real match and
  // silently dropping the pick submission. Same fix applied to the
  // roulette-pvp and blackjack-pvp match routes.
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
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const cellIndex = Number(body?.cellIndex);
  if (
    !Number.isInteger(cellIndex) ||
    cellIndex < 0 ||
    cellIndex >= GRID_CELLS
  ) {
    return NextResponse.json(
      {
        success: false,
        error: `cellIndex must be an integer in [0, ${GRID_CELLS - 1}]`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await pickTile({ userId, matchId, cellIndex });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push to the match room so the opponent sees the
    // pick without waiting for the 1.5s poll. The helper internally
    // handles the no-op case when the realtime-server runs in a
    // separate process.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      justResolved: Boolean(result.justResolved),
    });

    return NextResponse.json({
      success: true,
      data: {
        match: normalisePickResult(result.match),
        justResolved: Boolean(result.justResolved),
        raced: Boolean(result.raced),
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match/pick] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
