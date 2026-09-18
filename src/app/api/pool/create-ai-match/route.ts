import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db";
import { poolMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json(
        { ok: false, message: "Unauthorized" },
        { status: 401 },
      );
    const { wager = 10 } = await req.json().catch(() => ({}));
    // Global bet cap (must match GLOBAL_MAX_BET in src/lib/games/economy.ts).
    if (!Number.isFinite(Number(wager)) || Number(wager) <= 0 || Number(wager) > 100000) {
      return NextResponse.json(
        { ok: false, message: "Wager must be between 1 and 100,000 tokens" },
        { status: 400 },
      );
    }
    const firstTurnSeat = Math.random() < 0.5 ? 1 : 2;
    const [m] = await db
      .insert(poolMatches)
      .values({
        id: crypto.randomUUID(),
        player1Id: userId,
        player2Id: "AI",
        wager: Number(wager),
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
