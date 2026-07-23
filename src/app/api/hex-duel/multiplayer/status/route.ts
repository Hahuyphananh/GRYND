import { auth } from "@clerk/nextjs/server";
import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelGames, users } from "../../../../../db/schema";

/** Derive currentTurn from the status string */
function statusToTurn(status: string): "player1" | "player2" | null {
  if (status === "turn_player1") return "player1";
  if (status === "turn_player2") return "player2";
  return null;
}

export async function GET(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // `gameId` even when the throw happened during URL parsing.
  let gameId: number = NaN;
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    gameId = Number(searchParams.get("gameId"));

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    // Uses typed or(eq(...), eq(...)) instead of the raw
    // `sql\`(${hexDuelGames.player1Id} = ${userId} OR ...)\`` template,
    // which has parameter-binder fragility under
    // `drizzle-orm/neon-serverless` (root cause of past 500s).
    const [game] = await db
      .select({
        id: hexDuelGames.id,
        status: hexDuelGames.status,
        player1Id: hexDuelGames.player1Id,
        player2Id: hexDuelGames.player2Id,
        wagerAmount: hexDuelGames.wagerAmount,
        player1Name: users.name,
      })
      .from(hexDuelGames)
      .leftJoin(users, eq(users.clerkId, hexDuelGames.player1Id))
      .where(
        and(
          eq(hexDuelGames.id, gameId),
          or(
            eq(hexDuelGames.player1Id, userId),
            eq(hexDuelGames.player2Id, userId),
          ),
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

    // Fetch player2 name if both joined
    let player2Name: string | null = null;
    if (game.player2Id) {
      const [p2] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.clerkId, game.player2Id))
        .limit(1);
      player2Name = p2?.name || null;
    }

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
        player1Name: game.player1Name || null,
        player2Name,
      },
    });
  } catch (error: any) {
    // Log the underlying error server-side so Vercel function logs
    // (and Sentry if wired up) actually capture the cause.
    console.error(
      "[hex-duel/multiplayer/status] GET failed",
      {
        url: req.url,
        gameId,
        err: error?.message,
        stack: error?.stack,
      },
    );
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // `gameId` / `turn` even when the throw happened during JSON parsing.
  let gameId: number = NaN;
  let turn: string | null = null;
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      turn?: unknown;
    };
    gameId = Number(body.gameId);
    turn = typeof body.turn === "string" ? body.turn : null;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    if (turn && turn !== "player1" && turn !== "player2") {
      return NextResponse.json({ success: false, error: "Invalid turn value" }, { status: 400 });
    }

    // Uses typed or(eq(...), eq(...)) instead of the raw
    // `sql\`(${hexDuelGames.player1Id} = ${userId} OR ...)\`` template,
    // which has parameter-binder fragility under
    // `drizzle-orm/neon-serverless` (root cause of past 500s).
    const [game] = await db
      .select()
      .from(hexDuelGames)
      .where(
        and(
          eq(hexDuelGames.id, gameId),
          or(
            eq(hexDuelGames.player1Id, userId),
            eq(hexDuelGames.player2Id, userId),
          ),
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
    // Log the underlying error server-side so Vercel function logs
    // (and Sentry if wired up) actually capture the cause.
    console.error(
      "[hex-duel/multiplayer/status] POST failed",
      {
        gameId,
        turn,
        err: error?.message,
        stack: error?.stack,
      },
    );
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}
