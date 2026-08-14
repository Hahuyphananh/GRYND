// src/app/api/slots-pvp/internal/stop/route.js
//
// POST — internal column stop / jettison endpoint, called by the
// realtime server when a match participant emits `slots:stop` over the
// socket (the "near-instant" stop path — no 800ms poll round-trip
// before the column locks).
//
// Mirrors /api/slots-pvp/disconnect-forfeit exactly: the Clerk session
// token the player authenticated their socket with is re-verified here,
// so only the token owner can act on their own match — a client cannot
// call this route directly to grief another player (they'd need that
// player's session token).
//
// The actual game mutation is the SAME `stopColumn` used by the public
// /stop-reel route (row-locked transaction, deterministic engine), so
// the socket path and the HTTP fallback can never disagree about state.
// After applying the stop the route broadcasts a `lobby:updated` push
// to the match room (best-effort; the realtime server also emits one
// itself since it owns the rooms in separate-process deploys).

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { stopColumn } from "../../../../../lib/slots-pvp/serverStore.js";
import { broadcastMatchUpdate } from "../../../../../lib/slots-pvp/rooms.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const matchId = Number(body?.matchId);
    const token = typeof body?.token === "string" ? body.token : "";
    const columnIndex = Number(body?.columnIndex);
    const currentSpin =
      body?.currentSpin != null ? Number(body.currentSpin) : null;
    const jettison = body?.jettison === true;

    if (!Number.isFinite(matchId) || !token) {
      return NextResponse.json(
        { success: false, error: "Missing matchId or token" },
        { status: 400 },
      );
    }
    if (!Number.isInteger(columnIndex) || columnIndex < 0) {
      return NextResponse.json(
        { success: false, error: "Invalid columnIndex" },
        { status: 400 },
      );
    }

    // ── Verify the socket's Clerk session token ─────────────────────────
    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      return NextResponse.json(
        { success: false, error: "Server authentication is not configured" },
        { status: 500 },
      );
    }
    let clerkUserId;
    try {
      const verified = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
      clerkUserId = verified.sub ?? "";
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }
    if (!clerkUserId) {
      return NextResponse.json(
        { success: false, error: "Invalid token" },
        { status: 401 },
      );
    }

    const result = await stopColumn({
      userId: clerkUserId,
      matchId,
      columnIndex,
      currentSpin,
      jettison,
    });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push so the opponent sees the stop without waiting for
    // the next poll (silently no-ops in separate-process deploys; the
    // realtime server's own room emit covers that case).
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      roundResolved: result.roundResolved === true,
      runEnded: result.runEnded === true,
      jettisoned: result.jettisoned === true,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match.status,
        seat: result.seat,
        columnStopped: result.columnStopped,
        jettisoned: result.jettisoned === true,
        runEnded: result.runEnded === true,
        survived: result.survived,
        roundResolved: result.roundResolved === true,
      },
    });
  } catch (err) {
    console.error("[slots-pvp:internal:stop]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
