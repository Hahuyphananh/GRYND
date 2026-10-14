// POST /api/rooms/[roomId]/invite
//
// The host invites ONE friend into a room.
//
// Every rule is re-checked server-side against the database (host only, friend
// only, room open and unexpired, a seat still free for a challenge, capacity for
// a room) — the client sends a friend id and nothing else, and an id is not a
// permission. A repeated invite is answered idempotently rather than with an
// error, and an invitee who already ACCEPTED is refused (re-inviting must never
// reset a seat somebody holds).
//
// The invited player is notified on the existing realtime transport
// (`rooms:changed` into their server-verified `user:<clerkId>` room). That push
// carries no room, code, game or inviter — it only tells their Friends tab to
// refetch, which it does over their own authenticated session.

import { NextResponse } from "next/server";
import {
  ROOM_LIMITS,
  apiError,
  enforceRateLimit,
  failureResponse,
  readRoomId,
  requireRoomActor,
} from "../../../../../lib/rooms/api";
import { inviteToRoom } from "../../../../../lib/rooms/store";
import { parseAndValidateJson } from "../../../../../lib/security/validation";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  const actor = await requireRoomActor();
  if (actor.response) return actor.response;
  const userId = actor.userId;

  const limited = await enforceRateLimit(`rooms:invite:${userId}`, ROOM_LIMITS.invite);
  if (limited) return limited;

  const { roomId } = await context.params;

  try {
    const parsed = await parseAndValidateJson(req, {
      // The friend's Clerk id, exactly as /api/friends/list returns it.
      friendUserId: { type: "string", required: true, minLength: 3, maxLength: 255 },
    });
    if (!parsed.ok) return parsed.response;

    const result = await inviteToRoom({
      roomId: readRoomId(roomId),
      hostUserId: userId,
      inviteeUserId: String(parsed.data.friendUserId),
    });
    if (!result.ok) return failureResponse(result);

    return NextResponse.json({
      success: true,
      room: result.room,
      duplicate: Boolean(result.duplicate),
    });
  } catch (error) {
    console.error(
      "[rooms] invite failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "invite_failed", "Could not invite that friend");
  }
}
