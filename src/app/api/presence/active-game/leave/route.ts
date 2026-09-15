// app/api/presence/active-game/leave/route.ts
//
// POST /api/presence/active-game/leave  →  { success: true, cleared: n }
//
// OPTIONAL. Presence expires on its own (see ACTIVE_PLAYER_WINDOW_SECONDS), so
// nothing breaks if a client never calls this — a closed tab, a crashed
// browser or a killed network all age out within the window. This endpoint just
// makes a deliberate departure instant instead of taking up to 3 minutes.
//
// Body (all optional): { gameLabel?: string, sessionId?: string }
//   * no body / empty object → clear every game for the caller
//   * gameLabel              → clear just that game
//   * sessionId              → only clear rows written by THIS tab, so a
//                              second open tab keeps counting (that is why the
//                              session id is stored but is NOT part of the
//                              uniqueness rule)
//
// Auth is identical to the heartbeat: Clerk `auth()` only, the caller's own
// users.id, a client-supplied user id is never read. An unknown gameLabel is a
// 400 rather than a silent no-op, so a typo is caught during development
// instead of leaking stale rows.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { users } from "../../../../../db/schema";
import { validateObject } from "../../../../../lib/security/validation";
import {
  PRESENCE_SESSION_MAX_LENGTH,
  normalizeSessionId,
  resolveGameId,
} from "../../../../../lib/gamePresence";
import { clearPlaying } from "../../../../../lib/gamePresenceStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    // Body is optional: an empty POST is a valid "I left everything".
    let body: unknown = {};
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
    }

    const parsed = validateObject(body, {
      gameLabel: { type: "string", required: false, nullable: true, maxLength: 80 },
      sessionId: {
        type: "string",
        required: false,
        nullable: true,
        maxLength: PRESENCE_SESSION_MAX_LENGTH,
      },
    });
    if (!parsed.ok) return parsed.response;

    // Only resolve a game when one was sent; absence means "all games".
    let gameId: string | null = null;
    if (parsed.data.gameLabel) {
      gameId = resolveGameId(parsed.data.gameLabel);
      if (!gameId) {
        return NextResponse.json({ success: false, error: "Unknown game" }, { status: 400 });
      }
    }

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ success: false, error: "User record not found" }, { status: 404 });
    }

    const cleared = await clearPlaying({
      userId: user.id,
      gameId,
      sessionId: normalizeSessionId(parsed.data.sessionId),
    });

    // Only the caller's own row count — never anyone else's data.
    return NextResponse.json({ success: true, cleared });
  } catch (error) {
    console.error("[PRESENCE_ACTIVE_GAME_LEAVE_ERROR]", error);
    return NextResponse.json(
      { success: false, error: "Failed to clear game presence" },
      { status: 500 }
    );
  }
}
