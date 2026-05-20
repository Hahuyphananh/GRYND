import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
export async function GET() {
  const games = await db.select({ id: hexDuelGames.id, wagerAmount: hexDuelGames.wagerAmount }).from(hexDuelGames).where(and(eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id))).orderBy(desc(hexDuelGames.createdAt)).limit(20);
  return NextResponse.json({ success: true, games });
}
