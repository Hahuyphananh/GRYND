// POST /api/precision/leave
//
// The single \"I am done with this game id\" endpoint for Precision. The
// match page calls it when the player taps Lobby / Leave / Cancel lobby,
// and (best-effort, via `sendBeacon`) when a host closes the tab while
// still waiting for an opponent.
//
// It resolves the three shapes a Precision id can have today:
//   1. A WAITING lobby hosted by the caller → the queue entry is deleted
//      outright (a single conditional DELETE, so a pairing that lands in the
//      same instant can never be cancelled out from under the new match).
//      Without this a host who walked away left a ghost lobby in the public
//      list for the whole 5-minute TTL.
//   2. An AI PRACTICE match the caller owns → the row is removed. Practice
//      is free, so there is nothing to settle and the match must not linger
//      unfinished forever (the abandoned sweep is the backstop).
//   3. A live PvP match the caller is seated in → forfeited to the
//      opponent exactly like the realtime server's disconnect grace
//      timer does (phase → \"finished\", winner = opponent), so the
//      opponent's page resolves the match instead of hanging on a
//      round that will never be answered.
//
// Identity comes from the Clerk session (never the body): a caller can
// only ever leave their OWN game. Idempotent — a match that is already
// gone or already finished returns success so retries and double-fires
// (button + unload beacon) are safe.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  cancelQueueEntry,
  forfeitMatch,
  isPrecisionAiMatch,
  readMatch,
  removePrecisionMatch,
} from "../../../../lib/precision/serverStore";
import { logError } from "../../../../lib/logError";
import { mirrorPrecisionTransition } from "../../../../lib/precision/canonicalLifecycle";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
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

    // ── 1. Waiting lobby owned by the caller ────────────────────────────
    // `cancelQueueEntry` re-checks ownership AND that the lobby is still
    // `waiting` at delete time, so this can never cancel a lobby that has
    // just been paired with an opponent.
    if (await cancelQueueEntry(matchId, userId)) {
      mirrorPrecisionTransition({
        matchId,
        status: "cancelled",
        cancelReason: "user_cancelled",
        playerCount: 1,
      });
      return NextResponse.json({ success: true, action: "lobby_cancelled" });
    }

    const row = await readMatch(matchId);
    // Already gone (host cancelled, swept as abandoned, TTL'd) — the caller
    // wanted it gone and it is.
    if (!row) {
      return NextResponse.json({ success: true, action: "noop" });
    }
    const match = row.state;

    const self = match.players.find((p) => p.userId === userId);
    if (!self) {
      return NextResponse.json(
        { success: false, error: "Caller is not a participant in this match." },
        { status: 403 },
      );
    }

    // Terminal already — nothing to clean up, the end-of-match replay window
    // still owns this entry.
    if (match.phase === "finished") {
      return NextResponse.json({ success: true, action: "noop" });
    }

    // ── 2. AI practice — free, so remove the match entirely ─────────────
    // A practice match has no opponent waiting on it and no stake to settle,
    // so leaving deletes it rather than declaring a winner.
    if (isPrecisionAiMatch(match)) {
      await removePrecisionMatch(matchId);
      mirrorPrecisionTransition({
        matchId,
        status: "cancelled",
        cancelReason: "user_cancelled",
        playerCount: match.players.length,
      });
      return NextResponse.json({ success: true, action: "practice_removed" });
    }

    // ── 3. Live PvP — forfeit to the opponent ───────────────────────────
    // Identical to the realtime server's disconnect forfeit so both exit
    // paths (tab close, explicit leave) produce the same result for the
    // player still in the match.
    const result = await forfeitMatch(matchId, userId);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.reason ?? "Unable to leave match." },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, action: "forfeited" });
  } catch (err) {
    await logError({
      errorType: "precision_leave_error",
      errorMessage: err instanceof Error ? err.message : "Precision leave failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/precision/leave",
      game: "Precision",
      metadata: { operation: "leave_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
