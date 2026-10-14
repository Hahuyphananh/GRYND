// POST /api/rooms/[roomId]/start
//
// The host starts the PRO room's match.
//
// Requirements from the requirement, all enforced here and in the store:
//   * only the host (`decideStart`), from the server-resolved Clerk session;
//   * only when the room's OWN requirements are met (one accepted opponent on
//     the second seat — the only readiness rule a two-seat game has);
//   * an expired or already-started room is refused;
//   * the start is claimed with a single conditional UPDATE before the match is
//     created, so a double click or two devices can only mint ONE match, and a
//     failed creation releases the room instead of leaving a ghost.
//
// The match itself is created by the GAME'S own store
// (src/lib/rooms/games.ts → the game's own lobby primitives), so nothing about
// public matchmaking changes and the room's match is the same object the public
// flow would have produced.

import { NextResponse } from "next/server";
import {
  apiError,
  failureResponse,
  readRoomId,
  requireRoomActor,
} from "../../../../../lib/rooms/api";
import { startRoom } from "../../../../../lib/rooms/store";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  const actor = await requireRoomActor();
  if (actor.response) return actor.response;

  const { roomId } = await context.params;

  try {
    const result = await startRoom({
      roomId: readRoomId(roomId),
      userId: actor.userId,
    });
    if (!result.ok) return failureResponse(result);

    return NextResponse.json({
      success: true,
      room: result.room,
      matchId: result.matchId,
      matchUrl: result.matchUrl,
      started: result.started,
    });
  } catch (error) {
    console.error(
      "[rooms] start failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "start_failed", "Could not start the match");
  }
}
