import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
export async function GET() {
  // Fetch waiting games (joinable)
  const waitingGames = await db
    .select({
      id: hexDuelGames.id,
      wagerAmount: hexDuelGames.wagerAmount,
      hostClerkId: hexDuelGames.player1Id,
      hostName: users.name,
      status: hexDuelGames.status,
      createdAt: hexDuelGames.createdAt,
    })
    .from(hexDuelGames)
    .leftJoin(users, eq(users.clerkId, hexDuelGames.player1Id))
    .where(and(eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id)))
    .orderBy(desc(hexDuelGames.createdAt))
    .limit(40);

  // Fetch in-progress games (spectatable)
  const inProgressGames = await db
    .select({
      id: hexDuelGames.id,
      wagerAmount: hexDuelGames.wagerAmount,
      hostClerkId: hexDuelGames.player1Id,
      hostName: users.name,
      status: hexDuelGames.status,
      createdAt: hexDuelGames.createdAt,
    })
    .from(hexDuelGames)
    .leftJoin(users, eq(users.clerkId, hexDuelGames.player1Id))
    .where(inArray(hexDuelGames.status, ["in_progress", "turn_player1", "turn_player2"]))
    .orderBy(desc(hexDuelGames.createdAt))
    .limit(20);

  return NextResponse.json({
    success: true,
    games: waitingGames,
    liveGames: inProgressGames,
  });
}
