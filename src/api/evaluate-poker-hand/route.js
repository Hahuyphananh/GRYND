async function handler({ player_hand, ai_hand, community_cards, game_id }) {
  if (!player_hand || !ai_hand || !community_cards || !game_id) {
    return { error: "Missing required parameters" };
  }

  const allCards = [...player_hand, ...community_cards];
  const allAiCards = [...ai_hand, ...community_cards];

  const handRanks = {
    "Royal Flush": 10,
    "Straight Flush": 9,
    "Four of a Kind": 8,
    "Full House": 7,
    Flush: 6,
    Straight: 5,
    "Three of a Kind": 4,
    "Two Pair": 3,
    Pair: 2,
    "High Card": 1,
  };

  function evaluateHand(cards) {
    const values = cards.map((card) => card.value);
    const suits = cards.map((card) => card.suit);

    const valueCount = {};
    values.forEach((value) => {
      valueCount[value] = (valueCount[value] || 0) + 1;
    });

    const isFlush = suits.filter((suit) => suit === suits[0]).length === 5;

    const sortedValues = [...new Set(values)]
      .map((v) =>
        v === "A"
          ? 14
          : v === "K"
          ? 13
          : v === "Q"
          ? 12
          : v === "J"
          ? 11
          : parseInt(v)
      )
      .sort((a, b) => b - a);

    const isStraight =
      sortedValues.length >= 5 &&
      sortedValues
        .slice(0, 5)
        .every((val, i) => i === 0 || val === sortedValues[i - 1] - 1);

    if (isFlush && isStraight && sortedValues[0] === 14) {
      return { rank: "Royal Flush", highCard: 14 };
    }

    if (isFlush && isStraight) {
      return { rank: "Straight Flush", highCard: sortedValues[0] };
    }

    const fourOfAKind = Object.entries(valueCount).find(
      ([_, count]) => count === 4
    );
    if (fourOfAKind) {
      return { rank: "Four of a Kind", highCard: parseInt(fourOfAKind[0]) };
    }

    const threeOfAKind = Object.entries(valueCount).find(
      ([_, count]) => count === 3
    );
    const pair = Object.entries(valueCount).find(([_, count]) => count === 2);
    if (threeOfAKind && pair) {
      return { rank: "Full House", highCard: parseInt(threeOfAKind[0]) };
    }

    if (isFlush) {
      return { rank: "Flush", highCard: sortedValues[0] };
    }

    if (isStraight) {
      return { rank: "Straight", highCard: sortedValues[0] };
    }

    if (threeOfAKind) {
      return { rank: "Three of a Kind", highCard: parseInt(threeOfAKind[0]) };
    }

    const pairs = Object.entries(valueCount).filter(
      ([_, count]) => count === 2
    );
    if (pairs.length === 2) {
      return {
        rank: "Two Pair",
        highCard: Math.max(...pairs.map(([value]) => parseInt(value))),
      };
    }

    if (pairs.length === 1) {
      return { rank: "Pair", highCard: parseInt(pairs[0][0]) };
    }

    return { rank: "High Card", highCard: sortedValues[0] };
  }

  const playerHandResult = evaluateHand(allCards);
  const aiHandResult = evaluateHand(allAiCards);

  let winner;
  if (handRanks[playerHandResult.rank] > handRanks[aiHandResult.rank]) {
    winner = "player";
  } else if (handRanks[playerHandResult.rank] < handRanks[aiHandResult.rank]) {
    winner = "ai";
  } else {
    winner =
      playerHandResult.highCard > aiHandResult.highCard ? "player" : "ai";
  }

  await sql`
    UPDATE poker_games 
    SET status = 'completed'
    WHERE id = ${game_id}
  `;

  return {
    winner,
    player_hand: playerHandResult,
    ai_hand: aiHandResult,
  };
}
export async function POST(request) {
  return handler(await request.json());
}