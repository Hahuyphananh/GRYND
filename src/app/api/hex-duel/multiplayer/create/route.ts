import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
export async function POST(req: Request) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    const { wager } = await req.json();
    const wagerAmount = Number(wager);
    if (!Number.isFinite(wagerAmount) || wagerAmount < 0) {
      return NextResponse.json({ success: false, error: "Invalid wager amount" }, { status: 400 });
    }

    const result = await db.transaction(async (tx) => {
      let updatedBalance: number | null = null;
      if (wagerAmount > 0) {
        const [updatedUser] = await tx
          .update(users)
          .set({ balance: sql`${users.balance} - ${wagerAmount}` })
          .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${wagerAmount}`))
          .returning({ balance: users.balance });
        if (!updatedUser) throw new Error("Insufficient balance");
        updatedBalance = Number(updatedUser.balance);
      }

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

      return { gameId: game.id, newBalance: updatedBalance };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    const status = error?.message === "Insufficient balance" ? 400 : 500;
    return NextResponse.json({ success: false, error: error?.message || "Unable to create game" }, { status });
  }
}
