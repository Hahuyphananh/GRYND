import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { getUnoGameById, updateUnoGameState } from "../../../lib/unoGameUtils";
import { applyUnoCard, isValidPlay } from "../../../lib/unoLogic";

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
    return { discardPile, topCard: discardPile[discardPile.length - 1] };
  }

  const topCard = safeParse(game.topCard, null);
  return { discardPile: topCard ? [topCard] : [], topCard };
}

function isAllowedChosenColor(color) {
  return ["red", "yellow", "green", "blue"].includes(
    String(color || "").toLowerCase(),
  );
}

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { gameId, card, chosenColor } = await req.json();

    const game = await getUnoGameById(gameId);
    if (!game)
      return NextResponse.json(
        { success: false, error: "Game not found" },
        { status: 404 },
      );

    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const isMultiplayer = Boolean(game.player2Id);

    if (isMultiplayer) {
      if (game.status !== "active") {
        return NextResponse.json(
          { success: false, error: "Game is not active" },
          { status: 400 },
        );
      }

      const role =
        game.userId === user.id
          ? "player1"
          : game.player2Id === user.id
            ? "player2"
            : null;
      if (!role) {
        return NextResponse.json(
          { success: false, error: "Forbidden" },
          { status: 403 },
        );
      }

      if (game.turn !== role) {
        return NextResponse.json(
          { success: false, error: "Not your turn" },
          { status: 400 },
        );
      }

      const deck = safeParse(game.deck, []);
      const { discardPile, topCard } = getTopCard(game);
      const currentColor = game.currentColor || topCard?.color;

      const player1Hand = safeParse(game.player1Hand, []);
      const player2Hand = safeParse(game.player2Hand, []);
      const myHand = role === "player1" ? player1Hand : player2Hand;
      const opponentHand = role === "player1" ? player2Hand : player1Hand;

      const cardIndex = myHand.findIndex(
        (c) => c.color === card.color && c.value === card.value,
      );
      if (cardIndex === -1) {
        return NextResponse.json(
          { success: false, error: "Invalid card" },
          { status: 400 },
        );
      }

      if (!topCard) {
        return NextResponse.json(
          { success: false, error: "Invalid game state" },
          { status: 400 },
        );
      }

      if (!isValidPlay(card, topCard, currentColor, myHand)) {
        return NextResponse.json(
          { success: false, error: "Card not playable" },
          { status: 400 },
        );
      }

      if (
        (card.value === "Wild" || card.value === "Wild Draw Four") &&
        !chosenColor
      ) {
        return NextResponse.json({
          success: true,
          needsColorChoice: true,
          card,
        });
      }
      if (
        (card.value === "Wild" || card.value === "Wild Draw Four") &&
        !isAllowedChosenColor(chosenColor)
      ) {
        return NextResponse.json(
          { success: false, error: "Invalid color choice" },
          { status: 400 },
        );
      }

      const workingMyHand = [...myHand];
      workingMyHand.splice(cardIndex, 1);

      const virtualState = {
        playerHand: workingMyHand,
        aiHand: [...opponentHand],
        deck,
        discardPile,
        currentColor,
        turn: "player",
      };

      const updatedVirtual = applyUnoCard(
        virtualState,
        { ...card },
        "player",
        chosenColor,
      );
      const updatedPlayer1Hand =
        role === "player1" ? updatedVirtual.playerHand : updatedVirtual.aiHand;
      const updatedPlayer2Hand =
        role === "player1" ? updatedVirtual.aiHand : updatedVirtual.playerHand;
      const updatedTurn =
        updatedVirtual.turn === "player"
          ? role
          : role === "player1"
            ? "player2"
            : "player1";
      const top =
        updatedVirtual.discardPile[updatedVirtual.discardPile.length - 1];

      await db
        .update(unoGames)
        .set({
          player1Hand: updatedPlayer1Hand,
          player2Hand: updatedPlayer2Hand,
          deck: updatedVirtual.deck,
          discardPile: updatedVirtual.discardPile,
          topCard: top,
          currentColor: updatedVirtual.currentColor,
          turn: updatedTurn,
        })
        .where(eq(unoGames.id, gameId));

      return NextResponse.json({
        success: true,
        data: {
          mode: "online",
          role,
          turn: updatedTurn,
          playerHand:
            role === "player1" ? updatedPlayer1Hand : updatedPlayer2Hand,
          opponentHandCount:
            role === "player1"
              ? updatedPlayer2Hand.length
              : updatedPlayer1Hand.length,
          topCard: top,
          currentColor: updatedVirtual.currentColor,
          isPlayerTurn: updatedTurn === role,
          message:
            updatedTurn === role
              ? "Carte jouée, tu rejoues"
              : "Carte jouée, tour adverse",
        },
      });
    }

    const playerHand = safeParse(game.playerHand, []);
    const aiHand = safeParse(game.aiHand, []);
    const deck = safeParse(game.deck, []);
    const { discardPile, topCard } = getTopCard(game);
    const currentColor = game.currentColor || topCard?.color;

    const cardIndex = playerHand.findIndex(
      (c) => c.color === card.color && c.value === card.value,
    );
    if (cardIndex === -1)
      return NextResponse.json(
        { success: false, error: "Invalid card" },
        { status: 400 },
      );

    const isPlayable =
      card.color === currentColor ||
      card.value === topCard.value ||
      card.color === "black";
    if (!isPlayable)
      return NextResponse.json(
        { success: false, error: "Card not playable" },
        { status: 400 },
      );

    if (
      (card.value === "Wild" || card.value === "Wild Draw Four") &&
      !chosenColor
    ) {
      return NextResponse.json({ success: true, needsColorChoice: true, card });
    }
    if (
      (card.value === "Wild" || card.value === "Wild Draw Four") &&
      !isAllowedChosenColor(chosenColor)
    ) {
      return NextResponse.json(
        { success: false, error: "Invalid color choice" },
        { status: 400 },
      );
    }

    const playedCard = { ...card, color: chosenColor || card.color };
    playerHand.splice(cardIndex, 1);

    const updatedGame = applyUnoCard(
      { ...game, playerHand, aiHand, deck, discardPile, currentColor },
      playedCard,
      "player",
      chosenColor,
    );

    await updateUnoGameState(gameId, updatedGame);

    return NextResponse.json({
      success: true,
      data: {
        mode: "ai",
        playerHand: updatedGame.playerHand,
        aiHandCount: updatedGame.aiHand.length,
        topCard: updatedGame.discardPile[updatedGame.discardPile.length - 1],
        currentColor: updatedGame.currentColor,
        isPlayerTurn: updatedGame.turn === "player",
        message:
          updatedGame.turn === "player"
            ? "Carte jouée, ton tour"
            : "Carte jouée, tour IA",
      },
    });
  } catch (err) {
    console.error("Error in play-card:", err);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
