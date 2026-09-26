import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
import { normalizeStake } from "../../../../../lib/games/stakes";
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    const { wager } = await req.json();
    // STAKES ARE RETIRED (src/lib/games/stakes.js) — a match is free to open,
    // so the requested wager is ignored rather than validated.
    const wagerAmount = normalizeStake(wager);

    const result = await db.transaction(async (tx) => {
      const [game] = await tx.insert(hexDuelGames).values({
        player1Id: userId,
        wagerAmount: wagerAmount.toFixed(2),
        winner: "pending",
        result: "pending",
        status: "waiting",
        isAiGame: false,
        // Migration 0054: server-authoritative turn columns. Leaving
        // both null while the game is in `waiting` is correct — the
        // `/multiplayer/join` route sets `current_turn = 'player1'`
        // and `last_action_seq = 0` the moment player2 joins.
      } as any).returning({ id: hexDuelGames.id });

      return { gameId: game.id, newBalance: null };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Unable to create game" }, { status: 500 });
  }
}
