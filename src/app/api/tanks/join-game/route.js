import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats, users } from "../../../../db/schema";
import { eq, and, lt, desc } from "drizzle-orm";

export async function POST() {
  try {
    // Auth
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Get user from DB
    const userList = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (userList.length === 0) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const dbUser = userList[0];

    // 1️⃣ Find the MOST FULL open match (but not full)
    const openMatches = await db
      .select()
      .from(tankMatches)
      .where(
        and(
          eq(tankMatches.isOpen, true),
          lt(tankMatches.currentPlayers, tankMatches.maxPlayers),
          lt(tankMatches.currentPlayers, tankMatches.maxPlayers)
        )
      )
      .orderBy(desc(tankMatches.currentPlayers)) // fullest game first
      .limit(1);

    if (openMatches.length === 0 || openMatches[0].currentPlayers < 1) {
      return NextResponse.json(
        { error: "No matches available, create a game." },
        { status: 404 }
      );
    }

    const match = openMatches[0];

    // 2️⃣ Check if player already in this match
    const existingPlayer = await db
      .select()
      .from(tankStats)
      .where(
        and(
          eq(tankStats.matchId, match.matchId),
          eq(tankStats.clerkId, userId)
        )
      )
      .limit(1);

    if (existingPlayer.length > 0) {
      return NextResponse.json(
        {
          success: true,
          matchId: match.matchId,
          player: existingPlayer[0],
        },
        { status: 200 }
      );
    }

    // 3️⃣ Insert player into match
    const insertedPlayer = await db
      .insert(tankStats)
      .values({
        matchId: match.matchId,
        clerkId: userId,
        username: dbUser.name,
        bounty: 1,
        kills: 0,
        amountCashedOut: 0,
      })
      .returning();

    // 4️⃣ Update match player count
    const newPlayerCount = match.currentPlayers + 1;

    await db
      .update(tankMatches)
      .set({
        currentPlayers: newPlayerCount,
        isOpen: newPlayerCount >= match.maxPlayers ? false : true,
      })
      .where(eq(tankMatches.matchId, match.matchId));

    return NextResponse.json(
      {
        success: true,
        matchId: match.matchId,
        player: insertedPlayer[0],
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Join game error:", err);
    return NextResponse.json(
      {
        error: "Server error",
        detail: String(err),
      },
      { status: 500 }
    );
  }
}
