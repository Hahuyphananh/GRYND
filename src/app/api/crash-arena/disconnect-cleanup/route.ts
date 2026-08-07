import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@clerk/backend";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { releaseCrashArenaSeat } from "../../../../lib/crash-arena/cleanup";

export const dynamic = "force-dynamic";

/**
 * POST /api/crash-arena/disconnect-cleanup
 *
 * Body: { tableId: number, token: string }
 *
 * Internal endpoint called by the realtime server when a crash arena
 * participant's socket has stayed disconnected past the grace window
 * (tab closed, long network drop). Releases the player's seat so they
 * are no longer shown as being inside the game:
 *
 *   1. Verifies the Clerk session token the player authenticated their
 *      socket with — only the token owner's own seat can be removed,
 *      so the endpoint can't be used to grief another player.
 *   2. Releases the seat through the shared releaseCrashArenaSeat
 *      helper (locks in unresolved entries fairly, refunds the balance,
 *      marks the row "left" — same as "Back to Lobby").
 *
 * Returns { success, deferred } — the realtime server re-checks when
 * deferred so winnings are never stranded.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const tableId = Number(body?.tableId);
    const token = typeof body?.token === "string" ? body.token : "";

    if (!Number.isFinite(tableId) || !token) {
      return NextResponse.json(
        { success: false, error: "Missing tableId or token" },
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
    let clerkUserId: string;
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

    // ── Resolve internal user id (guard against stale accounts) ────────
    const userData = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkUserId))
      .limit(1);

    if (!userData.length) {
      // User account is gone — nothing left to clean up.
      return NextResponse.json({ success: true, data: { cleaned: false, deferred: false } });
    }

    // ── Release the seat (idempotent; shared with the stale sweep) ──────
    const result = await releaseCrashArenaSeat(
      tableId,
      clerkUserId,
      "Auto-leave after disconnect",
    );

    return NextResponse.json({
      success: true,
      data: {
        cleaned: result.cleaned,
        deferred: result.deferred,
        returned: result.returned,
      },
    });
  } catch (err) {
    console.error("[crash-arena:disconnect-cleanup]", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
