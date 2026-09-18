// POST /api/precision/finish-match
//
// Idempotent trigger for the Precision match-finished payout. The
// persisted match row (`precision_matches`) is the SINGLE source of truth
// for `winnerSeat` and current `score`. This route does NOT accept any
// client-supplied winner or wager — the helper resolves them from the row
// so a misbehaving client can't fabricate the result.
//
// Both clients (winner + loser) hit this endpoint as soon as they observe
// `phase === "finished"` via either the broadcast OR the polling tick. The
// server-side idempotency guard in `processMatchFinishedPayout` is now a DB
// column (`payout_processed_at`, claimed under `FOR UPDATE`), so it holds
// across instances and across a retry after the settling instance died —
// the previous in-process `Set` could pay twice on a serverless deploy.
//
// Shape of the response mirrors the Hex Duel end-game endpoint so
// the page can show the same Winner/Score/Prize pattern as other
// PvP games in the casino.

import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { NextResponse } from "next/server";

import {
  processMatchFinishedPayout,
  PRECISION_PAYOUT_MULTIPLIER,
} from "../../../../lib/precision/finishMatch";
import { readMatch } from "../../../../lib/precision/serverStore";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");

    if (!matchId) {
      return NextResponse.json(
        { success: false, error: "Missing matchId." },
        { status: 400 },
      );
    }

    // Authorize: the caller MUST be a participant of the match. We
    // do this BEFORE running the payout so a non-participant cannot
    // invoke the endpoint and observe the payout shape. The
    // canonical look-up happens server-side inside the helper.
    const row = await readMatch(matchId);
    if (!row) {
      return NextResponse.json(
        { success: false, error: "Match not found." },
        { status: 404 },
      );
    }
    const match = row.state;
    const callerInMatch = match.players.some(
      (p) => p.userId === clerkId,
    );
    if (!callerInMatch) {
      return NextResponse.json(
        { success: false, error: "Caller is not a participant in this match." },
        { status: 403 },
      );
    }

    const result = await processMatchFinishedPayout({ matchId });

    if (!result.success) {
      const status = result.reason === "Match not found" ? 404 : 409;
      return NextResponse.json(
      {
        success: false,
        error: result.reason ?? "Payout processing failed.",
          alreadyProcessed: result.alreadyProcessed,
          payout: result.payout,
          finalScore: result.finalScore,
          winnerUserId: result.winnerUserId,
        },
        { status },
      );
    }

    // Look up the local view's "did I win" flag derived from
    // `state.players` so the page can show the win/loss framing.
    const localPlayer = match.players.find((p) => p.userId === clerkId);
    const localSeat = localPlayer?.seat ?? null;
    const didLocalWin =
      localSeat !== null && match.winnerSeat === localSeat;

    return NextResponse.json({
      success: true,
      alreadyProcessed: result.alreadyProcessed,
      payout: result.payout,
      newBalance: result.newBalance,
      finalScore: result.finalScore,
      winnerUserId: result.winnerUserId,
      winnerSeat: match.winnerSeat,
      localSeat,
      didLocalWin,
      payoutMultiplier: PRECISION_PAYOUT_MULTIPLIER,
    });
  } catch (err) {
    console.error("[precision] /finish-match error:", err);
    await logError({
      errorType: "precision_payout_error",
      errorMessage: err instanceof Error ? err.message : "Precision payout failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/precision/finish-match",
      game: "Precision",
      metadata: { operation: "process_match_finished_payout" },
    });
    return NextResponse.json(
      {
        success: false,
        error: "Server error",
      },
      { status: 500 },
    );
  }
}
