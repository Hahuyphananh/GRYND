// POST — submit the server-controlled Mines Duel AI's turn.
// Called after the human acts (server-side, inline in the pick/flag routes)
// and as a recovery fallback from the client.
//
// AUTHORITY: the bot is not a client. It plays through the SAME
// `playAiTurn` → `pickTile` → `applyPick` pipeline a human uses, so it gets
// the same turn enforcement, row lock, first-pick mercy, sudden-death mine
// handling and `winReason` stamping. There is deliberately no separate rules
// engine for the AI.
//
// VISIBILITY: the response is the same viewer-shaped payload the match GET
// returns (`normaliseMatchForViewer`) — never the raw row. The raw row carries
// the hidden `board` (the mine layout) and every reveal's real `isMine`
// verdict, so echoing it here would hand an AI-match player the solution
// mid-game.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { playAiTurn } from "../../../../../../lib/mines-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";
import { normaliseMatchForViewer } from "../../../../../../lib/mines-pvp/matchView";

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

  try {
    const result = await playAiTurn({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push to the match room so any viewer of this match (the
    // human, or a spectator on the same room) refetches authoritative state
    // instead of waiting for the next poll. Same event the pick/flag routes
    // emit; no new realtime mechanism.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      currentTurnUserId: result.match?.currentTurnUserId ?? null,
      roundDeadline: result.match?.roundDeadline ?? null,
      justResolved: Boolean(result.justResolved),
      aiTurn: true,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForViewer(result.match, userId),
        justResolved: Boolean(result.justResolved),
        alreadyPlayed: Boolean(result.alreadyPlayed),
      },
    });
  } catch (error) {
    console.error("[mines-pvp/ai-turn] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
