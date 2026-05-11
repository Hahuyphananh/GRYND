import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const games = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.isPrivate, false));
    const openGames = games
      .map((g) => {
        const seats = Array.isArray(g.players) ? g.players : [];
        const occupied = seats.filter((s) => s?.clerkId).length;
        const openSeats = Math.max((g.maxPlayers ?? 6) - occupied, 0);
        const hostSeat = seats.find((s) => s?.clerkId);

        return {
          gameCode: g.gameCode,
          maxPlayers: g.maxPlayers ?? 6,
          occupiedSeats: occupied,
          openSeats,
          hostName: hostSeat?.name || "Host",
          createdAt: g.createdAt,
        };
      })
      .filter((g) => g.openSeats > 0);

    return NextResponse.json({ count: openGames.length, games: openGames });
  } catch (err) {
    console.error("FETCH PUBLIC GAMES ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
