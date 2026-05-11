import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const { code } = body;

    if (!code)
      return NextResponse.json(
        { error: "Invite code missing" },
        { status: 400 },
      );

    const { userId: clerkId } = await auth();
    if (!clerkId)
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, code.trim().toUpperCase()));
    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    return NextResponse.json({ success: true, game });
  } catch (err) {
    console.error("JOIN PRIVATE GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
