async function handler({ userId }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { error: "User not authenticated" };
  }

  const userTokens = await sql`
    SELECT balance FROM user_tokens WHERE user_id = ${session.user.id}
  `;

  if (!userTokens.length || userTokens[0].balance < 100) {
    return { error: "Insufficient balance for minimum buy-in" };
  }

  const deck = generateShuffledDeck();
  const playerHand = [deck.pop(), deck.pop()];
  const aiHand = [deck.pop(), deck.pop()];

  const gameResult = await sql`
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
      ${session.user.id},
      'active',
      ${3.0},
      ${JSON.stringify(playerHand)},
      ${JSON.stringify(aiHand)},
      ${JSON.stringify(deck)},
      ${0},
      ${1.0},
      ${2.0},
      ${1},
      ${2.0}
    ) RETURNING id
  `;

  const gameId = gameResult[0].id;

  await sql.transaction([
    sql`
      INSERT INTO poker_player_positions (
        game_id, 
        player_id, 
        position, 
        stack, 
        current_bet
      ) VALUES (
        ${gameId}, 
        ${session.user.id}, 
        ${0}, 
        ${100.0}, 
        ${1.0}
      )
    `,
    sql`
      INSERT INTO poker_player_positions (
        game_id, 
        player_id, 
        position, 
        stack, 
        current_bet
      ) VALUES (
        ${gameId}, 
        ${null}, 
        ${1}, 
        ${100.0}, 
        ${2.0}
      )
    `,
    sql`
      UPDATE user_tokens 
      SET balance = balance - ${1.0}
      WHERE user_id = ${session.user.id}
    `,
  ]);

  return {
    gameId,
    playerHand,
    currentPosition: 1,
    pot: 3.0,
    minBet: 2.0,
    playerStack: 99.0,
    aiStack: 98.0,
  };
}

function generateShuffledDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A",
  ];
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
export async function POST(request) {
  return handler(await request.json());
}