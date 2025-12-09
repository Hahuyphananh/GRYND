import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";

export async function POST(req) {
  try {
    const body = await req.json();
    const { code } = body;

    if (!code)
      return NextResponse.json({ error: "Invite code missing" }, { status: 400 });

    // Clerk ID of the joining user
    const { userId: clerkId } = await auth();
    if (!clerkId)
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    // 1️⃣ Fetch the specific game using invite code
    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, code));

    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    // 2️⃣ Ensure game has open seats
    const updatedPlayers = [...game.players];
    const openSeat = updatedPlayers.find((p) => p.clerkId === null);

    if (!openSeat)
      return NextResponse.json({ error: "No empty seats" }, { status: 400 });

    // 3️⃣ Assign seat to the joining player
    openSeat.clerkId = clerkId;

    // 4️⃣ Save updated JSON array
    const [updatedGame] = await db
      .update(pokerGames)
      .set({
        players: sql`${JSON.stringify(updatedPlayers)}::jsonb`,
      })
      .where(eq(pokerGames.id, game.id))
      .returning();

    return NextResponse.json({
      success: true,
      game: updatedGame,
      joinedSeat: openSeat.seat,
    });
  } catch (err) {
    console.error("JOIN PRIVATE GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
