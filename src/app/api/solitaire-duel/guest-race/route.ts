// src/app/api/solitaire-duel/guest-race/route.ts
//
// POST — a signed-out visitor's ONE free race.
//
// Why a separate route instead of letting guests into create-or-join: a guest
// id has no account, no rating and no trophies, and a `waiting` row is by
// definition visible to the public matchmaker. Seating a guest there would put
// a non-account into a real player's ladder match. This route therefore mints a
// match that is ALREADY PLAYING against a recorded human run (the ghost seat),
// never a waiting lobby, and never settles a rating.
//
// Identity is the HMAC-signed guest cookie, issued here (the entry route is the
// only one that may mint it). A signed-in caller is refused with a pointer to
// the live queue: an account has a ladder to protect, so it never needs — or
// gets — the trial.
//
// The limit is one match per guest id, enforced from the store's own rows. A
// cleared cookie mints a new guest id, which is why this is a taste rather than
// a free ladder: the sign-in prompt is the real gate.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { logError } from "../../../../lib/logError";
import { createGuestGhostRace } from "../../../../lib/solitaire-duel/serverStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  // `create: true` because this route STARTS the trial; every follow-up route
  // of the match reads the cookie instead of minting another identity.
  const gate = await requirePracticePlayer({ create: true });
  if (gate.response) return gate.response;
  const playerId = gate.playerId;
  if (!playerId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  if (!gate.isGuest) {
    return NextResponse.json(
      {
        success: false,
        reason: "signed_in",
        error: "You already have an account — use the ranked queue",
      },
      { status: 409 },
    );
  }

  try {
    const result = await createGuestGhostRace({ userId: playerId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error, reason: result.reason ?? null },
        { status: result.status },
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          matchId: String(result.match.id),
          status: result.match.status,
          reused: result.reused,
          goAtMs: result.match.goAt ? new Date(result.match.goAt).getTime() : null,
          // The trial is one race; the client needs no counter of its own.
          trialMatches: 1,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_guest_race_error",
      errorMessage:
        error instanceof Error ? error.message : "Guest race creation failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/guest-race",
      game: "Solitaire Duel",
      metadata: { operation: "create_guest_race" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
