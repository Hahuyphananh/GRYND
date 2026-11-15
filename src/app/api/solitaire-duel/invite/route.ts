// src/app/api/solitaire-duel/invite/route.ts
//
// POST — mint (or hand back) the caller's friend-challenge link.
//
// A friend challenge is a PRIVATE waiting lobby: the creator holds seat 1, the
// row is excluded from every public queue query, and the only way to seat 2 is
// the code. It is free play — no stake, no pot, no AI seat, and no ghost
// fallback (a link addressed to one person must not silently become a replay
// against somebody else).
//
// Identity comes from the session, never the body: the creator of the lobby is
// whichever account made the request.
//
// The route deliberately returns the same lobby on a second call. Two clicks on
// "Challenge a friend" must not leave two tables behind, and the friend who
// opens the first link would otherwise join a lobby the creator has forgotten.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createFriendChallenge } from "../../../../lib/solitaire-duel/serverStore";
import { friendChallengeUrl } from "../../../../lib/solitaire-duel/friendChallenge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Sign in to challenge a friend" },
      { status: 401 },
    );
  }

  try {
    const result = await createFriendChallenge({ userId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    const code = result.match.inviteCode;
    const url = code ? friendChallengeUrl(code) : null;
    const expiresAt = result.match.inviteExpiresAt
      ? new Date(result.match.inviteExpiresAt).getTime()
      : null;

    if (!code || !url) {
      return NextResponse.json(
        { success: false, error: "Unable to create a challenge link" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          code,
          url,
          matchId: String(result.match.id),
          expiresAtMs: Number.isFinite(expiresAt) ? expiresAt : null,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_friend_challenge_create_error",
      errorMessage:
        error instanceof Error ? error.message : "Friend challenge creation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/invite",
      game: "Solitaire Duel",
      metadata: { operation: "create_friend_challenge" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
