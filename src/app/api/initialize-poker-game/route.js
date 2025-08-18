import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

function generateShuffledDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  const deck = [];

  for (const suit of suits) {
    for (const value of values) {
      deck.push({ suit, value });
    }
  }

  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "User not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" }});
  }

  try {
    const body = await request.json();
    const nPlayers = Math.max(3, Math.min(body.nPlayers || 3, 9)); // clamp 3-9

    // Check user balance
    const { rows: userRows } = await sql`SELECT balance FROM users WHERE clerk_id = ${userId}`;
    const balance = parseFloat(userRows[0]?.balance ?? 0);
    if (balance < 100) return new Response(JSON.stringify({ error: "Insufficient balance" }), { status: 400, headers: { "Content-Type": "application/json" }});

    const deck = generateShuffledDeck();
    const buyIn = 100;

    // Deal hands
    const players = [];
    for (let i = 0; i < nPlayers; i++) {
      const isUser = i === 0;
      const hand = [deck.pop(), deck.pop()];
      players.push({
        id: isUser ? userId : null, // AI = null
        seat: i,
        hand,
        stack: buyIn,
        currentBet: 0,
        isAI: !isUser,
      });
    }

    // Apply blinds
    const smallBlind = 1;
    const bigBlind = 2;
    players[0].currentBet = smallBlind;
    players[0].stack -= smallBlind;
    players[1].currentBet = bigBlind;
    players[1].stack -= bigBlind;
    const pot = smallBlind + bigBlind;

    // Insert game into poker_games
    const { rows: gameRows } = await sql`
      INSERT INTO poker_games (
        user_id,
        bet_amount,
        result,
        payout,
        status,
        pot,
        min_bet,
        player_hand,
        ai_hand,
        deck,
        current_player_position,
        dealer_position
      ) VALUES (
        ${userId},
        ${buyIn},
        'pending',
        0,
        'active',
        ${pot},
        ${bigBlind},
        ${JSON.stringify(players[0].hand)},
        ${JSON.stringify(players.slice(1).map(p => p.hand))},
        ${JSON.stringify(deck)},
        2,
        0
      )
      RETURNING id
    `;
    const gameId = gameRows[0].id;

    // Insert all players into positions table
    for (const p of players) {
      await sql`
        INSERT INTO poker_player_positions (
          game_id,
          player_id,
          position,
          stack,
          current_bet,
          is_ai,
          hand
        ) VALUES (
          ${gameId},
          ${p.id},
          ${p.seat},
          ${p.stack},
          ${p.currentBet},
          ${p.isAI},
          ${JSON.stringify(p.hand)}
        )
      `;
    }

    // Deduct SB from user balance
    await sql`UPDATE users SET balance = balance - ${smallBlind} WHERE clerk_id = ${userId}`;

    return new Response(JSON.stringify({
      gameId,
      nPlayers,
      players,
      pot,
      minBet: bigBlind,
      currentPosition: 2, // next after blinds
    }), { status: 200, headers: { "Content-Type": "application/json" }});

  } catch (err) {
    console.error("❌ Error starting poker game:", err);
    return new Response(JSON.stringify({ error: "Server error" }), { status: 500, headers: { "Content-Type": "application/json" }});
  }
}
