import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, tankMatches, tankStats } from "../../../../db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { claimIdempotency } from "../../../../lib/security/idempotency";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const idem = await claimIdempotency(req, "tanks:cashout", 180);
    if (idem.enforced && !idem.allowed) {
      return NextResponse.json({ error: "Duplicate request" }, { status: 409 });
    }

    const parsed = await parseAndValidateJson(req, {
      matchId: { type: "string", required: false, minLength: 1, maxLength: 64, default: null },
      amount: { type: "number", required: false, min: 0, default: null },
    });
    if (!parsed.ok) return parsed.response;
    const requestedMatchId = parsed.data.matchId;

    // Find this player's active stats row (prefer current match from client)
    const playerStats = await db
      .select({ matchId: tankStats.matchId })
      .from(tankStats)
      .where(
        requestedMatchId
          ? and(
              eq(tankStats.clerkId, clerkId),
              eq(tankStats.matchId, requestedMatchId),
              isNull(tankStats.result)
            )
          : and(eq(tankStats.clerkId, clerkId), isNull(tankStats.result))
      )
      .orderBy(desc(tankStats.id))
      .limit(1);

    if (playerStats.length === 0) {
      return NextResponse.json(
        { error: "Player not in any active match" },
        { status: 400 }
      );
    }

    const { matchId } = playerStats[0];

    const statsRow = await db
      .select({ bounty: tankStats.bounty })
      .from(tankStats)
      .where(and(eq(tankStats.clerkId, clerkId), eq(tankStats.matchId, matchId), isNull(tankStats.result)))
      .limit(1);

    if (statsRow.length === 0) {
      return NextResponse.json({ error: "Active player stats not found" }, { status: 400 });
    }

    const matchRows = await db.select().from(tankMatches).where(eq(tankMatches.matchId, matchId)).limit(1);
    if (matchRows.length === 0) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    const mode = matchRows[0]?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";
    if (mode !== "battle_royale") {
      return NextResponse.json({ error: "Cash out is only available in battle royale" }, { status: 400 });
    }

    // Apply 90% payout (10% house cut) from authoritative server bounty
    const payout = Number(statsRow[0].bounty) * 0.9;

    // Update user balance
    const updated = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.clerkId, clerkId))
      .returning({ balance: users.balance });

    // Record amount cashed out + result = win (for history)
    await db
      .update(tankStats)
      .set({
        amountCashedOut: payout,
        result: "win",
      })
      .where(and(eq(tankStats.clerkId, clerkId), eq(tankStats.matchId, matchId)));

    // Manage match player count
    const match = matchRows;

    if (match.length > 0) {
      const m = match[0];
      const existingPlayers = Array.isArray(m.players) ? m.players : [];
      const remainingPlayers = existingPlayers.filter((id) => id !== clerkId);
      const newCount = Math.max(remainingPlayers.length, 0);

      if (newCount === 0) {
        // Delete match if no players left
        await db.delete(tankMatches).where(eq(tankMatches.matchId, matchId));
      } else {
        const existingSettings = m.settings ?? {};
        const existingPlayerStates = existingSettings.playerStates ?? {};
        const { [clerkId]: _removed, ...remainingPlayerStates } = existingPlayerStates;

        // Update remaining match participants and remove cashing-out tank from state
        await db
          .update(tankMatches)
          .set({
            currentPlayers: newCount,
            players: remainingPlayers,
            settings: {
              ...existingSettings,
              playerStates: remainingPlayerStates,
            },
          })
          .where(eq(tankMatches.matchId, matchId));
      }
    }

    return NextResponse.json(
      { success: true, newBalance: updated[0].balance, payout },
      { status: 200 }
    );
  } catch (err) {
    console.error("Error updating balance:", err);
    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}
