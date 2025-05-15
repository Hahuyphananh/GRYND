import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * Generates and shuffles a deck of 52 playing cards.
 */
function generateShuffledDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];

  for (const suit of suits) {
    for (const value of values) {
      deck.push({ suit, value });
    }
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "User not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { rows: tokenRows } = await sql`
      SELECT balance FROM user_tokens WHERE user_id = ${userId}
    `;

    const balance = tokenRows[0]?.balance ?? 0;
    if (balance < 100) {
      return new Response(JSON.stringify({ error: "Insufficient balance for minimum buy-in" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Initialize game state
    const deck = generateShuffledDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const aiHand = [deck.pop(), deck.pop()];
    const pot = 3.0;
    const smallBlind = 1.0;
    const bigBlind = 2.0;

    // Insert poker game and positions atomically
    const result = await sql.begin(async (tx) => {
      const { rows: gameRows } = await tx`
        INSERT INTO poker_games (
          player_id,
          status,
          pot,
          player_hand,
          ai_hand,
          deck,
          dealer_position,
          small_blind,
          big_blind,
          current_player_position,
          min_bet
        ) VALUES (
          ${userId},
          'active',
          ${pot},
          ${JSON.stringify(playerHand)},
          ${JSON.stringify(aiHand)},
          ${JSON.stringify(deck)},
          ${0},
          ${smallBlind},
          ${bigBlind},
          ${1},
          ${bigBlind}
        )
        RETURNING id
      `;

      const gameId = gameRows[0].id;

      await tx`
        INSERT INTO poker_player_positions (
          game_id, player_id, position, stack, current_bet
        ) VALUES
        (${gameId}, ${userId}, 0, 100.0, ${smallBlind}),
        (${gameId}, NULL, 1, 100.0, ${bigBlind})
      `;

      await tx`
        UPDATE user_tokens
        SET balance = balance - ${smallBlind}
        WHERE user_id = ${userId}
      `;

      return gameId;
    });

    return new Response(JSON.stringify({
      gameId: result,
      playerHand,
      currentPosition: 1,
      pot,
      minBet: bigBlind,
      playerStack: 99.0,
      aiStack: 98.0,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("❌ Error starting poker game:", err);
    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
