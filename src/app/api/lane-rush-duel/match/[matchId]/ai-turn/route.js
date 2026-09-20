// src/app/api/lane-rush-duel/match/[matchId]/ai-turn/route.js
//
// POST — execute the practice bot's turn (mirrors the PvP ai-turn
// /ai-turn pattern). The match page fires this when it's the bot's
// turn; the server store runs `decideBotAction` and applies the move
// through the same advance/resolve paths as a human. The bot picks
// tiles at random (same bust odds as a player) and decides when to
// HOLD based on the multiplier ladder and the chicken-game state.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { botAct } from "../../../../../../lib/lane-rush-duel/serverStore";
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

  // The client stamps each wake-up with a unique `actionId`, so a
  // retried request (or two poll effects firing for the same state)
  // resolves exactly one bot action instead of granting the bot a
  // second, extra turn.
  let body = null;
  try {
    body = await req.json();
  } catch (e) {
    body = null;
  }
  const actionId = body?.actionId ?? null;

  try {
    const result = await botAct({ matchId, requesterId: userId, actionId });

    if (result.error) {
      // 409 = not the bot's turn / window expired — benign races the
      // polling loop handles naturally, so return ok:false (the page
      // just re-polls instead of surfacing an error).
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

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

    broadcastMatchUpdate(matchId, {
      status: result.status,
      action: "bot",
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
    console.error("[lane-rush-duel/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
