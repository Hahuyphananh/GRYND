// POST /api/precision/resign
//
// Ends a match immediately, without declaring a winner, and returns the new
// state so the end-popup flow can surface "Resigned". Matches the posture of
// /api/pool/resign.
//
// The transition itself lives in `serverStore.resignMatch`, inside a
// `SELECT … FOR UPDATE` transaction:
//   * phase → "finished", the round-replay envelope is cleared (so a late
//     STOP packet from the round in flight can't be replayed against a
//     finished match), and the server-only target / bot-stop columns are
//     dropped;
//   * the row's `status` / `ended_at` reporting columns are stamped so the
//     retention job and analytics see a cancelled match;
//   * the canonical-lifecycle mirror records `cancelled / user_cancelled`.
//
// There is no arming timer to cancel any more — the countdown is a stored
// instant and `phase: "finished"` is a hard stop for it.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { resignMatch } from "../../../../lib/precision/serverStore";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // ── IDOR hardening: only a participant may resign their own match.
    // Previously ANY caller could force-finish any match by ID, which
    // also tripped the payout flow on the clients' next poll.
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) {
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

    const result = await resignMatch(matchId, userId);
    if (!result.ok) {
      if (result.reason === "Match not found") {
        return NextResponse.json(
          { success: false, error: "Match not found." },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { success: false, error: "Caller is not a participant in this match." },
        { status: 403 },
      );
    }
    return NextResponse.json({ success: true, match: result.match ?? null });
  } catch (err) {
    await logError({
      errorType: "precision_resignation_error",
      errorMessage: err instanceof Error ? err.message : "Precision resignation failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/precision/resign",
      game: "Precision",
      metadata: { operation: "resign_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
