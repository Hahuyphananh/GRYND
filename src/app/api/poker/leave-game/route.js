import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const gameCode = String(body?.gameCode ?? "").trim().toUpperCase();
    if (!gameCode) return NextResponse.json({ error: "Missing gameCode" }, { status: 400 });

    const [game] = await db.select().from(pokerGames).where(eq(pokerGames.gameCode, gameCode));
    if (!game) return NextResponse.json({ success: true, deleted: true });

    const seats = Array.isArray(game.players) ? game.players : [];
    const updatedSeats = seats.map((seat) => {
      if (seat?.clerkId !== userId) return seat;
      return {
        ...seat,
        clerkId: null,
        name: null,
        stack: 1000,
        isAI: false,
      };
    });

    const currentState = game?.playerPositions?.state && typeof game.playerPositions.state === "object"
      ? game.playerPositions.state
      : null;

    const updatedState = currentState
      ? {
          ...currentState,
          players: Array.isArray(currentState.players)
            ? currentState.players.filter((player) => player?.id !== userId)
            : currentState.players,
        }
      : currentState;

    const occupiedSeats = updatedSeats.filter((seat) => seat?.clerkId).length;
    if (!game.isPrivate && occupiedSeats === 0) {
      await db.delete(pokerGames).where(eq(pokerGames.gameCode, gameCode));
      return NextResponse.json({ success: true, deleted: true });
    }

    await db
      .update(pokerGames)
      .set({
        players: updatedSeats,
        playerPositions: {
          ...(game.playerPositions ?? {}),
          state: updatedState,
        },
        status: occupiedSeats > 1 ? game.status : "waiting",
      })
      .where(and(eq(pokerGames.gameCode, gameCode)));

    return NextResponse.json({ success: true, deleted: false, occupiedSeats });
  } catch (err) {
    console.error("LEAVE POKER GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
