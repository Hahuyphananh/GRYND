// src/app/api/mines-pvp/match/[matchId]/pick/route.js
//
// POST — reveal a tile on the CALLER'S OWN board. Simultaneous play: both
// seats may post at any time while the match is `active`, the 180s server
// timer has not expired, and their own board is not completed/locked. There
// are no turns and no shared board.
//
// The route is intentionally thin: it forwards (cellIndex) to `pickTile` in
// the server store, which performs:
//   • participant + active-state validation
//   • FOR UPDATE row lock so two parallel pickTile calls can't race
//   • conditional UPDATE on `match.status` to refuse stale POSTs
//   • server-minted scoring (safe +5 / mine −25, clamped) and completion
//
// Anti-cheat considerations baked into `pickTile`:
//   * the acting seat is derived from the authenticated user, never the body
//   * the board column is never exposed mid-match (scrubbed at the
//     /status response layer); only the caller's own reveal is known
//   * a submission after the match timer expires is rejected with 400
//   * a duplicate reveal (same cell twice / a confirmed mine) is rejected 409

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { pickTile } from "../../../../../../lib/mines-pvp/serverStore";
import { GRID_CELLS } from "../../../../../../lib/mines-pvp/constants";
import {
  broadcastMatchUpdate,
  broadcastScoreEvent,
} from "../../../../../../lib/mines-pvp/rooms";

function normalisePickResult(match, userId) {
  if (!match) return null;
  // Return ONLY server-derived state for the acting seat. The board, the
  // mine positions and the mine VALUES are never sent. The full per-viewer
  // payload comes from the subsequent /status poll.
  const viewerSeat = match.player1Id === userId ? "player1" : "player2";
  const mineHit =
    viewerSeat === "player1"
      ? Number(match.p1MinesHit) > 0
      : Number(match.p2MinesHit) > 0;
  return {
    id: match.id,
    status: match.status,
    myScore: Number(viewerSeat === "player1" ? match.p1Score : match.p2Score) || 0,
    opponentScore:
      Number(viewerSeat === "player1" ? match.p2Score : match.p1Score) || 0,
    myCompleted: Boolean(
      viewerSeat === "player1" ? match.p1Completed : match.p2Completed,
    ),
    myLocked: Boolean(viewerSeat === "player1" ? match.p1Locked : match.p2Locked),
    myMinesHit:
      Number(viewerSeat === "player1" ? match.p1MinesHit : match.p2MinesHit) || 0,
    matchDeadline: match.matchDeadline ?? null,
    winnerId: match.winnerId ?? null,
    winReason: match.winReason ?? null,
  };
}

export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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

    // Best-effort push to the match room so the opponent refetches the
    // authoritative per-viewer snapshot immediately (no turns, simultaneous
    // play). The `lobby:updated` hint never carries board data — the listener
    // re-reads `/status`. The score event is cosmetic only (score animations)
    // and is recomputed server-side on the refetch. Both helpers no-op when
    // the realtime-server runs in a separate process, in which case the
    // client relay + poll cover it.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      matchDeadline: result.match?.matchDeadline ?? null,
      p1Score: Number(result.match?.p1Score) || 0,
      p2Score: Number(result.match?.p2Score) || 0,
      winnerId: result.match?.winnerId ?? null,
      winReason: result.match?.winReason ?? null,
      justResolved: Boolean(result.justResolved),
    });
    broadcastScoreEvent(matchId, {
      seat: result.seat ?? null,
      delta: Number(result.scoreDelta) || 0,
      reason: result.scoreReason ?? null,
    });

    // Server-side AI trigger: if the match is a free AI game and the
    // human just picked, trigger the bot's response so it plays
    // immediately rather than waiting for the next status poll.
    if (result.match?.isAi && !result.justResolved) {
      try {
        const { playAiTurn } = await import("../../../../../../lib/mines-pvp/serverStore");
        await playAiTurn({ userId: result.match.player1Id, matchId });
      } catch (aiErr) {
        // Best-effort: if the AI turn fails, the status poll will
        // retry. Never let a bot error break the human's pick.
        console.error("[mines-pvp/pick] AI turn trigger failed:", aiErr);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normalisePickResult(result.match, userId),
        justResolved: Boolean(result.justResolved),
        // Caller-only feedback: true when this reveal detonated a mine, and
        // whether it cleared (and therefore locked) the caller's board.
        revealedMine: Boolean(result.revealedMine),
        completed: Boolean(result.completed),
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
