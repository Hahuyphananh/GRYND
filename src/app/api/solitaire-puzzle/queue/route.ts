// src/app/api/solitaire-puzzle/queue/route.ts
//
// Puzzle Ranked matchmaking. HUMAN vs HUMAN ONLY — there is no ghost, bot or
// back-fill, and a search that finds nobody stays an honest waiting state.
//
//   POST   — find an open Puzzle Ranked seat, or open one. Returns the queue
//            state only (session id, status, shared clock instants). No board,
//            no manifest, no puzzle set: the frozen set is server-only until
//            the match is live and both players are seated.
//   GET    — the caller's current search, so a reload resumes the same search.
//   DELETE — cancel the caller's own waiting search. A live match cannot be
//            cancelled here; leaving one is a forfeit.
//
// Authorisation is `requireAgeVerifiedUser` (a signed-in account) — a guest can
// never enter a human ranked mode. The store authorises by stored seat as well,
// so a forged session id still reaches nothing.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import {
  cancelPuzzleRankedSearch,
  createOrJoinPuzzleRanked,
  getPuzzleRankedQueue,
} from "../../../../lib/solitaire-puzzle/matchmaking";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  try {
    const result = await createOrJoinPuzzleRanked({ userId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({ success: true, data: result.state });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_queue_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle Ranked matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/queue",
      game: "Puzzle Ranked",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

export async function GET() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  try {
    return NextResponse.json({
      success: true,
      data: await getPuzzleRankedQueue({ userId }),
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_queue_read_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle Ranked queue read failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/queue",
      game: "Puzzle Ranked",
      metadata: { operation: "read_queue" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

export async function DELETE() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  try {
    return NextResponse.json({
      success: true,
      data: await cancelPuzzleRankedSearch({ userId }),
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_queue_cancel_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle Ranked cancel failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/queue",
      game: "Puzzle Ranked",
      metadata: { operation: "cancel_queue" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
