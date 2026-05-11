import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { connectFourGames, users } from "../../../../db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";

export async function GET() {
  try {
    const games = await db
      .select({
        id: connectFourGames.id,
        betAmount: connectFourGames.betAmount,
        hostClerkId: connectFourGames.hostClerkId,
        hostName: users.name,
        timerSeconds: connectFourGames.timerSeconds,
        createdAt: connectFourGames.createdAt,
      })
      .from(connectFourGames)
      .leftJoin(users, eq(users.clerkId, connectFourGames.hostClerkId))
      .where(
        and(
          eq(connectFourGames.status, "waiting"),
          isNull(connectFourGames.guestClerkId),
        ),
      )
      .orderBy(desc(connectFourGames.createdAt))
      .limit(40);

    return NextResponse.json({ success: true, games });
  } catch (error) {
    console.error("connect-four available-games error", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
