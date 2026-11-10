// src/app/api/solitaire-duel/match/[matchId]/review/route.ts
//
// GET — the exact deal and the CALLER'S OWN validated move log for a finished
// Solitaire Duel, ready for Game Review.
//
// AUTHORISATION is the existing one: `requirePracticePlayer` resolves the
// account (or a signed guest for a practice seat) and `fetchMatch` refuses a
// non-participant with 403. The id comes from the URL, but the identity never
// does — there is no player/query parameter to name someone else.
//
// WHAT IS EXPOSED, AND WHEN
//   * Only a TERMINAL match is reviewable. A live match would leak the deal's
//     face-down cards and the stock order, which are the puzzle, so it is 409.
//   * Only the CALLER'S seat log is read (`fetchSeatMoves(matchId, seat)`) and
//     returned. The opponent's log and board are never read into the response.
//   * For a forfeit or an unfinished board the payload is clearly marked
//     `status: "forfeit" | "incomplete"` and `analysisEligible: false`; it is
//     never presented as a complete review.
//
// WHAT IS NOT HERE: no analysis, no accuracy score, no Elo/trophy write, no
// settlement. The log is replayed through `replayMoves` only to prove it
// reproduces the stored board; a mismatch is refused rather than served.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { loadOrComputeAnalysis } from "../../../../../../lib/solitaire-duel/analysisCache";
import { TERMINAL_STATUSES, MATCH_STATUS, MAX_MOVES_PER_SEAT } from "../../../../../../lib/solitaire-duel/constants";
import { replayMoves } from "../../../../../../lib/solitaire-duel/rules";
import { canonicalMoveLog, moveLogDigest } from "../../../../../../lib/solitaire-duel/soloPersistence";
import {
  duelReviewStatus,
  durationMsBetween,
  toIso,
} from "../../../../../../lib/solitaire-duel/review";
import {
  fetchMatch,
  fetchSeatMoves,
  isMatchId,
  stateForSeat,
} from "../../../../../../lib/solitaire-duel/serverStore";
import type { SolitaireDeal } from "../../../../../../lib/solitaire-duel/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  // Guard the uuid before it reaches Postgres, so a malformed id is a 400.
  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
  }

  try {
    const result = await fetchMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    const { match, dto } = result;

    if (!TERMINAL_STATUSES.includes(match.status)) {
      return NextResponse.json(
        {
          success: false,
          error: "The match has not finished yet",
          code: "REVIEW_NOT_READY",
        },
        { status: 409 },
      );
    }
    if (match.status === MATCH_STATUS.CANCELLED) {
      return NextResponse.json(
        { success: false, error: "The match was cancelled before it was played" },
        { status: 409 },
      );
    }

    // fetchMatch already proved the seat; this is the seat whose history and
    // board are allowed into the response.
    const seat = dto.seat;
    const state = seat ? stateForSeat(match, seat) : null;
    if (!seat || !state) {
      return NextResponse.json(
        { success: false, error: "The seat has no board" },
        { status: 409 },
      );
    }

    const playerCompleted = state.completed === true;
    const viewerPly = Number(seat === "player1" ? match.p1Ply : match.p2Ply) || 0;
    const rawMoves = await fetchSeatMoves(String(match.id), seat);

    if (rawMoves.length > MAX_MOVES_PER_SEAT || rawMoves.length !== viewerPly) {
      return NextResponse.json(
        {
          success: false,
          error: "The stored move history is inconsistent",
          code: "REVIEW_HISTORY_INCONSISTENT",
        },
        { status: 409 },
      );
    }

    const canonical = canonicalMoveLog(rawMoves);
    if (!canonical.ok) {
      return NextResponse.json(
        {
          success: false,
          error: "The stored move history is not readable",
          code: "REVIEW_HISTORY_INCONSISTENT",
        },
        { status: 409 },
      );
    }

    // The log must rebuild the stored board exactly; otherwise the review would
    // show a different game from the one that was played.
    const replayed = replayMoves({
      deal: match.deal as SolitaireDeal,
      moves: canonical.log as { kind: string; move: unknown }[],
    });
    if (
      !replayed.ok ||
      replayed.state.ply !== rawMoves.length ||
      replayed.state.completed !== playerCompleted
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "The stored move history does not rebuild this board",
          code: "REVIEW_HISTORY_INCONSISTENT",
        },
        { status: 409 },
      );
    }

    // Cache identity = the caller's own game + SHA-256 of THEIR canonical log +
    // engine version. The opponent's log is neither read nor part of the key.
    const { analysis } = await loadOrComputeAnalysis({
      gameKind: "duel",
      gameId: String(match.id),
      logDigest: moveLogDigest(canonical.log),
      deal: match.deal as SolitaireDeal,
      moves: canonical.log,
    });

    const status = duelReviewStatus({
      playerCompleted,
      resolutionReason: match.resolutionReason,
    });
    const startedAt = toIso(match.startedAt ?? match.goAt ?? match.createdAt);
    const seatFinishedAt =
      seat === "player1" ? match.p1FinishedAt : match.p2FinishedAt;
    const completedAt = toIso(
      playerCompleted ? (seatFinishedAt ?? match.endedAt) : match.endedAt,
    );
    const durationMs = durationMsBetween(startedAt, completedAt);

    return NextResponse.json({
      success: true,
      data: {
        gameId: String(match.id),
        gameKind: "duel",
        variant: match.variant,
        variantVersion: match.variantVersion,
        status,
        deal: match.deal,
        // The caller's own log, in order, normalised to {kind, move}.
        moves: canonical.log,
        result: {
          completed: playerCompleted,
          moveCount: canonical.log.length,
          elapsedMs: durationMs,
          seat,
          outcome: match.result ?? null,
          winnerSeat:
            match.result === "player1" || match.result === "player2"
              ? match.result
              : null,
          resolutionReason: match.resolutionReason ?? null,
        },
        startedAt,
        completedAt,
        durationMs,
        analysisEligible: status === "complete",
        analysis,
        incompleteReason:
          status === "complete" ? null : status === "forfeit" ? "forfeit" : "not-completed",
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_review_error",
      errorMessage: error instanceof Error ? error.message : "Solitaire Duel review failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]/review",
      game: "Solitaire Duel",
      metadata: { operation: "review" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
