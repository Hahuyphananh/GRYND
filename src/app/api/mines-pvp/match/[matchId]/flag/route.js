// src/app/api/mines-pvp/match/[matchId]/flag/route.js
//
// POST — mark a tile on the CALLER'S OWN board as a suspected mine.
// Simultaneous play: both seats may flag at any time while the match is
// `active`, the 180s server timer has not expired, and their own board is not
// completed/locked. The two seats' flag sets are fully independent.
//   • A CORRECT flag awards the mine's own server-assigned value and resolves
//     that cell.
//   • A WRONG flag costs −10 (the marker is kept until the tile is revealed).
//   • Completing a board awards +100 and locks that seat only — it is NOT an
//     instant win; the opponent keeps playing to the clock.
//
// Thin mirror of the /pick route: forwards `{ cellIndex }` to `flagTile` in
// the server store, which performs the same validation chain as `pickTile`
// (participant + active state, FOR UPDATE row lock, conditional UPDATE on
// `match.status`, deadline freshness, cell-not-already-REVEALED,
// cell-not-already-claimed-by-you).
//
// Anti-cheat considerations baked into `flagTile`:
//   * the acting seat is derived from the authenticated user, never the body
//   * the board column is never exposed mid-match
//   * a submission after the match timer expires is rejected with 400
//   * flagging an already-REVEALED cell, or re-flagging a cell you
//     already claimed, is rejected with 409
//   * the mine VALUE is minted from the server board — never sent by a client
//
// The POST response returns the caller's OWN updated flag set plus the
// server-computed verdict. The opponent's flag locations and the hidden board
// are never sent; the subsequent /status poll carries the full per-viewer
// snapshot.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { flagTile } from "../../../../../../lib/mines-pvp/serverStore";
import { broadcastScoreEvent } from "../../../../../../lib/mines-pvp/rooms";
import {
  GRID_CELLS,
  correctFlagsForSeat,
  flagsForSeat,
  normalizeFlags,
} from "../../../../../../lib/mines-pvp/constants";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";

function normaliseFlagResult(match, userId) {
  if (!match) return null;
  // Return structural fields plus the CALLER'S OWN flag state and score. The
  // opponent's flag locations, board and mine VALUES are never sent.
  const viewerIsPlayer1 = match.player1Id === userId;
  const viewerSeat = viewerIsPlayer1 ? "player1" : "player2";
  const opponentSeat = viewerIsPlayer1 ? "player2" : "player1";
  const correct = correctFlagsForSeat(match, viewerSeat);
  return {
    id: match.id,
    status: match.status,
    myScore: Number(viewerIsPlayer1 ? match.p1Score : match.p2Score) || 0,
    opponentScore:
      Number(viewerIsPlayer1 ? match.p2Score : match.p1Score) || 0,
    myFlags: flagsForSeat(match, viewerSeat),
    myCorrectFlagCells: correct,
    myIncorrectFlagCells: normalizeFlags(flagsForSeat(match, viewerSeat)).filter(
      (c) => !correct.includes(c),
    ),
    myCorrectFlags:
      Number(
        viewerIsPlayer1 ? match.p1CorrectFlagCount : match.p2CorrectFlagCount,
      ) || 0,
    myIncorrectFlags:
      Number(
        viewerIsPlayer1
          ? match.p1IncorrectFlagCount
          : match.p2IncorrectFlagCount,
      ) || 0,
    myMinesFound:
      Number(
        viewerIsPlayer1 ? match.p1CorrectFlagCount : match.p2CorrectFlagCount,
      ) || 0,
    opponentMinesFound:
      Number(
        viewerIsPlayer1 ? match.p2CorrectFlagCount : match.p1CorrectFlagCount,
      ) || 0,
    myCompleted: Boolean(
      viewerIsPlayer1 ? match.p1Completed : match.p2Completed,
    ),
    myLocked: Boolean(viewerIsPlayer1 ? match.p1Locked : match.p2Locked),
    matchDeadline: match.matchDeadline ?? null,
    winReason: match.winReason ?? null,
    winnerId: match.winnerId ?? null,
  };
}

export async function POST(req, { params }) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;

  // Next.js 15+/16: API route `params` is a Promise — must await
  // before reading properties (same fix as the /pick route).
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
    const result = await flagTile({ userId, matchId, cellIndex });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push so the opponent refetches its per-viewer snapshot,
    // plus a cosmetic score animation hint. Neither carries the opponent's
    // flag locations or any hidden mine information — the refetch is
    // authoritative and the opponent only ever receives public counts.
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

    // Server-side AI trigger: if the match is a free AI game and the human
    // just flagged, trigger the bot's response. Best-effort only — a flag
    // is no longer terminal, so the bot may well have a turn now.
    if (result.match?.isAi && !result.justResolved) {
      try {
        const { playAiTurn } = await import("../../../../../../lib/mines-pvp/serverStore");
        await playAiTurn({ userId: result.match.player1Id, matchId });
      } catch (aiErr) {
        console.error("[mines-pvp/flag] AI turn trigger failed:", aiErr);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseFlagResult(result.match, userId),
        justResolved: Boolean(result.justResolved),
        // Caller-only verdict: true when the flagged tile really was a mine
        // (and the mine's value was awarded), false when the read was wrong.
        // `mineValue` is the server-minted points the correct flag earned.
        flagRevealed: Boolean(result.flagCorrect),
        wrongFlag: !result.flagCorrect,
        mineValue: result.flagCorrect ? result.mineValue : null,
        completed: Boolean(result.completed),
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match/flag] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
