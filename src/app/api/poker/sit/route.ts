import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

type Seat = {
  seat: number;
  clerkId: string | null;
  name?: string;
  isAI?: boolean;
  stack?: number;
};

function normalizePlayersFromSeats(seats: Seat[]) {
  return seats
    .filter((s) => s.clerkId)
    .map((s) => ({
      id: s.clerkId,
      name: s.name || (s.isAI ? "AI" : "Player"),
      stack: s.stack ?? 1000,
      hand: [],
      isAI: !!s.isAI,
      hasFolded: false,
      lastAction: "",
      currentBet: 0,
      seatIndex: s.seat,
    }));
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { gameCode, seatIndex, playerName, isAI, aiStack } = await req.json();
    if (!gameCode || seatIndex === undefined) {
      return NextResponse.json(
        { error: "gameCode and seatIndex are required" },
        { status: 400 },
      );
    }

    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, gameCode));
    if (!game)
      return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const players = (game.players as Seat[]) || [];
    const meta =
      (game.playerPositions as { hostClerkId?: string } | null) || {};
    const isHost = meta.hostClerkId === userId;

    if (isAI && !isHost) {
      return NextResponse.json(
        { error: "Only host can add AI" },
        { status: 403 },
      );
    }

    if (!isAI && players.some((p) => p.clerkId === userId)) {
      return NextResponse.json(
        { error: "User already seated" },
        { status: 400 },
      );
    }

    const seatObj = players.find((p) => p.seat === seatIndex);
    if (!seatObj)
      return NextResponse.json({ error: "Invalid seat" }, { status: 400 });
    if (seatObj.clerkId !== null)
      return NextResponse.json(
        { error: "Seat already taken" },
        { status: 400 },
      );

    const updatedPlayers = players.map((p) => {
      if (p.seat !== seatIndex) return p;
      if (isAI) {
        return {
          ...p,
          clerkId: `ai_${Date.now()}`,
          name: playerName || "AI",
          isAI: true,
          stack: Number(aiStack) || 1000,
        };
      }
      return {
        ...p,
        clerkId: userId,
        name: playerName || "Player",
        isAI: false,
        stack: p.stack ?? 1000,
      };
    });

    const currentState = (meta as { state?: any } | null)?.state;
    const nextState = {
      ...(currentState ?? {}),
      players: normalizePlayersFromSeats(updatedPlayers),
    };

    const [updatedGame] = await db
      .update(pokerGames)
      .set({
        players: updatedPlayers,
        playerPositions: { ...(meta || {}), state: nextState },
      })
      .where(eq(pokerGames.gameCode, gameCode))
      .returning();

    return NextResponse.json({ success: true, game: updatedGame });
  } catch (err) {
    console.error("POKER SIT ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
