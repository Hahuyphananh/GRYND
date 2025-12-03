import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats, users } from "../../../../db/schema";
import { eq, and, lt, desc } from "drizzle-orm";

export async function POST() {
  try {
    // 1️⃣ Auth
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // 2️⃣ Fetch user
    const userList = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (userList.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const dbUser = userList[0];

    // 3️⃣ Fetch most full open match (INCLUDING players array)
    const openMatches = await db
      .select({
        id: tankMatches.id,
        matchId: tankMatches.matchId,
        hostClerkId: tankMatches.hostClerkId,
        maxPlayers: tankMatches.maxPlayers,
        currentPlayers: tankMatches.currentPlayers,
        isOpen: tankMatches.isOpen,
        settings: tankMatches.settings,
        players: tankMatches.players, // ⭐ Required to update array
      })
      .from(tankMatches)
      .where(
        and(
          eq(tankMatches.isOpen, true),
          lt(tankMatches.currentPlayers, tankMatches.maxPlayers)
        )
      )
      .orderBy(desc(tankMatches.currentPlayers))
      .limit(1);

    if (openMatches.length === 0) {
      return NextResponse.json(
        { error: "No matches available, create a game." },
        { status: 404 }
      );
    }

    const match = openMatches[0];

    // 4️⃣ Already inside match?
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

    // 5️⃣ Insert into tank_stats
    const insertedPlayer = await db
      .insert(tankStats)
      .values({
        matchId: match.matchId,
        clerkId: userId,
        username: dbUser.name,
        bounty: 10,
        kills: 0,
        amountCashedOut: 0,
      })
      .returning();

    // 6️⃣ Update players array (NO DUPLICATES)
    const updatedPlayers = [
      ...(Array.isArray(match.players) ? match.players : []),
      userId
    ];

    // 7️⃣ Update match row
    const newCount = match.currentPlayers + 1;

    await db
      .update(tankMatches)
      .set({
        currentPlayers: newCount,
        players: updatedPlayers, // ⭐ IMPORTANT
        isOpen: newCount < match.maxPlayers,
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
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
