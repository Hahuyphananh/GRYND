// POST /api/rooms/[roomId]/respond
//
// Answer an invitation: `{ accept: true | false }`.
//
// ONLY THE INVITEE (the pure `decideRespond` rule checks the membership row the
// caller's own Clerk id maps to), and a repeated answer is idempotent rather
// than an error — a double click, a retried request or two devices answering at
// once must not create two matches.
//
// FOR A CHALLENGE, ACCEPTING STARTS THE MATCH: the acceptance claims the room
// with a single conditional `UPDATE … WHERE status = 'open'`, and only the
// winner of that UPDATE creates the match (through the game's own store). The
// loser is answered with the room's real state, which is the winner's match. A
// failed match creation releases the room and reports why — never a ghost.
//
// FOR A PRO ROOM, accepting only takes a seat; the host starts it.

import { NextResponse } from "next/server";
import {
  apiError,
  failureResponse,
  readRoomId,
  requireRoomActor,
} from "../../../../../lib/rooms/api";
import { respondToInvite } from "../../../../../lib/rooms/store";
import { parseAndValidateJson } from "../../../../../lib/security/validation";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  const actor = await requireRoomActor();
  if (actor.response) return actor.response;

  const { roomId } = await context.params;

  try {
    const parsed = await parseAndValidateJson(req, {
      accept: { type: "boolean", required: true },
    });
    if (!parsed.ok) return parsed.response;

    const result = await respondToInvite({
      roomId: readRoomId(roomId),
      userId: actor.userId,
      accept: Boolean(parsed.data.accept),
    });
    if (!result.ok) return failureResponse(result);

    return NextResponse.json({
      success: true,
      room: result.room,
      // True when this answer started the match (challenge accept) — the client
      // follows `room.matchUrl`.
      started: Boolean((result as { start?: boolean }).start),
    });
  } catch (error) {
    console.error(
      "[rooms] respond failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "respond_failed", "Could not answer the invitation");
  }
}
