import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const games = await db.select().from(pokerGames).where(eq(pokerGames.isPrivate, false));
    const openGames = games.filter((g) => {
      const seats = Array.isArray(g.players) ? g.players : [];
      const occupied = seats.filter((s) => s?.clerkId).length;
      return occupied < (g.maxPlayers ?? 6);
    });

    return NextResponse.json({ count: openGames.length });
  } catch (err) {
    console.error("FETCH PUBLIC GAMES ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
