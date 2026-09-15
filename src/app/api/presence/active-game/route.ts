// app/api/presence/active-game/route.ts
//
// POST /api/presence/active-game  →  { success: true }
//
// The heartbeat behind the casino lobby's "N playing" badge. A game page calls
// this while a REAL game session is live (the same edge that already records
// "recently played" and the play counter), repeats it every
// PRESENCE_HEARTBEAT_MS, and never has to call anything on the way out — the
// row simply ages out of the activity window.
//
// Body: { gameLabel: string, sessionId?: string }
//   gameLabel is the value the page already passes to <CreatorModeHost> /
//   useRecordPlayedGame ("mines-duel", "rock-paper-scissors", …). It is
//   resolved to a CANONICAL game id here, server-side, through
//   src/lib/gamePresence.js — an unknown label is a 400, so a crafted request
//   cannot create presence for a game that does not exist.
//   sessionId is the client tab/session id and is optional.
//
// Security:
//   * Clerk `auth()` only. The row written is the caller's own users.id,
//     resolved from the session's clerkId — a client-supplied user id is never
//     read, so nobody can make another player look active.
//   * Allowlisted game ids, allowlisted body fields (parseAndValidateJson
//     rejects unknown keys), rate-limited.
//
// Idempotent: the store UPSERTs on (user_id, game_key), so repeated beats and
// multiple tabs/devices update one row instead of adding rows.
//
// This deliberately does NOT touch user_presence. That row belongs to the
// online/friends feed (and is refreshed by an app-wide heartbeat that would
// keep a stale in-game marker alive); a lobby count needs the game's own
// heartbeat as its only writer, which is what user_game_presence is.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { parseAndValidateJson } from "../../../../lib/security/validation";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";
import {
  PRESENCE_SESSION_MAX_LENGTH,
  normalizeSessionId,
  resolveGameId,
} from "../../../../lib/gamePresence";
import { markPlaying } from "../../../../lib/gamePresenceStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return unauthorized();

    // A presence beat is cheap but frequent; a runaway client must not be able
    // to hammer the table. Generous on purpose (a legit beat is ~1/120s).
    const limit = await consumeRateLimit(`presence:active-game:${userId}`, {
      windowMs: 60_000,
      max: 30,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many requests, please try again later" },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": String(limit.limit),
            "X-RateLimit-Remaining": String(limit.remaining),
            "X-RateLimit-Reset": String(limit.resetAt),
          },
        }
      );
    }

    const parsed = await parseAndValidateJson(request, {
      gameLabel: { type: "string", required: true, minLength: 2, maxLength: 80 },
      sessionId: {
        type: "string",
        required: false,
        nullable: true,
        maxLength: PRESENCE_SESSION_MAX_LENGTH,
      },
    });
    if (!parsed.ok) return parsed.response;

    // Resolve the label to a canonical game id. Unknown → rejected here, so
    // nothing downstream ever sees an id outside the lobby's game catalog.
    const gameId = resolveGameId(parsed.data.gameLabel);
    if (!gameId) {
      return NextResponse.json({ success: false, error: "Unknown game" }, { status: 400 });
    }

    // Target row always comes from the session, never from the body.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ success: false, error: "User record not found" }, { status: 404 });
    }

    await markPlaying({
      userId: user.id,
      gameId,
      sessionId: normalizeSessionId(parsed.data.sessionId),
    });

    // No row data is returned: the client only needs to know it landed, and
    // nothing about other players is ever exposed.
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[PRESENCE_ACTIVE_GAME_ERROR]", error);
    return NextResponse.json(
      { success: false, error: "Failed to update game presence" },
      { status: 500 }
    );
  }
}
