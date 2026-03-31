import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankStats, users, tankMatches } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const bet = Number(body?.betAmount);

    if (!bet || bet <= 0) {
      return NextResponse.json({ error: "Invalid bet amount" }, { status: 400 });
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (existingUser.length === 0) {
      return NextResponse.json({ error: "User not found in DB" }, { status: 404 });
    }

    const dbUser = existingUser[0];
    const balance = Number(dbUser.balance);

    if (balance < bet) {
      return NextResponse.json({ error: "Insufficient balance" }, { status: 400 });
    }

    await db.update(users).set({ balance: balance - bet }).where(eq(users.clerkId, userId));

    const matchId = nanoid(12);

    await db.insert(tankMatches).values({
      matchId,
      hostClerkId: userId,
      maxPlayers: 10,
      currentPlayers: 1,
      isOpen: true,
      gameStarted: false,
      settings: {
        mapSeed: Math.floor(Math.random() * 1_000_000_000),
        mode: "battle_royale",
        mapProfile: "classic",
        playerStates: {},
        readyPlayers: [],
        countdownEndsAt: null,
        countdownDuration: null,
      },
      players: [userId],
    });

    const inserted = await db
      .insert(tankStats)
      .values({
        matchId,
        clerkId: userId,
        username: dbUser.name,
        bounty: bet,
        kills: 0,
        amountCashedOut: 0,
        result: null,
      })
      .returning();

    return NextResponse.json({ success: true, matchId, player: inserted[0], newBalance: balance - bet }, { status: 200 });
  } catch (err) {
    console.error("Start battle royale error:", err);
    return NextResponse.json({ error: "Server error", detail: String(err) }, { status: 500 });
  }
}
