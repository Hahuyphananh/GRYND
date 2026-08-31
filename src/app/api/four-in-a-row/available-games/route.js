import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { fourInARowGames, users } from "../../../../db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";

export async function GET() {
  try {
    const games = await db
      .select({
        id: fourInARowGames.id,
        betAmount: fourInARowGames.betAmount,
        hostClerkId: fourInARowGames.hostClerkId,
        hostName: users.name,
        timerSeconds: fourInARowGames.timerSeconds,
        createdAt: fourInARowGames.createdAt,
      })
      .from(fourInARowGames)
      .leftJoin(users, eq(users.clerkId, fourInARowGames.hostClerkId))
      .where(
        and(
          eq(fourInARowGames.status, "waiting"),
          isNull(fourInARowGames.guestClerkId),
        ),
      )
      .orderBy(desc(fourInARowGames.createdAt))
      .limit(40);

    return NextResponse.json({ success: true, games });
  } catch (error) {
    console.error("four-in-a-row available-games error", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
