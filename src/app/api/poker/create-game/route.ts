import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { userId, isPrivate, maxPlayers } = body;

    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    const [game] = await db
      .insert(pokerGames)
      .values({
        userId,
        inviteCode,
        isPrivate: isPrivate ?? false,
        maxPlayers: maxPlayers ?? 6,
      } as typeof pokerGames.$inferInsert)
      .returning();

    return NextResponse.json({ success: true, game });
  } catch (err) {
    console.error("Create game error:", err);
    return NextResponse.json({ success: false, error: "Failed to create game" });
  }
}
