import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tankStats } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const matchId = url.searchParams.get("matchId");

    if (!matchId) {
      return NextResponse.json(
        { error: "Missing matchId" },
        { status: 400 }
      );
    }

    const match = await db
      .select()
      .from(tankStats)
      .where(eq(tankStats.matchId, matchId));

    if (match.length === 0) {
      return NextResponse.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(match[0], { status: 200 });

  } catch (err) {
    console.error("Get match error:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
