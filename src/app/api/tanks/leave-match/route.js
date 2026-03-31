import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { tankMatches, tankStats } from "../../../../db/schema";
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

    const { gameId } = await req.json();

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

    if (!players.includes(userId)) {
      return Response.json({ success: true });
    }

    const updatedPlayers = players.filter(
      (p) => p !== userId
    );

    /* ✅ DELETE ONLY THIS PLAYER'S STATS */
    await db.delete(tankStats).where(
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
    const nextPlayerStates =
      currentSettings.playerStates && typeof currentSettings.playerStates === "object"
        ? Object.fromEntries(Object.entries(currentSettings.playerStates).filter(([id]) => id !== userId))
        : currentSettings.playerStates;

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
          countdownEndsAt: mode === "battle_royale" ? null : currentSettings.countdownEndsAt ?? null,
          countdownDuration: mode === "battle_royale" ? null : currentSettings.countdownDuration ?? null,
        },
        gameStarted: mode === "battle_royale" ? true : updatedPlayers.length >= 2,
      })
      .where(eq(tankMatches.matchId, gameId));

    /* ✅ Check if match is now empty */
    const updatedMatch = await db.query.tankMatches.findFirst({
      where: eq(tankMatches.matchId, gameId),
    });

    if (!updatedMatch || updatedMatch.currentPlayers === 0) {
      await db
        .delete(tankMatches)
        .where(eq(tankMatches.matchId, gameId));

      await db
        .delete(tankStats)
        .where(eq(tankStats.matchId, gameId));

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
