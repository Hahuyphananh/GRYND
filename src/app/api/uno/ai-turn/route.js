import { db } from "../../../../db/client";
import { auth } from "@clerk/nextjs/server";
import {
  getUnoGameById,
  drawUnoCard,
  updateUnoGameState,
} from "../../../lib/unoGameUtils";
import { applyUnoCard, isValidPlay } from "../../../lib/unoLogic";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { parseAndValidateJson } from "../../../../lib/security/validation";

function safeParse(data) {
  if (!data) return [];
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
  return data;
}

function normalize(value) {
  return (value || "").toLowerCase();
}

function isActionCard(card) {
  const value = normalize(card.value);
  return [
    "skip",
    "reverse",
    "draw two",
    "+2",
    "wild",
    "wild draw four",
    "+4",
  ].includes(value);
}

function aiChooseColor(hand) {
  const colorCount = { red: 0, yellow: 0, green: 0, blue: 0 };

  for (const card of hand) {
    if (colorCount[card.color] !== undefined) {
      colorCount[card.color] += isActionCard(card) ? 1 : 2;
    }
  }

  return Object.keys(colorCount).reduce(
    (best, current) =>
      colorCount[current] > colorCount[best] ? current : best,
    "red",
  );
}

function getPlayableCards(hand, topCard, currentColor) {
  if (!topCard) return [];
  return hand.filter((card) => isValidPlay(card, topCard, currentColor, hand));
}

function scoreCard(card, gameState) {
  const { aiHand, playerHand, currentColor } = gameState;
  const value = normalize(card.value);

  const aiColorCount = aiHand.filter((c) => c.color === card.color).length;
  const playerLikelyColorPressure = playerHand.filter(
    (c) => c.color === currentColor,
  ).length;
  const playerCardCount = playerHand.length;

  let score = 0;

  if (card.color === currentColor) score += 8;

  if (value === "skip" || value === "reverse") {
    score += playerCardCount <= 2 ? 80 : 36;
  }

  if (value === "draw two" || value === "+2") {
    score += playerCardCount <= 3 ? 90 : 44;
  }

  if (value === "wild draw four" || value === "+4") {
    score += playerCardCount <= 4 ? 110 : 50;
    score -= aiHand.length > 5 ? 8 : 0;
  }

  if (value === "wild") {
    score += playerCardCount <= 3 ? 35 : 20;
    score -= aiHand.length > 4 ? 5 : 0;
  }

  if (/^\d+$/.test(card.value)) {
    score += 12 - Number(card.value);
  }

  if (card.color !== "black") {
    if (aiColorCount >= 3) score += 16;
    if (aiColorCount === 1) score -= 4;
  }

  if (playerLikelyColorPressure >= 3 && card.color !== currentColor) {
    score -= 6;
  }

  return score;
}

