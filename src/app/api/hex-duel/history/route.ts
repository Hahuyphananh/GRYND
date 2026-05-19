import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { hexDuelGames } from "../../../../db/schema";
import { desc, eq, sql } from "drizzle-orm";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function GET(req: Request) {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized — please sign in" },
        { status: 401 }
      );
    }

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT)
    );
    const offset = (page - 1) * limit;

    const [games, countResult] = await Promise.all([
      db
        .select()
        .from(hexDuelGames)
        .where(eq(hexDuelGames.player1Id, clerkId))
        .orderBy(desc(hexDuelGames.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(hexDuelGames)
        .where(eq(hexDuelGames.player1Id, clerkId)),
    ]);

    const total = countResult[0]?.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      success: true,
      data: {
        games,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore: page < totalPages,
        },
      },
    });
  } catch (error) {
    console.error("❌ Hex Duel history error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Server error",
        details: error instanceof Error ? error.message : "Unknown",
      },
      { status: 500 }
    );
  }
}
