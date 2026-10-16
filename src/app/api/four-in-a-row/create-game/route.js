import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { NextResponse } from "next/server";
import { requireStake } from "../../../../lib/games/stakes";
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
    // A ranked lobby always plays for coins: the requested stake is REQUIRED
    // and must be legal, so a crafted request can never open a free match.
    const wager = requireStake(body?.betAmount, "four-in-a-row");
    if (!wager.ok) {
      return NextResponse.json(
        { success: false, error: wager.error, code: wager.code },
        { status: wager.status },
      );
    }
    const requestedTimerSeconds = Number(body?.timerSeconds);
    const timerSeconds = [10, 30, 60, 120].includes(requestedTimerSeconds)
      ? requestedTimerSeconds
      : 60;


    const [created] = await db
      .insert(fourInARowGames)
      .values({
        hostClerkId: userId,
        betAmount: wager.stake.toFixed(2),
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
