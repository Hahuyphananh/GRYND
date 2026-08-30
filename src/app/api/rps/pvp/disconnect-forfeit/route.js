// src/app/api/rps/pvp/disconnect-forfeit/route.js
//
// POST — internal endpoint called by the realtime server when an
// RPS PvP participant's socket has stayed disconnected past the
// grace window (tab closed, long network drop). Settles the match
// in the opponent's favor via the shared `forfeitRpsPvpGame` store
// function. Idempotent — terminal matches are left untouched. The
// Clerk session token the player authenticated their socket with is
// re-verified here, so only the token owner's own match can be
// forfeited — the endpoint can't be used to grief another player.

import { NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import {
  forfeitRpsPvpGame,
  recordForfeitStats,
} from "../../../../../lib/rps-pvp/serverStore";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const gameId = Number(body?.gameId);
    const token = typeof body?.token === "string" ? body.token : "";

    if (!Number.isFinite(gameId) || !token) {
      return NextResponse.json(
        { success: false, error: "Missing gameId or token" },
        { status: 400 },
      );
    }

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

    const result = await forfeitRpsPvpGame({
      userId: clerkUserId,
      gameId,
    });
    if (result.error) {
      if (result.status === 403 || result.status === 404) {
        // Definitive — no retry will help; stop the realtime retry loop.
        return NextResponse.json({
          success: true,
          data: { forfeited: false, reason: result.error },
        });
      }
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    recordForfeitStats(result);

    return NextResponse.json({
      success: true,
      data: {
        forfeited: true,
        gameId,
      },
    });
  } catch (err) {
    console.error("[rps-pvp:disconnect-forfeit]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
