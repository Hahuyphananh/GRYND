import { auth } from "@clerk/nextjs/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq, and, ne, isNull } from "drizzle-orm";
import { normalizeStake } from "../../../../lib/games/stakes";

function generateDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const values = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "Skip",
    "Reverse",
    "Draw Two",
  ];
  const wilds = ["Wild", "Wild Draw Four"];
  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push({ color, value });
      if (value !== "0") deck.push({ color, value });
    }
  }

  for (let i = 0; i < 4; i++) {
    for (const wild of wilds) deck.push({ color: "black", value: wild });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

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

async function joinOpenGame({ user, openGame }) {
  const balance = parseFloat(user.balance);

  const deck = safeParse(openGame.deck, []);
  const player1Hand = safeParse(openGame.player1Hand, []);
  const player2Hand = deck.splice(0, 7);

  try {
    const firstTurn = Math.random() > 0.5 ? "player1" : "player2";

    const updated = await db.transaction(async (tx) => {
      const [game] = await tx
        .update(unoGames)
        .set({
          player2Id: user.id,
          player2Hand,
          deck,
          status: "active",
          turn: firstTurn,
        })
        .where(
          and(
            eq(unoGames.id, openGame.id),
            isNull(unoGames.player2Id),
            eq(unoGames.status, "waiting"),
          ),
        )
        .returning();

      if (!game) throw new Error("GAME_ALREADY_FILLED");
      return game;
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          id: updated.id,
          mode: "online",
          role: "player2",
          newBalance: balance.toFixed(2),
          playerHand: player2Hand,
          opponentHandCount: player1Hand.length,
          topCard: safeParse(updated.topCard, null),
          currentColor: updated.currentColor,
          turn: updated.turn,
          firstTurn,
          betAmount: openGame.betAmount,
        },
      }),
      { status: 200 },
    );
  } catch (error) {
    if (error?.message === "GAME_ALREADY_FILLED") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Game is no longer available",
        }),
        { status: 409 },
      );
    }
    throw error;
  }
}

async function createWaitingGame({ user, betAmount }) {
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a waiting game is free to
  // open. The requested bet is normalized to 0, so the balance debit below is
  // a no-op and the pot is nothing.
  betAmount = normalizeStake(betAmount);

  const balance = parseFloat(user.balance);

  const deck = generateDeck();
  const player1Hand = deck.splice(0, 7);

  let topCard;
  do {
    topCard = deck.pop();
  } while (topCard.value === "Wild" || topCard.value === "Wild Draw Four");

  const discardPile = [topCard];
  const currentColor = topCard.color;
  const pot = (betAmount * 2).toFixed(2);

  const [inserted] = await db.transaction(async (tx) => {
    return await tx
      .insert(unoGames)
      .values({
        userId: user.id,
        player2Id: null,
        betAmount: betAmount.toFixed(2),
        pot,
        result: "pending",
        payout: "0.00",
        winner: "pending",
        playerHand: [],
        aiHand: [],
        player1Hand,
        player2Hand: [],
        deck,
        discardPile,
        topCard,
        currentColor,
        turn: "player1",
        status: "waiting",
      })
      .returning();
  });

  return new Response(
    JSON.stringify({
      success: true,
      waiting: true,        message: "Waiting for another player to join...",
      gameId: inserted.id,
      newBalance: balance.toFixed(2),
      role: "player1",
    }),
    { status: 200 },
  );
}

export async function POST(request) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;

  const { userId } = await auth();
  if (!userId)
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );

  const { betAmount: requestedBet, mode = "join_or_create", gameId } = await request.json();
  // STAKES ARE RETIRED — no online game is ever entered for a stake.
  const betAmount = normalizeStake(requestedBet);

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!user)
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404 },
      );

    const waitingGames = await db.query.unoGames.findMany({
      where: and(
        eq(unoGames.status, "waiting"),
        isNull(unoGames.player2Id),
        ne(unoGames.userId, user.id),
      ),
    });

    if (mode === "join-random") {
      if (waitingGames.length === 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "No available online games",
          }),
          { status: 404 },
        );
      }
      const randomGame =
        waitingGames[Math.floor(Math.random() * waitingGames.length)];
      return await joinOpenGame({ user, openGame: randomGame });
    }

    if (mode === "join-specific") {
      if (!gameId) {
        return new Response(
          JSON.stringify({ success: false, error: "Missing gameId" }),
          { status: 400 },
        );
      }

      const targetedGame = waitingGames.find((g) => g.id === Number(gameId));
      if (!targetedGame) {
        return new Response(
          JSON.stringify({ success: false, error: "Game is not available" }),
          { status: 404 },
        );
      }

      return await joinOpenGame({ user, openGame: targetedGame });
    }

    if (mode === "create") {
      return await createWaitingGame({ user, betAmount });
    }

    const matchedByBet = waitingGames.find(
      (game) => game.betAmount === betAmount.toFixed(2),
    );
    if (matchedByBet) {
      return await joinOpenGame({ user, openGame: matchedByBet });
    }

    return await createWaitingGame({ user, betAmount });
  } catch (err) {
    console.error("UNO online error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500 },
    );
  }
}
