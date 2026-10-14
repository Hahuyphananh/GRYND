// /api/rooms
//
//   GET  — the caller's rooms and invitations (the Friends tab's list).
//   POST — create a private custom room. GRYND PRO ONLY, enforced HERE.
//
// WHY THE PRO CHECK IS ON THE SERVER: "only authenticated, active GRYND PRO
// members can create private custom rooms" is a rule, not a hidden button. The
// tier comes from the same authoritative source the rest of the platform uses
// (`getMembershipTier` → an ACTIVE subscription row), never from the request —
// so a free account cannot create a room by calling this endpoint directly.
//
// WHAT THIS ROUTE DOES NOT DO: matchmake. It creates the room record (who may be
// in it, for which game, with which settings) and nothing else; the match is
// created later, by the game's own store, when the host starts it
// (`POST /api/rooms/[roomId]/start`). See docs/PRIVATE_ROOMS.md.

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { parseAndValidateJson } from "../../../lib/security/validation";
import { getMembershipTier } from "../../../lib/stripe/subscriptions";
import {
  ROOM_LIMITS,
  apiError,
  enforceRateLimit,
  failureResponse,
  requireRoomActor,
} from "../../../lib/rooms/api";
import { ROOM_GAMES, getRoomGame } from "../../../lib/rooms/catalog";
import { createRoom, listRoomsFor } from "../../../lib/rooms/store";

export const dynamic = "force-dynamic";

/** GET /api/rooms — the caller's own rooms and invitations. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return apiError(401, "unauthenticated", "Unauthorized");

  try {
    const result = await listRoomsFor({ userId });
    if (!result.ok) return failureResponse(result);
    return NextResponse.json({
      success: true,
      rooms: result.rooms,
      // The catalog the picker renders: same module the server validates with,
      // so the offered settings can never drift from the accepted ones.
      games: ROOM_GAMES,
    });
  } catch (error) {
    console.error(
      "[rooms] list failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "list_failed", "Could not load your rooms");
  }
}

/** POST /api/rooms — create a PRO private room. */
export async function POST(req: Request) {
  const actor = await requireRoomActor();
  if (actor.response) return actor.response;
  const userId = actor.userId;

  const limited = await enforceRateLimit(`rooms:create:${userId}`, ROOM_LIMITS.create);
  if (limited) return limited;

  try {
    const parsed = await parseAndValidateJson(req, {
      // `kind` is accepted but only "room": the free friend challenge has its
      // own endpoint (/api/rooms/challenge) so it can invite in the same call.
      kind: { type: "string", enum: ["room"] },
      gameKey: { type: "string", required: true, minLength: 2, maxLength: 64 },
      // Flat, allowlisted: unknown fields are rejected, and the game's own
      // ceiling is applied by resolveRoomSettings inside the store.
      stake: { type: "number", integer: true, min: 0, max: 100 },
    });
    if (!parsed.ok) return parsed.response;

    const gameKey = String(parsed.data.gameKey);
    if (!getRoomGame(gameKey)) {
      return apiError(400, "unknown_game", "Unsupported game for a private room");
    }

    // Server-resolved membership: the request body cannot claim a tier.
    const tier = await getMembershipTier(userId);

    const created = await createRoom({
      hostUserId: userId,
      gameKey,
      kind: "room",
      tier,
      rawSettings: { stake: parsed.data.stake ?? 0 },
    });
    if (!created.ok) return failureResponse(created);

    return NextResponse.json({ success: true, room: created.room }, { status: 201 });
  } catch (error) {
    console.error(
      "[rooms] create failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "create_failed", "Could not create the room");
  }
}
