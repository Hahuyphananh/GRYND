import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames } from "../../../../../db/schema";

/** Derive currentTurn from the status string */
function statusToTurn(status: string): "player1" | "player2" | null {
  if (status === "turn_player1") return "player1";
  if (status === "turn_player2") return "player2";
  return null;
}

export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const gameId = Number(searchParams.get("gameId"));

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(hexDuelGames)
      .where(
        and(
          eq(hexDuelGames.id, gameId),
          sql`(${hexDuelGames.player1Id} = ${userId} OR ${hexDuelGames.player2Id} = ${userId})`,
        ),
      )
      .limit(1);

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    const amHost = game.player1Id === userId;
    const bothJoined = game.player2Id !== null;
    const isReady = bothJoined && (game.status === "in_progress" || game.status.startsWith("turn_"));
    const currentTurn = statusToTurn(game.status);

    return NextResponse.json({
      success: true,
      game: {
        id: game.id,
        status: game.status,
        bothJoined,
        isReady,
        amHost,
        currentTurn,
        player1Id: game.player1Id,
        player2Id: game.player2Id,
        wagerAmount: game.wagerAmount,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { gameId, turn } = await req.json() as { gameId: number; turn?: string };

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    if (turn && turn !== "player1" && turn !== "player2") {
      return NextResponse.json({ success: false, error: "Invalid turn value" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(hexDuelGames)
      .where(
        and(
          eq(hexDuelGames.id, gameId),
          sql`(${hexDuelGames.player1Id} = ${userId} OR ${hexDuelGames.player2Id} = ${userId})`,
        ),
      )
      .limit(1);

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Accept turn updates from any player in the game (lightweight fallback — no strict enforcement)
    let newStatus = turn ? `turn_${turn}` : game.status;

    // If game is "in_progress" and no turn set yet, default to player1's turn
    if (game.status === "in_progress" && !turn) {
      newStatus = "turn_player1";
    }

    await db
      .update(hexDuelGames)
      .set({ status: newStatus })
      .where(eq(hexDuelGames.id, gameId));

    return NextResponse.json({
      success: true,
      game: { id: gameId, status: newStatus, currentTurn: statusToTurn(newStatus) },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}
