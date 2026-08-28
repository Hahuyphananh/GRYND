// POST /api/precision/resign
//
// Scaffold stub: marks the match as finished and returns the new state so
// the end-popup flow can surface "Resigned". Real implementation will write
// the forfeit to the database and credit the winner — same posture as
// /api/pool/resign and /api/uno/multiplayer/resign.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  cancelArming,
  precisionMatchStore,
} from "../../../../lib/precision/serverStore";
import {
  clearAnomalyLedgerForMatch,
  flushLedgerForMatch,
} from "../../../../lib/precision/anomalyDetection";
import { logError } from "../../../../lib/logError";
import { mirrorPrecisionTransition } from "../../../../lib/precision/canonicalLifecycle";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // ── IDOR hardening: only a participant may resign their own match.
    // Previously ANY caller could force-finish any match by ID, which
    // also tripped the payout flow on the clients' next poll.
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    const body = await req.json().catch(() => ({}));
    const matchId = String(body?.matchId ?? "");
    const match = precisionMatchStore.get(matchId);
    if (!match) {
      return NextResponse.json(
        { success: false, error: "Match not found." },
        { status: 404 },
      );
    }
    if (!match.players.some((p) => p.userId === userId)) {
      return NextResponse.json(
        { success: false, error: "Caller is not a participant in this match." },
        { status: 403 },
      );
    }
    match.phase = "finished";
    mirrorPrecisionTransition({
      matchId,
      status: "cancelled",
      cancelReason: "user_cancelled",
      playerCount: match.players.length,
    });
    match.version += 1;
    // ── Audit fix: cancel any pending arming timer so a late-firing
    // ── `setTimeout` from `armMatchRound` can't flip phase back to
    // ── "active" on a finished match. Without this, an opponent who
    // ── pressed Resign while the server was still in `arming` would
    // ── see the page briefly flip back to `active` for the un-armed
    // ── round before the realtime-server's socket broadcast settles.
    // ── Belt + braces: also flush the anomaly ledger so operators
    // ── get a summary on resign-aborts too.
    cancelArming(matchId);
    const flushed = flushLedgerForMatch(matchId);
    if (!flushed.flushed) {
      // No flagged users — drop the per-match ledger silently anyway
      // so it doesn't linger in globalThis.
      clearAnomalyLedgerForMatch(matchId);
    }
    return NextResponse.json({ success: true });
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
