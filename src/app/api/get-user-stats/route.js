import { NextResponse } from "next/server";
import { db } from "../../../db"; // adjust to your actual db path
import { users } from "../../../db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    // Fetch only the needed columns
    const allUsers = await db
      .select({
        name: users.name,
        gamesWon: users.gamesWon,
        gamesLost: users.gamesLost,
      })
      .from(users);

    // Compute netGames and rank
    const rankedUsers = allUsers
      .map((u) => ({
        ...u,
        netGames: u.gamesWon - u.gamesLost,
      }))
      .sort((a, b) => b.netGames - a.netGames)
      .map((u, index) => ({
        rank: index + 1,
        ...u,
      }));

    return NextResponse.json({ success: true, users: rankedUsers });
  } catch (error) {
    console.error("Error fetching user stats:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch user stats" },
      { status: 500 }
    );
  }
}
