// POST /api/rooms/join
//
// Join a private room by its shared code.
//
// FREE PLAYERS ARE ALLOWED: only CREATION is GRYND PRO, so this route checks
// the room (open, unexpired, not a challenge, seat free) and never the caller's
// membership. That is the requirement's "free users may join valid private rooms
// when invited", enforced on the server.
//
// The code is the only secret, so it is protected three ways: it is 10
// characters from a 32-symbol alphabet (32^10 ≈ 1.1e15), it is unique by index,
// and this endpoint is rate limited per user (30/minute) so guessing is not a
// strategy. A wrong code answers the same as a code that never existed.

import { NextResponse } from "next/server";
import {
  ROOM_LIMITS,
  apiError,
  enforceRateLimit,
  failureResponse,
  requireRoomActor,
} from "../../../../lib/rooms/api";
import { joinRoomByCode } from "../../../../lib/rooms/store";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const actor = await requireRoomActor();
  if (actor.response) return actor.response;
  const userId = actor.userId;

  const limited = await enforceRateLimit(`rooms:join:${userId}`, ROOM_LIMITS.join);
  if (limited) return limited;

  try {
    const parsed = await parseAndValidateJson(req, {
      code: { type: "string", required: true, minLength: 4, maxLength: 32 },
    });
    if (!parsed.ok) return parsed.response;

    const joined = await joinRoomByCode({
      code: String(parsed.data.code),
      userId,
    });
    if (!joined.ok) return failureResponse(joined);

    return NextResponse.json({ success: true, room: joined.room });
  } catch (error) {
    console.error(
      "[rooms] join failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "join_failed", "Could not join the room");
  }
}
