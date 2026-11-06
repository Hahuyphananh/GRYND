// /api/rooms/[roomId]
//
//   GET    — the room's status: header, settings, invited players and their
//            answers. PARTICIPANTS ONLY (host or invited guest).
//   DELETE — the host closes the room before it starts.
//
// THE IDOR RULE: knowing a room id must not reveal the room, its code, its
// settings or its invitees to anyone who was not invited. The read is answered
// by the pure `decideViewRoom` (403 `not_a_member`), so a changed room id gets
// nothing — and no invitation is ever listed to an unrelated player, because
// the list endpoint derives everything from the caller's own membership rows.

import { NextResponse } from "next/server";
import {
  apiError,
  failureResponse,
  readRoomId,
  requireRoomActor,
  requireRoomViewer,
} from "../../../../lib/rooms/api";
import { cancelRoom, getRoomForViewer } from "../../../../lib/rooms/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  // Reading needs a verified session (account or guest cookie): a participant
  // may look at the room they were invited to before they answer. The room id
  // is still not a permission — `decideViewRoom` answers 403 to non-members.
  const actor = await requireRoomViewer();
  if (actor.response) return actor.response;
  const userId = actor.userId;

  const { roomId } = await context.params;

  try {
    const result = await getRoomForViewer({ roomId: readRoomId(roomId), userId });
    if (!result.ok) return failureResponse(result);
    return NextResponse.json({ success: true, room: result.room });
  } catch (error) {
    console.error(
      "[rooms] read failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "read_failed", "Could not load the room");
  }
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  const actor = await requireRoomActor();
  if (actor.response) return actor.response;

  const { roomId } = await context.params;

  try {
    const result = await cancelRoom({
      roomId: readRoomId(roomId),
      userId: actor.userId,
    });
    if (!result.ok) return failureResponse(result);
    return NextResponse.json({ success: true, room: result.room });
  } catch (error) {
    console.error(
      "[rooms] cancel failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "cancel_failed", "Could not close the room");
  }
}
