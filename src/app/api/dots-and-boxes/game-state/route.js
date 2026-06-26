import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { dotsAndBoxesGames, users } from "../../../../db/schema";

function getPlayerRole(game, clerkId) {
  if (game.hostClerkId === clerkId) return "host";
  if (game.guestClerkId === clerkId) return "guest";
  return null;
}

export async function GET(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const gameId = Number(searchParams.get("gameId"));
    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(dotsAndBoxesGames)
      .where(eq(dotsAndBoxesGames.id, gameId))
      .limit(1);
    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const role = getPlayerRole(game, userId) || "spectator";

    const [hostName, guestName] = await Promise.all([
      db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.clerkId, game.hostClerkId))
        .limit(1)
        .then((rows) => rows[0]?.name || null),
      game.guestClerkId
        ? db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.clerkId, game.guestClerkId))
            .limit(1)
            .then((rows) => rows[0]?.name || null)
        : null,
    ]);

    return NextResponse.json({
      success: true,
      data: {
        ...game,
        role,
        hostName: hostName || "Host",
        guestName: guestName || "Guest",
      },
    });
  } catch (error) {
    console.error("dots-and-boxes game-state error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
