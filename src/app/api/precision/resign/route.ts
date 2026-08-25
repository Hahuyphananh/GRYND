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
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
