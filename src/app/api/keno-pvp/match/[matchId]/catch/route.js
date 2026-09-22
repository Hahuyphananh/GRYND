// src/app/api/keno-pvp/match/[matchId]/catch/route.js
//
// POST — claim the live tile. The client sends the TILE NUMBER it tapped;
// the server checks it against the tile that is actually lit and grades
// the tap on the SERVER clock (a client can never self-report a claim):
//
//   * the first accepted tap wins the tile — the claimant's tile count
//     goes up and the opponent loses a life;
//   * a tap outside the tile's window is not a claim (and the tile is
//     resolved as a both-miss, so the match keeps moving);
//   * taps on any other tile are rejected — only the lit tile counts.
//
// The action keeps its historical path (`/catch`) because clients, the
// realtime server and the quest/analytics wiring all reference it.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { claimTile } from "../../../../../../lib/keno-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/keno-pvp/rooms";

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
  } catch {
    body = {};
  }

  // `tile` is the canonical field; `ball` is accepted as an alias so an
  // older cached client bundle cannot 400 mid-match during a deploy.
  const tile = body?.tile ?? body?.ball;
  if (tile === undefined || tile === null) {
    return NextResponse.json(
      { success: false, error: "Missing tile" },
      { status: 400 },
    );
  }

  try {
    const result = await claimTile({ userId, matchId, tile });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push so the opponent's board updates without waiting
    // for the next poll (they lost a life and a new tile is live).
    broadcastMatchUpdate(matchId, {
      claimed: true,
      tile: result.claim?.tile,
      seat: result.claim?.seat,
      finished: Boolean(result.finished),
    });

    return NextResponse.json({
      success: true,
      data: {
        claim: result.claim,
        // True when this claim ended the match (someone ran out of lives).
        finished: Boolean(result.finished),
        lives: {
          p1: Number(result.match?.p1Lives) || 0,
          p2: Number(result.match?.p2Lives) || 0,
        },
        tiles: {
          p1: Number(result.match?.p1Tiles) || 0,
          p2: Number(result.match?.p2Tiles) || 0,
        },
      },
    });
  } catch (error) {
    console.error("[keno-pvp/catch] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