function chooseBestPlay(aiHand, playerHand, topCard, currentColor) {
  const playable = getPlayableCards(aiHand, topCard, currentColor);
  if (playable.length === 0) return null;

  return playable
    .map((card) => ({
      card,
      score: scoreCard(card, { aiHand, playerHand, currentColor }),
    }))
    .sort((a, b) => b.score - a.score)[0].card;
}

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId)
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401 },
      );

    const parsed = await parseAndValidateJson(req, {
      gameId: { type: "number", required: true, integer: true, min: 1 },
    });
    if (!parsed.ok) return parsed.response;

    const { gameId } = parsed.data;

    const game = await getUnoGameById(gameId);
    if (!game)
      return new Response(
        JSON.stringify({ success: false, error: "Game not found" }),
        { status: 404 },
      );

    const [currentUser] = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);
    if (!currentUser)
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404 },
      );

    if (String(game.userId) !== String(currentUser.id)) {
      return new Response(
        JSON.stringify({ success: false, error: "Forbidden" }),
        { status: 403 },
      );
    }

    let deck = safeParse(game.deck);
    let aiHand = safeParse(game.aiHand);
    let playerHand = safeParse(game.playerHand);
    let discardPile = safeParse(game.discardPile);
    let topCard = discardPile[discardPile.length - 1] || null;
    let currentColor = (
      game.currentColor ||
      topCard?.color ||
      "red"
    ).toLowerCase();
    let message = "";
    let isPlayerTurn = false;

    if (!topCard) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid game state: missing top card",
        }),
        { status: 400 },
      );
    }

    let loopCounter = 0;

    while (!isPlayerTurn && loopCounter < 20) {
      loopCounter++;

      const chosenCard = chooseBestPlay(
        aiHand,
        playerHand,
        topCard,
        currentColor,
      );

      if (chosenCard) {
        const playableIndex = aiHand.findIndex(
          (card) =>
            card.color === chosenCard.color && card.value === chosenCard.value,
        );

        let playedCard = aiHand.splice(playableIndex, 1)[0];
        const normalizedValue = normalize(playedCard.value);
        const chosenColor =
          playedCard.color === "black" || normalize(playedCard.color) === "wild"
            ? aiChooseColor(aiHand)
            : playedCard.color;

        if (
          playedCard.color === "black" ||
          normalize(playedCard.color) === "wild"
        ) {
          message = `IA joue ${playedCard.value} et choisit ${chosenColor}`;
        } else {
          message = `IA joue ${playedCard.color} ${playedCard.value}`;
        }

        const updatedGame = applyUnoCard(
          { deck, playerHand, aiHand, discardPile, currentColor, turn: "ai" },
          playedCard,
          "ai",
          chosenColor,
        );

        deck = updatedGame.deck;
        aiHand = updatedGame.aiHand;
        playerHand = updatedGame.playerHand;
        discardPile = updatedGame.discardPile;
        currentColor = updatedGame.currentColor;
        topCard = discardPile[discardPile.length - 1];
        isPlayerTurn = updatedGame.turn === "player";

        if (updatedGame.turn === "ai") {
          if (normalizedValue === "skip" || normalizedValue === "reverse") {
            message = `${message}. Ton tour est sauté !`;
          }
          continue;
        }
      } else {
        const { card, deck: updatedDeck } = drawUnoCard(deck);

        if (!card) {
          message = "Pioche vide, passage de tour";
          isPlayerTurn = true;
          break;
        }

        deck = updatedDeck;
        aiHand.push(card);

        if (isValidPlay(card, topCard, currentColor, aiHand)) {
          const chosenColor =
            card.color === "black" || normalize(card.color) === "wild"
              ? aiChooseColor(aiHand)
              : card.color;

          message = `IA pioche et joue ${card.color} ${card.value}`;

          const updatedGame = applyUnoCard(
            { deck, playerHand, aiHand, discardPile, currentColor, turn: "ai" },
            card,
            "ai",
            chosenColor,
          );

          deck = updatedGame.deck;
          aiHand = updatedGame.aiHand;
          playerHand = updatedGame.playerHand;
          discardPile = updatedGame.discardPile;
          currentColor = updatedGame.currentColor;
          topCard = discardPile[discardPile.length - 1];
          isPlayerTurn = updatedGame.turn === "player";
          if (updatedGame.turn === "ai") continue;
        } else {
          message = "IA pioche une carte";
          isPlayerTurn = true;
        }
      }
    }

    const updatedGameState = {
      deck,
      playerHand,
      aiHand,
      discardPile,
      topCard,
      currentColor,
      turn: isPlayerTurn ? "player" : "ai",
      isPlayerTurn,
    };

    await updateUnoGameState(gameId, updatedGameState);

    const user = await db.query.users.findFirst({
      where: eq(users.id, game.userId),
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          topCard,
          playerHand,
          aiHandCount: aiHand.length,
          newBalance: parseFloat(user.balance),
          message,
          isPlayerTurn,
          currentColor,
        },
      }),
      { status: 200 },
    );
  } catch (err) {
    console.error("AI Turn Error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Internal Server Error" }),
      { status: 500 },
    );
  }
}
