import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";

const SEAT_COUNT = 6;
const emptySeatGrid = () =>
  Array.from({ length: SEAT_COUNT }, (_, i) => ({ seat: i, clerkId: null }));

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const playerName = body.playerName ?? "Player";
    const preferredGameCode = body.gameCode ?? null;

    const games = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.isPrivate, false));
    const availableGames = games.filter((g) => {
      const seats = Array.isArray(g.players) ? g.players : [];
      const occupied = seats.filter((s) => s?.clerkId).length;
      return (
        occupied < (g.maxPlayers ?? 6) &&
        !seats.some((s) => s?.clerkId === userId)
      );
    });

    const randomGame = preferredGameCode
      ? availableGames.find((g) => g.gameCode === preferredGameCode)
      : availableGames[0];

    if (!randomGame)
      return NextResponse.json(
        {
          error: preferredGameCode
            ? "Selected game is no longer available"
            : "No available public games",
        },
        { status: 404 },
      );

    const rawSeats = Array.isArray(randomGame.players) ? randomGame.players : [];
    // Self-heal rows whose `players` column was NULL or empty before the
    // create-game route started seeding an explicit 6-seat grid. The seed
    // is folded into the same UPDATE that places the joining user, so
    // legacy rows permanently heal without a second round-trip.
    const seats = rawSeats.length
      ? rawSeats
      : Array.from({ length: 6 }, (_, i) => ({ seat: i, clerkId: null }));
    const emptySeat = seats.find((s) => s?.clerkId === null);
    if (!emptySeat)
      return NextResponse.json({ error: "No open seat" }, { status: 400 });

    const updatedPlayers = seats.map((s) =>
      s.seat === emptySeat.seat
        ? {
            ...s,
            clerkId: userId,
            name: playerName,
            isAI: false,
            stack: s.stack ?? 1000,
          }
        : s,
    );

    const [updatedGame] = await db
      .update(pokerGames)
      .set({ players: updatedPlayers })
      .where(eq(pokerGames.gameCode, randomGame.gameCode))
      .returning();

    return NextResponse.json({
      success: true,
      game: updatedGame,
      gameCode: updatedGame.gameCode,
    });
  } catch (err) {
    console.error("JOIN PUBLIC GAME ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
