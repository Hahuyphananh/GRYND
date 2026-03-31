import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats, users } from "../../../../db/schema";
import { eq, and, lt, desc, sql } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const requestedMatchId = body?.matchId || null;

    // 1️⃣ Find candidate matches (filtered down in JS to allow started BR lobbies)
    const matches = await db
      .select()
      .from(tankMatches)
      .where(
        requestedMatchId
          ? and(
              lt(tankMatches.currentPlayers, tankMatches.maxPlayers),
              eq(tankMatches.matchId, requestedMatchId)
            )
          : lt(tankMatches.currentPlayers, tankMatches.maxPlayers)
      )
      .orderBy(desc(tankMatches.currentPlayers))
      .limit(requestedMatchId ? 1 : 20);

    const selectedMatch = matches.find((candidate) => {
      const mode = candidate?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";
      if (mode === "battle_royale") {
        return true;
      }
      const currentPlayers = Number(candidate.currentPlayers ?? 0);
      return candidate.isOpen && !candidate.gameStarted && currentPlayers < 2;
    });

    if (!selectedMatch) {
      return NextResponse.json(
        { error: requestedMatchId ? "Selected match is no longer available." : "No matches available." },
        { status: 404 }
      );
    }
    const mode = selectedMatch?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";

    // 2️⃣ Prevent joining twice
    if (selectedMatch.players?.includes(userId)) {
      return NextResponse.json({
        success: true,
        matchId: selectedMatch.matchId,
      });
    }

    // 3️⃣ Get host bet amount
    const hostStats = await db
      .select()
      .from(tankStats)
      .where(eq(tankStats.matchId, selectedMatch.matchId))
      .limit(1);

    if (hostStats.length === 0) {
      return NextResponse.json(
        { error: "Host stats not found." },
        { status: 500 }
      );
    }

    const bet = Number(hostStats[0].bounty);

    // 4️⃣ Fetch joining user
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    if (existingUser.length === 0) {
      return NextResponse.json(
        { error: "User not found." },
        { status: 404 }
      );
    }

    const dbUser = existingUser[0];
    const balance = Number(dbUser.balance);

    if (balance < bet) {
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 400 }
      );
    }

    // 5️⃣ Deduct balance
    await db
      .update(users)
      .set({ balance: balance - bet })
      .where(eq(users.clerkId, userId));

    // 6️⃣ Atomic match update
    const targetMaxPlayers = mode === "battle_royale" ? 10 : 2;
    const nextPlayerCount = Number(selectedMatch.currentPlayers ?? 0) + 1;
    const shouldStartGame = mode === "battle_royale" ? true : nextPlayerCount >= 2;
    const shouldCloseLobby = nextPlayerCount >= targetMaxPlayers;

    const updatedPlayers = [...(Array.isArray(selectedMatch.players) ? selectedMatch.players : []), userId];
    const updatedSettings = {
      ...(selectedMatch.settings ?? {}),
      readyPlayers: mode === "battle_royale" ? null : selectedMatch?.settings?.readyPlayers ?? [],
      countdownEndsAt: mode === "battle_royale" ? null : selectedMatch?.settings?.countdownEndsAt ?? null,
      countdownDuration: mode === "battle_royale" ? null : selectedMatch?.settings?.countdownDuration ?? null,
    };

    const updated = await db
      .update(tankMatches)
      .set({
        currentPlayers: sql`${tankMatches.currentPlayers} + 1`,
        players: updatedPlayers,
        settings: updatedSettings,
        isOpen: shouldCloseLobby ? false : true,
        gameStarted: shouldStartGame,
      })
      .where(
        and(
          eq(tankMatches.matchId, selectedMatch.matchId),
          lt(tankMatches.currentPlayers, tankMatches.maxPlayers)
        )
      )
      .returning();

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "Match just filled. Try again." },
        { status: 400 }
      );
    }

    // 7️⃣ Insert joining player stats
    await db.insert(tankStats).values({
      matchId: selectedMatch.matchId,
      clerkId: userId,
      username: dbUser.name,
      bounty: bet,
      kills: 0,
      amountCashedOut: 0,
      result: null,
    });

    return NextResponse.json({
      success: true,
      matchId: selectedMatch.matchId,
      newBalance: balance - bet,
    });

  } catch (err) {
    console.error("Join game error FULL:", err);
    return NextResponse.json(
      { error: "Server error", detail: String(err) },
      { status: 500 }
    );
  }
}
