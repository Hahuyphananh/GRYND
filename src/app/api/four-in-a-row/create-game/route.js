import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { NextResponse } from "next/server";
import { normalizeStake } from "../../../../lib/games/stakes";
import { db } from "../../../../db/client";
import { fourInARowGames } from "../../../../db/schema";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    // STAKES ARE RETIRED (src/lib/games/stakes.js) — a lobby is free to open.
    const betAmount = normalizeStake(body.betAmount);
    const requestedTimerSeconds = Number(body?.timerSeconds);
    const timerSeconds = [10, 30, 60, 120].includes(requestedTimerSeconds)
      ? requestedTimerSeconds
      : 60;


    const [created] = await db
      .insert(fourInARowGames)
      .values({
        hostClerkId: userId,
        betAmount: betAmount.toFixed(2),
        status: "waiting",
        timerSeconds,
      })
      .returning({ id: fourInARowGames.id });

    return NextResponse.json({
      success: true,
      gameId: created.id,
    });
  } catch (error) {
    const message = error?.message || "Internal Server Error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
