import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats, users } from "../../../../db/schema";
import { eq, and, sql } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { gameId, reason = "left" } = await req.json();

    if (!gameId) {
      return Response.json(
        { error: "Missing gameId" },
        { status: 400 }
      );
    }

    // ✅ Get match
    const match = await db.query.tankMatches.findFirst({
      where: eq(tankMatches.matchId, gameId),
    });

    if (!match) {
      return Response.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    const players = Array.isArray(match.players) ? match.players : [];
    const mode = match?.settings?.mode === "battle_royale" ? "battle_royale" : "duel";
    const preLeaveStats = await db
      .select({ clerkId: tankStats.clerkId, bounty: tankStats.bounty })
      .from(tankStats)
      .where(eq(tankStats.matchId, gameId));

    if (!players.includes(userId)) {
      return Response.json({ success: true });
    }

    const updatedPlayers = players.filter(
      (p) => p !== userId
    );

    // Leaving/disconnecting from an active match counts as a forfeit.
    await db
      .update(tankStats)
      .set({
        result: "lose",
        amountCashedOut: 0,
        bounty: "0.00",
      })
      .where(
        and(
          eq(tankStats.matchId, gameId),
          eq(tankStats.clerkId, userId)
        )
      );

    /* ✅ ATOMIC PLAYER COUNT UPDATE */
    const nextHostClerkId =
      mode === "battle_royale" && updatedPlayers.length > 0
        ? updatedPlayers[Math.floor(Math.random() * updatedPlayers.length)]
        : match.hostClerkId;

    const currentSettings = match?.settings ?? {};
    const nextReadyPlayers = Array.isArray(currentSettings.readyPlayers)
      ? currentSettings.readyPlayers.filter((id) => id !== userId)
      : currentSettings.readyPlayers;
    const readyCountAfterLeave = Array.isArray(nextReadyPlayers)
      ? updatedPlayers.filter((id) => nextReadyPlayers.includes(id)).length
      : 0;
    const nextPlayerStates =
      currentSettings.playerStates && typeof currentSettings.playerStates === "object"
        ? Object.fromEntries(Object.entries(currentSettings.playerStates).filter(([id]) => id !== userId))
        : currentSettings.playerStates;
    const isBattleRoyaleWaiting = mode === "battle_royale" && !Boolean(match.gameStarted);

    await db
      .update(tankMatches)
      .set({
        players: updatedPlayers,
        currentPlayers: sql`GREATEST(current_players - 1, 0)`,
        hostClerkId: nextHostClerkId,
        settings: {
          ...currentSettings,
          readyPlayers: nextReadyPlayers,
          playerStates: nextPlayerStates,
          countdownEndsAt: isBattleRoyaleWaiting && readyCountAfterLeave < 2 ? null : currentSettings.countdownEndsAt ?? null,
          countdownDuration: isBattleRoyaleWaiting && readyCountAfterLeave < 2 ? null : currentSettings.countdownDuration ?? null,
        },
        gameStarted: mode === "battle_royale" ? Boolean(match.gameStarted) : updatedPlayers.length >= 2,
      })
      .where(eq(tankMatches.matchId, gameId));

    if (mode === "duel" && updatedPlayers.length === 1) {
      const winnerId = updatedPlayers[0];
      const winnerBet = Number(preLeaveStats.find((s) => s.clerkId === winnerId)?.bounty ?? 0);
      const loserBet = Number(preLeaveStats.find((s) => s.clerkId === userId)?.bounty ?? 0);
      const payout = winnerBet + loserBet * 0.9;

      await db
        .update(tankStats)
        .set({
          result: "win",
          amountCashedOut: payout,
        })
        .where(and(eq(tankStats.matchId, gameId), eq(tankStats.clerkId, winnerId)));

      await db
        .update(users)
        .set({ balance: sql`${users.balance} + ${payout}` })
        .where(eq(users.clerkId, winnerId));
    }

    /* ✅ Check if match is now empty */
    const updatedMatch = await db.query.tankMatches.findFirst({
      where: eq(tankMatches.matchId, gameId),
    });

    const shouldDeleteMatch =
      !updatedMatch ||
      updatedMatch.currentPlayers === 0 ||
      (mode === "duel" && updatedPlayers.length <= 1) ||
      (reason === "eliminated" && mode === "duel");

    if (shouldDeleteMatch) {
      await db
        .delete(tankMatches)
        .where(eq(tankMatches.matchId, gameId));

      return Response.json({
        success: true,
        deleted: true,
      });
    }

    return Response.json({ success: true });

  } catch (err) {
    console.error("Leave match error:", err);

    return Response.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}
