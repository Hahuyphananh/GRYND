// POST /api/rooms/challenge
//
// The Friends tab's "Challenge" action: pick a friend, pick a game, send.
//
// WHY IT IS FREE AND STILL SAFE: challenging a friend must not require GRYND
// PRO, so this endpoint does NOT gate on membership. What it creates instead is
// a `challenge` room, which is structurally NOT a custom room:
//   * no `code` at all — there is nothing to share and nothing to guess,
//   * exactly ONE invitee — the friend it is addressed to,
//   * settings chosen by the SERVER (always a free match), so accepting can
//     never move coins on the friend's behalf,
//   * it has no invite step and no start step — the friend's acceptance IS the
//     start (see /api/rooms/[roomId]/respond).
// A free player therefore gains a direct challenge, not standalone room-creation
// privileges: it cannot be made invitable, shareable, repeatable or staked.
//
// The friendship is re-resolved on the server (`areFriends`) — the caller cannot
// challenge a stranger by sending their id — and the whole thing is one call so
// a half-made challenge (created but nobody invited) cannot happen.

import { NextResponse } from "next/server";
import { getMembershipTier } from "../../../../lib/stripe/subscriptions";
import {
  ROOM_LIMITS,
  apiError,
  enforceRateLimit,
  failureResponse,
  requireRoomActor,
} from "../../../../lib/rooms/api";
import { getRoomGame } from "../../../../lib/rooms/catalog";
import { areFriends, cancelRoom, createRoom, inviteToRoom } from "../../../../lib/rooms/store";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const actor = await requireRoomActor();
  if (actor.response) return actor.response;
  const userId = actor.userId;

  const limited = await enforceRateLimit(`rooms:challenge:${userId}`, ROOM_LIMITS.challenge);
  if (limited) return limited;

  try {
    const parsed = await parseAndValidateJson(req, {
      gameKey: { type: "string", required: true, minLength: 2, maxLength: 64 },
      // The friend's Clerk id, exactly as /api/friends/list returns it. The
      // server re-checks the friendship: an id is not a permission.
      friendUserId: { type: "string", required: true, minLength: 3, maxLength: 255 },
    });
    if (!parsed.ok) return parsed.response;

    const gameKey = String(parsed.data.gameKey);
    const friendUserId = String(parsed.data.friendUserId);

    if (!getRoomGame(gameKey)) {
      return apiError(400, "unknown_game", "Unsupported game for a challenge");
    }
    if (friendUserId === userId) {
      return apiError(400, "cannot_challenge_self", "You cannot challenge yourself");
    }
    if (!(await areFriends(userId, friendUserId))) {
      return apiError(403, "not_a_friend", "You can only challenge players on your friends list");
    }

    // The rule (free for a challenge, Pro for a room) lives in the pure rules
    // module; this route passes the caller's real tier so the same function
    // decides both paths.
    const tier = await getMembershipTier(userId);

    const created = await createRoom({
      hostUserId: userId,
      gameKey,
      kind: "challenge",
      tier,
      // A challenge's settings are the server's, never the body's.
      rawSettings: null,
    });
    if (!created.ok) return failureResponse(created);

    const invited = await inviteToRoom({
      roomId: created.room.id,
      hostUserId: userId,
      inviteeUserId: friendUserId,
    });
    if (!invited.ok) {
      // Never leave a challenge nobody was invited to.
      await cancelRoom({ roomId: created.room.id, userId });
      return failureResponse(invited);
    }

    return NextResponse.json({ success: true, room: invited.room }, { status: 201 });
  } catch (error) {
    console.error(
      "[rooms] challenge failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(500, "challenge_failed", "Could not send the challenge");
  }
}
