import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { diceMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // AI matches are free play — do NOT deduct tokens. We still record the
  // wager the client sent so the match row has a wager value (for display
  // and history), but no money actually moves on either end of the match.
  // `wager` is intentionally defaulted to 0.
  const { wager = 0 } = await req.json().catch(() => ({}));
  const amount = Math.max(0, Number(wager) || 0);

  // No balance check / deduction — AI is free play. The match row simply
  // records `wager` (capped at 0 by the default) and `houseFee = 0`.

  const [row] = await db
    .insert(diceMatches)
    .values({
      lobbyId: null,
      player1Id: userId,
      player2Id: "AI_BOT",
      wager: amount,
      prizePaid: 0,
      houseFee: 0,
      hp1: 20,
      hp2: 22,
      turnUserId: userId,
      round: 1,
      status: "active",
    })
    .returning({ id: diceMatches.id });

  return NextResponse.json({
    ok: true,
    matchId: row.id,
  });
}
