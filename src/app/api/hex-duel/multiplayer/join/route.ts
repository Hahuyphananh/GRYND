import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const { gameId } = await req.json();
  const [row] = await db.update(hexDuelGames).set({ player2Id: userId, status: "in_progress", startedAt: new Date() }).where(and(eq(hexDuelGames.id, Number(gameId)), eq(hexDuelGames.status, "waiting"), isNull(hexDuelGames.player2Id))).returning({ id: hexDuelGames.id });
  if (!row) return NextResponse.json({ success: false, error: "Game unavailable" }, { status: 400 });
  return NextResponse.json({ success: true, gameId: row.id });
}
