import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
export async function GET() {
  const games = await db
    .select({
      id: hexDuelGames.id,
      wagerAmount: hexDuelGames.wagerAmount,
      hostClerkId: hexDuelGames.player1Id,
      hostName: users.name,
      createdAt: hexDuelGames.createdAt,
    })
    .from(hexDuelGames)
    .leftJoin(users, eq(users.clerkId, hexDuelGames.player1Id))
    .where(and(eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id)))
    .orderBy(desc(hexDuelGames.createdAt))
    .limit(40);
  return NextResponse.json({ success: true, games });
}
