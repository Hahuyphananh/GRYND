// POST — let the server-controlled Mines Duel bot take its next action(s).
// Called after the human acts (inline in the pick/flag routes) and as a
// recovery fallback from the client's poll.
//
// AUTHORITY: the bot is not a client. It plays SIMULTANEOUSLY on its OWN
// seat-2 board through the SAME `playAiTurn` → `applyReveal` / `applyFlag`
// pipeline a human uses (reveal the safest cell, or flag a mine it can prove
// from its own clues), so it gets the same row lock, server-minted scoring,
// completion handling and `winReason` stamping. There is deliberately no
// separate rules engine for the AI.
//
// FAIRNESS: the bot only ever reads its own revealed clues and its own flag
// set — never the human's board or the hidden layout — exactly the
// information a human seat holds. See `chooseAiActionForSeat`.
//
// VISIBILITY: the response is the same viewer-shaped payload the match GET
// returns (`normaliseMatchForViewer`) — never the raw row. The raw row carries
// the hidden boards (`p1_board` / `p2_board`) and every reveal's real `isMine`
// verdict, so echoing it here would hand an AI-match player the solution
// mid-game.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { playAiTurn } from "../../../../../../lib/mines-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";
import { normaliseMatchForViewer } from "../../../../../../lib/mines-pvp/matchView";

export async function POST(req, { params }) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;

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
      matchDeadline: result.match?.matchDeadline ?? null,
      p1Score: Number(result.match?.p1Score) || 0,
      p2Score: Number(result.match?.p2Score) || 0,
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
