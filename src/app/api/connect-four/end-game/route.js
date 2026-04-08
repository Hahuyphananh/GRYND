import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { connectFourGames } from "../../../../db/schema";
import { getPlayerRole, getUserAliases, settleConnectFourGame } from "../../../../lib/connectFourServer";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameId = Number(body?.gameId);

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    const [game] = await db.select().from(connectFourGames).where(eq(connectFourGames.id, gameId)).limit(1);
    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const userAliases = await getUserAliases(userId);
    const role = getPlayerRole(game, userAliases);
    if (!role) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    if (game.status === "waiting") {
      await settleConnectFourGame(gameId, null, "draw");
      return NextResponse.json({ success: true, ended: true });
    }

    if (game.status !== "in_progress") {
      return NextResponse.json({ success: true, ended: false });
    }

    const winnerClerkId = role === "host" ? game.guestClerkId : game.hostClerkId;
    await settleConnectFourGame(gameId, winnerClerkId, "forfeit");

    return NextResponse.json({ success: true, ended: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error?.message || "Unable to end game" }, { status: 400 });
  }
}
