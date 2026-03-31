import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankStats, users, tankMatches } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

function getErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  return String(error);
}

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

    const settingsString = JSON.stringify(safeSettings);
    const playersString = JSON.stringify(safePlayers);

    try {
      await db.update(users).set({ balance: newBalance }).where(eq(users.clerkId, userId));
    } catch (balanceUpdateError) {
      console.error("[start-battle-royale] Failed to update balance:", balanceUpdateError);
      return NextResponse.json({ error: "Unable to reserve bet amount" }, { status: 500 });
    }

    let settingsValue = safeSettings;
    let playersValue = safePlayers;

    const primaryMatchPayload = {
      matchId,
      hostClerkId: userId,
      maxPlayers: 10,
      currentPlayers: 1,
      isOpen: true,
      gameStarted: false,
      settings: safeSettings,
      players: safePlayers,
    };

    const fallbackJsonPayload = {
      ...primaryMatchPayload,
      settings: settingsString,
      players: playersString,
    };

    const fallbackLegacyPayload = {
      matchId,
      hostClerkId: userId,
      maxPlayers: 10,
      isOpen: true,
      settings: settingsString,
      players: playersString,
    };

    try {
      await db.insert(tankMatches).values(primaryMatchPayload);
    } catch (primaryInsertError) {
      const primaryMessage = getErrorMessage(primaryInsertError);
      console.error("[start-battle-royale] Match insert primary payload failed:", primaryInsertError);

      try {
        await db.insert(tankMatches).values(fallbackJsonPayload);
      } catch (jsonFallbackError) {
        const jsonFallbackMessage = getErrorMessage(jsonFallbackError);
        console.error("[start-battle-royale] Match insert JSON fallback failed:", jsonFallbackError);

        const looksLikeSchemaDrift =
          primaryMessage.toLowerCase().includes("column") ||
          primaryMessage.toLowerCase().includes("does not exist") ||
          jsonFallbackMessage.toLowerCase().includes("column") ||
          jsonFallbackMessage.toLowerCase().includes("does not exist");

        if (looksLikeSchemaDrift) {
          try {
            await db.insert(tankMatches).values(fallbackLegacyPayload);
          } catch (legacyFallbackError) {
            console.error("[start-battle-royale] Match insert legacy fallback failed:", legacyFallbackError);
            return NextResponse.json(
              { error: "Unable to create match", detail: getErrorMessage(legacyFallbackError) },
              { status: 400 }
            );
          }
        } else {
          return NextResponse.json(
            { error: "Unable to create match", detail: jsonFallbackMessage },
            { status: 400 }
          );
        }
      }
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
      return NextResponse.json(
        { error: "Match created, but failed to create player stats", detail: getErrorMessage(statsInsertError) },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true, matchId, player: inserted?.[0] || null, newBalance }, { status: 200 });
  } catch (err) {
    console.error("Start battle royale error:", err);
    return NextResponse.json({ error: "Server error", detail: String(err) }, { status: 500 });
  }
}
