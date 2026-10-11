import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";
import { db } from "../../../../db";
import { poolMatches } from "../../../../db/schema";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req: Request) {
  try {
    // Free practice: a signed-out visitor gets a guest identity here (the only
    // pool route that mints one). Everything below is unrated — the AI seat
    // holds no pot and no rewards — so a guest is exactly as safe as a
    // signed-in player. PvP stays behind requireAgeVerifiedUser (/api/pool/
    // create-lobby, /join-lobby).
    const gate = await requirePracticePlayer({ create: true });
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    if (!userId) {
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );
    }
    // STAKES ARE RETIRED (src/lib/games/stakes.js): a practice match is free.
    //
    // The requested wager is normalized to 0 through the shared seam, so the row
    // carries no stake and no range check can reject free play. This route used to
    // validate `wager > 0` against the global bet cap (and default a missing wager
    // to 10), so the lobby's own `{ wager: 0 }` came back as a wager-range error and
    // the practice match never started — the one pool entry point left out of the
    // retirement. (The message itself is retired; see tests/stakes-retired.test.mjs.)
    const { wager } = await req.json().catch(() => ({}));
    const stake = normalizeStake(wager);
    const firstTurnSeat = Math.random() < 0.5 ? 1 : 2;
    const [m] = await db
      .insert(poolMatches)
      .values({
        id: crypto.randomUUID(),
        player1Id: userId,
        player2Id: "AI",
        wager: stake,
        status: "active",
        gameState: {
          ai: true,
          started: true,
          turn: firstTurnSeat,
          version: Date.now(),
        },
        currentTurnUserId: firstTurnSeat === 1 ? userId : "AI",
      })
      .returning({ id: poolMatches.id });
    return NextResponse.json({ ok: true, matchId: m.id, firstTurnSeat });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, message: error?.message || "Unable to create AI match" },
      { status: 500 },
    );
  }
}
