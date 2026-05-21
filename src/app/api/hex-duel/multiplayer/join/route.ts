import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    const { gameId, quickJoin } = await req.json();

    const joined = await db.transaction(async (tx) => {
      let game: typeof hexDuelGames.$inferSelect | undefined;
      if (Number.isFinite(Number(gameId)) && Number(gameId) > 0) {
        [game] = await tx.select().from(hexDuelGames).where(and(
          eq(hexDuelGames.id, Number(gameId)),
          eq(hexDuelGames.status, "waiting"),
          isNull(hexDuelGames.player2Id),
          ne(hexDuelGames.player1Id, userId),
        )).for("update");
      } else if (quickJoin) {
        [game] = await tx.select().from(hexDuelGames).where(and(
          eq(hexDuelGames.status, "waiting"),
          isNull(hexDuelGames.player2Id),
          ne(hexDuelGames.player1Id, userId),
        )).orderBy(asc(hexDuelGames.createdAt)).limit(1).for("update");
      }
      if (!game) throw new Error("No compatible game available");

      const [updatedUser] = await tx.update(users)
        .set({ balance: sql`${users.balance} - ${game.wagerAmount}` })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${game.wagerAmount}`))
        .returning({ balance: users.balance });
      if (!updatedUser) throw new Error("Insufficient balance");

      const [row] = await tx.update(hexDuelGames)
        .set({ player2Id: userId, status: "in_progress", startedAt: new Date() })
        .where(and(eq(hexDuelGames.id, game.id), eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id)))
        .returning({ id: hexDuelGames.id });
      if (!row) throw new Error("Game unavailable");
      return { gameId: row.id, newBalance: Number(updatedUser.balance) };
    });

    return NextResponse.json({ success: true, ...joined });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || "Unable to join game" }, { status: 400 });
  }
}
