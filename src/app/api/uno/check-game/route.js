import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

function safeParse(value, fallback = []) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function getTopCard(game) {
  const discardPile = safeParse(game.discardPile, []);
  if (discardPile.length > 0) {
    return discardPile[discardPile.length - 1];
  }

  return safeParse(game.topCard, null);
}

export async function POST(request) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;

  const { userId } = await auth();
  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );
  }

  const { gameId } = await request.json();
  if (!gameId) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing gameId" }),
      { status: 400 },
    );
  }

  try {
    const game = await db.query.unoGames.findFirst({
      where: eq(unoGames.id, gameId),
    });
    if (!game) {
      return new Response(
        JSON.stringify({ success: false, error: "Game not found" }),
        { status: 404 },
      );
    }

    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!user) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404 },
      );
    }

    const isMultiplayer = Boolean(game.player2Id);
    const isPlayer1 = game.userId === user.id;
    const isPlayer2 = game.player2Id === user.id;

    if (isMultiplayer && !isPlayer1 && !isPlayer2) {
      return new Response(
        JSON.stringify({ success: false, error: "Forbidden" }),
        { status: 403 },
      );
    }

    if (game.status === "waiting") {
      if (!isPlayer1) {
        return new Response(
          JSON.stringify({ success: false, error: "Forbidden" }),
          { status: 403 },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          status: "waiting",
        }),
        { status: 200 },
      );
    }

    if (!isMultiplayer) {
      const topCard = getTopCard(game);
      return new Response(
        JSON.stringify({
          success: true,
          status: game.status,
          data: {
            id: game.id,
            mode: "ai",
            topCard,
            currentColor: game.currentColor,
            turn: game.turn,
            playerHand: safeParse(game.playerHand, []),
            aiHandCount: safeParse(game.aiHand, []).length,
          },
        }),
        { status: 200 },
      );
    }

    let resolvedTurn = game.turn;
    if (
      game.status === "active" &&
      resolvedTurn !== "player1" &&
      resolvedTurn !== "player2"
    ) {
      resolvedTurn = Math.random() > 0.5 ? "player1" : "player2";
      await db
        .update(unoGames)
        .set({ turn: resolvedTurn })
        .where(eq(unoGames.id, game.id));
    }

    //  FORCE WINNER DETECTION (CRITICAL FIX)
    let updatedGame = game;

    if (game.status !== "finished") {
      const player1Hand = safeParse(game.player1Hand, []);
      const player2Hand = safeParse(game.player2Hand, []);

      if (player1Hand.length === 0 || player2Hand.length === 0) {
        const winner = player1Hand.length === 0 ? "player1" : "player2";

        await db
          .update(unoGames)
          .set({
            status: "finished",
            winner,
          })
          .where(eq(unoGames.id, game.id));

        // update local object so response is correct immediately
        updatedGame = {
          ...game,
          status: "finished",
          winner,
        };
      }
    }

    const role = isPlayer1 ? "player1" : "player2";
    const player1Hand = safeParse(updatedGame.player1Hand, []);
    const player2Hand = safeParse(updatedGame.player2Hand, []);

    const myHand = role === "player1" ? player1Hand : player2Hand;
    const opponentHandCount =
      role === "player1" ? player2Hand.length : player1Hand.length;
    const topCard = getTopCard(game);

    return new Response(
      JSON.stringify({
        success: true,
        status: updatedGame.status,
        data: {
          id: game.id,
          mode: "online",
          role,
          topCard,
          currentColor: game.currentColor,
          turn: resolvedTurn,
          playerHand: myHand,
          opponentHandCount,
          winner: updatedGame.winner,
          result: game.result,
        },
      }),
      { status: 200 },
    );
  } catch (err) {
    console.error("UNO check-game error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500 },
    );
  }
}
