import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";

export async function GET() {
  try {
    const games = await db
      .select({
        id: dotsAndBoxesGames.id,
        betAmount: dotsAndBoxesGames.betAmount,
        hostClerkId: dotsAndBoxesGames.hostClerkId,
        hostName: users.name,
        createdAt: dotsAndBoxesGames.createdAt,
      })
      .from(dotsAndBoxesGames)
      .leftJoin(users, eq(users.clerkId, dotsAndBoxesGames.hostClerkId))
      .where(
        and(
          eq(dotsAndBoxesGames.status, "waiting"),
          isNull(dotsAndBoxesGames.guestClerkId),
        ),
      )
      .orderBy(desc(dotsAndBoxesGames.createdAt))
      .limit(40);

    return NextResponse.json({ success: true, games });
  } catch (error) {
    console.error("dots-and-boxes available-games error", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
