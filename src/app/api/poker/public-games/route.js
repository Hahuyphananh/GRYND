import { NextResponse } from "next/server";
import { db } from "../../../../db/client"
import { pokerGames } from "../../../../db/schema";
import { and, lt, eq, sql } from "drizzle-orm";

export async function GET() {
  try {
    const games = await db
      .select()
      .from(pokerGames)
      .where(
        and(
          eq(pokerGames.isPrivate, false),
          lt(sql`jsonb_array_length(${pokerGames.players})`, pokerGames.maxPlayers)
        )
      );

    return NextResponse.json({
      count: games.length,
    });
  } catch (err) {
    console.error("FETCH PUBLIC GAMES ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
