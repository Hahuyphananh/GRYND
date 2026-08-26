// app/lib/aiLogic.js
import { sql } from "../../db/sql";

export async function performAiAction(gameId) {
  const { rows: games } = await sql`
    SELECT * FROM poker_games WHERE id = ${gameId} AND status = 'active'
  `;
  const game = games[0];
  if (!game) return;

  const { rows: positions } = await sql`
    SELECT * FROM poker_player_positions WHERE game_id = ${gameId} ORDER BY position
  `;
  const aiPosition = positions.find((p) => p.player_id === null);
  const currentPosition = positions.find(
    (p) => p.position === game.current_player_position,
  );

  if (!aiPosition || aiPosition.position !== game.current_player_position)
    return;

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

// Deal community cards (5 cards drawn from the remaining deck)
export function dealCommunityCards(
  currentCards = [],
  playerHand = [],
  aiHand = [],
  deck = [],
) {
  const needed = 5 - currentCards.length;
  // Filter out cards already in player/AI hands to prevent duplicates
  const usedValues = new Set([
    ...playerHand.map((c) => `${c.value}-${c.suit}`),
    ...aiHand.map((c) => `${c.value}-${c.suit}`),
    ...currentCards.map((c) => `${c.value}-${c.suit}`),
  ]);
  const cleanDeck = deck.filter((c) => !usedValues.has(`${c.value}-${c.suit}`));
  const newCards = cleanDeck.slice(0, needed);
  const remainingDeck = cleanDeck.slice(needed);
  return {
    newCommunity: [...currentCards, ...newCards],
    updatedDeck: remainingDeck,
  };
}

/// app/lib/aiLogic.js

export function compareHands(playerHand, dealerHand) {
  const valueRank = {
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 7,
    8: 8,
    9: 9,
    10: 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  };

  function getHandRank(hand) {
    const values = hand.map((c) => valueRank[c.value]).sort((a, b) => a - b);
    const suits = hand.map((c) => c.suit);

    const isFlush = suits.every((s) => s === suits[0]);
    const isStraight =
      values.every((v, i) => i === 0 || v === values[i - 1] + 1) ||
      JSON.stringify(values) === JSON.stringify([2, 3, 4, 5, 14]); // A-2-3-4-5

    const counts = {};
    values.forEach((v) => (counts[v] = (counts[v] || 0) + 1));

    // Sort values by frequency first (e.g. pair/trips first), then by value descending
    const sortedValues = Object.keys(counts)
      .map(Number)
      .sort((a, b) => {
        if (counts[b] === counts[a]) return b - a; // same frequency → higher card first
        return counts[b] - counts[a]; // higher count first
      });

    const countValues = Object.values(counts).sort((a, b) => b - a);

    if (isFlush && isStraight && Math.max(...values) === 14)
      return { rank: 10, tiebreaker: sortedValues }; // Royal Flush
    if (isFlush && isStraight) return { rank: 9, tiebreaker: sortedValues }; // Straight Flush
    if (countValues[0] === 4) return { rank: 8, tiebreaker: sortedValues }; // Four of a Kind
    if (countValues[0] === 3 && countValues[1] === 2)
      return { rank: 7, tiebreaker: sortedValues }; // Full House
    if (isFlush) return { rank: 6, tiebreaker: values.slice().reverse() }; // Flush
    if (isStraight) return { rank: 5, tiebreaker: values.slice().reverse() }; // Straight
    if (countValues[0] === 3) return { rank: 4, tiebreaker: sortedValues }; // Three of a Kind
    if (countValues[0] === 2 && countValues[1] === 2)
      return { rank: 3, tiebreaker: sortedValues }; // Two Pair
    if (countValues[0] === 2) return { rank: 2, tiebreaker: sortedValues }; // One Pair
    return { rank: 1, tiebreaker: values.slice().reverse() }; // High Card
  }

  const player = getHandRank(playerHand);
  const dealer = getHandRank(dealerHand);

  if (player.rank > dealer.rank) return "player";
  if (dealer.rank > player.rank) return "dealer";

  // Same rank → compare tiebreakers properly
  for (
    let i = 0;
    i < Math.max(player.tiebreaker.length, dealer.tiebreaker.length);
    i++
  ) {
    const pv = player.tiebreaker[i] || 0;
    const dv = dealer.tiebreaker[i] || 0;
    if (pv > dv) return "player";
    if (pv < dv) return "dealer";
  }

  return "tie";
}
