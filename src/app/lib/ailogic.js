// app/lib/aiLogic.js
import { sql } from "@vercel/postgres";

export async function performAiAction(gameId) {
  const { rows: games } = await sql`
    SELECT * FROM poker_games WHERE id = ${gameId} AND status = 'active'
  `;
  const game = games[0];
  if (!game) return;

  const { rows: positions } = await sql`
    SELECT * FROM poker_player_positions WHERE game_id = ${gameId} ORDER BY position
  `;
  const aiPosition = positions.find(p => p.player_id === null);
  const currentPosition = positions.find(p => p.position === game.current_player_position);

  if (!aiPosition || aiPosition.position !== game.current_player_position) return;

  const callAmount = game.min_bet - aiPosition.current_bet;

  if (callAmount <= aiPosition.stack) {
    await sql`
      UPDATE poker_player_positions
      SET current_bet = ${game.min_bet}, stack = stack - ${callAmount}
      WHERE game_id = ${gameId} AND player_id IS NULL
    `;

    await sql`
      UPDATE poker_games
      SET pot = pot + ${callAmount}, current_player_position = 1
      WHERE id = ${gameId}
    `;
  } else {
    await sql`
      UPDATE poker_player_positions
      SET has_folded = true
      WHERE game_id = ${gameId} AND player_id IS NULL
    `;

    await sql`
      UPDATE poker_games
      SET status = 'completed', result = 'win'
      WHERE id = ${gameId}
    `;
  }
}

// Deal community cards
export function dealCommunityCards(currentCards = [], playerHand = [], aiHand = []) {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

  const deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({ value, suit });
    }
  }

  const dealtCards = [...currentCards, ...playerHand, ...aiHand];
  const remainingDeck = deck.filter(
    c => !dealtCards.some(dc => dc.value === c.value && dc.suit === c.suit)
  );

  for (let i = remainingDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remainingDeck[i], remainingDeck[j]] = [remainingDeck[j], remainingDeck[i]];
  }

  const needed = 5 - currentCards.length;
  return [...currentCards, ...remainingDeck.slice(0, needed)];
}

// Compare hands: returns "player", "dealer", or "tie"
export function compareHands(playerHand, dealerHand, communityCards) {
  const valueRank = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6,
    "7": 7, "8": 8, "9": 9, "10": 10,
    "J": 11, "Q": 12, "K": 13, "A": 14
  };

  const allPlayer = [...playerHand, ...communityCards].map(c => valueRank[c.value]);
  const allDealer = [...dealerHand, ...communityCards].map(c => valueRank[c.value]);

  const playerMax = Math.max(...allPlayer);
  const dealerMax = Math.max(...allDealer);

  if (playerMax > dealerMax) return "player";
  if (dealerMax > playerMax) return "dealer";
  return "tie";
}
