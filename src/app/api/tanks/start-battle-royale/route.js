import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankStats, users, tankMatches } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export async function POST(req) {
  try {
    let userId;
    try {
      const authResult = await auth();
      userId = authResult?.userId;
    } catch (authError) {
      console.error("[start-battle-royale] Clerk auth failed:", authError);
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await req.json().catch((parseError) => {
      console.warn("[start-battle-royale] Invalid JSON body:", parseError);
      return {};
    });

    const bet = Number(body?.betAmount);

    if (!Number.isFinite(bet)) {
      return NextResponse.json({ error: "Invalid bet amount" }, { status: 400 });
    }

    if (bet <= 0) {
      return NextResponse.json({ error: "Invalid bet amount" }, { status: 400 });
    }

    let existingUser;
    try {
      existingUser = await db
        .select()
        .from(users)
        .where(eq(users.clerkId, userId))
        .limit(1);
    } catch (userLookupError) {
      console.error("[start-battle-royale] Failed to fetch user:", userLookupError);
      return NextResponse.json({ error: "Unable to fetch user" }, { status: 500 });
    }

    if (existingUser.length === 0) {
      return NextResponse.json({ error: "User not found in DB" }, { status: 404 });
    }

    const dbUser = existingUser[0];
    const balance = Number(dbUser.balance);

    if (balance < bet) {
      return NextResponse.json({ error: "Insufficient balance" }, { status: 400 });
    }

    const newBalance = balance - bet;
    const safeSettings = {
      mapSeed: Math.floor(Math.random() * 1_000_000_000),
      mode: "battle_royale",
      mapProfile: "classic",
      playerStates: {},
      readyPlayers: [],
      countdownEndsAt: null,
      countdownDuration: null,
    };
    const safePlayers = [userId];

    let settingsValue = safeSettings;
    let playersValue = safePlayers;

    try {
      // Defensive serialization for environments where JSON insertions are strict.
      JSON.stringify(safeSettings);
      JSON.stringify(safePlayers);
    } catch (serializationError) {
      console.error("[start-battle-royale] Failed to serialize settings/players:", serializationError);
      settingsValue = JSON.stringify(safeSettings);
      playersValue = JSON.stringify(safePlayers);
    }

    try {
      await db.update(users).set({ balance: newBalance }).where(eq(users.clerkId, userId));
    } catch (balanceUpdateError) {
      console.error("[start-battle-royale] Failed to update balance:", balanceUpdateError);
      return NextResponse.json({ error: "Unable to reserve bet amount" }, { status: 500 });
    }

    const matchId = nanoid(12);

    try {
      await db.insert(tankMatches).values({
        matchId,
        hostClerkId: userId,
        maxPlayers: 10,
        currentPlayers: 1,
        isOpen: true,
        gameStarted: false,
        settings: settingsValue,
        players: playersValue,
      });
    } catch (matchInsertError) {
      console.error("[start-battle-royale] Failed to create match:", matchInsertError);
      return NextResponse.json({ error: "Unable to create match" }, { status: 500 });
    }

    let inserted;
    try {
      inserted = await db
        .insert(tankStats)
        .values({
          matchId,
          clerkId: userId,
          username: dbUser?.name || "Anonymous",
          bounty: bet,
          kills: 0,
          amountCashedOut: 0,
          result: null,
        })
        .returning();
    } catch (statsInsertError) {
      console.error("[start-battle-royale] Failed to create player stats:", statsInsertError);
      return NextResponse.json({ error: "Match created, but failed to create player stats" }, { status: 500 });
    }

    return NextResponse.json({ success: true, matchId, player: inserted?.[0] || null, newBalance }, { status: 200 });
  } catch (err) {
    console.error("Start battle royale error:", err);
    return NextResponse.json({ error: "Server error", detail: String(err) }, { status: 500 });
  }
}
