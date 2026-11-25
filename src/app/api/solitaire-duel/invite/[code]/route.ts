// src/app/api/solitaire-duel/invite/[code]/route.ts
//
// GET  — what a challenge link currently points at (public, deal-free).
// POST — take the second seat.
//
// The GET is the /duel/<code> landing page's preview: it answers "is this code
// still open, already started, or expired" and NOTHING else. It carries no
// match id, no board, no seed and no player identity, because holding a code is
// not the same as having sat down.
//
// The POST is the only way a code becomes a seat. The claimant is the SESSION's
// user — never a body field — and the claim itself is one `FOR UPDATE` inside
// the store, so two friends clicking at the same instant cannot both take
// seat 2. A friend who reloads a link they already used gets the same match
// back instead of a 409 with nowhere to go.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import {
  findFriendChallenge,
  joinFriendChallenge,
} from "../../../../../lib/solitaire-duel/serverStore";
import { normalizeFriendChallengeCode } from "../../../../../lib/solitaire-duel/friendChallenge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

async function readCode(params: Params["params"]): Promise<string | null> {
  const resolved = (await params) || ({} as { code?: string });
  return normalizeFriendChallengeCode(resolved.code);
}

export async function GET(_req: Request, { params }: Params) {
  const code = await readCode(params);
  if (!code) {
    return NextResponse.json(
      { success: false, error: "Not a challenge code" },
      { status: 400 },
    );
  }

  try {
    const preview = await findFriendChallenge({ code });
    return NextResponse.json(
      { success: true, data: preview },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_friend_challenge_preview_error",
      errorMessage:
        error instanceof Error ? error.message : "Friend challenge preview failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/invite/[code]",
      game: "Solitaire Duel",
      metadata: { operation: "friend_challenge_preview" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

export async function POST(_req: Request, { params }: Params) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Sign in to accept this challenge" },
      { status: 401 },
    );
  }

  const code = await readCode(params);
  if (!code) {
    return NextResponse.json(
      { success: false, error: "Not a challenge code" },
      { status: 400 },
    );
  }

  try {
    const result = await joinFriendChallenge({ userId, code });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          matchId: String(result.match.id),
          status: result.match.status,
          // True when the caller was already seated (their own link, or a
          // reload) — the client navigates either way, it just must not claim a
          // fresh join happened.
          alreadySeated: "alreadySeated" in result ? Boolean(result.alreadySeated) : false,
          goAtMs: result.match.goAt ? new Date(result.match.goAt).getTime() : null,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_friend_challenge_join_error",
      errorMessage:
        error instanceof Error ? error.message : "Friend challenge join failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/invite/[code]",
      game: "Solitaire Duel",
      metadata: { operation: "join_friend_challenge" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
