import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const { wager } = await req.json();
  const [game] = await db.insert(hexDuelGames).values({ player1Id: userId, wagerAmount: String(Number(wager || 0)), winner: "pending", result: "pending", status: "waiting", isAiGame: false } as any).returning({ id: hexDuelGames.id });
  return NextResponse.json({ success: true, gameId: game.id });
}
