import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { and, eq, inArray, or } from "drizzle-orm";

// Ends any open game for this user.
// Optional body: { gameId?: number, result?: "win" | "loss" | "draw" }
export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return new Response("Unauthorized", { status: 401 });

    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const requestedGameId = Number(body?.gameId);
    const hasRequestedGameId = Number.isFinite(requestedGameId) && requestedGameId > 0;
    const normalizedResult = typeof body?.result === "string" ? body.result.toLowerCase() : null;
    const allowedResult = ["win", "loss", "draw"].includes(normalizedResult)
      ? normalizedResult
      : null;

    const whereBase = and(
      or(eq(chessGames.playerWhiteId, userId), eq(chessGames.playerBlackId, userId)),
      inArray(chessGames.status, ["waiting", "active", "in_progress"])
    );

    const openGame = hasRequestedGameId
      ? await db
          .select()
          .from(chessGames)
          .where(and(whereBase, eq(chessGames.id, requestedGameId)))
          .limit(1)
      : await db.select().from(chessGames).where(whereBase).limit(1);

    if (openGame.length === 0) {
      return new Response("No active game found", { status: 200 });
    }

    const gameId = openGame[0].id;
    const updatePayload = {
      status: "expired",
      ...(allowedResult ? { result: allowedResult } : {}),
    };

    await db.update(chessGames).set(updatePayload).where(eq(chessGames.id, gameId));

    return new Response("Game expired", { status: 200 });
  } catch (err) {
    console.error("End-game error:", err);
    return new Response("Server error", { status: 500 });
  }
}
