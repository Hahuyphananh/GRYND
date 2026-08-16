export type UnoCard = {
  color: string; // "red", "green", "blue", "yellow", or "black"
  value: string; // "0"–"9", "Skip", "Reverse", "Draw Two", "Wild", "Wild Draw Four"
};

export type UnoGameState = {
  deck: UnoCard[];
  discardPile: UnoCard[];
  playerHand: UnoCard[];
  aiHand: UnoCard[];
  turn: "player" | "ai";
  currentColor: string; // THE RULE COLOR
};

/**
 * Checks if a card is playable based on the top card of the discard pile.
 */
export function isValidPlay(
  card: UnoCard,
  topCard: UnoCard,
  currentColor: string,
  hand?: UnoCard[],
): boolean {
  const normalizedValue = card.value.toLowerCase();
  const normalizedTopValue = topCard.value.toLowerCase();
  const topIsWild =
    normalizedTopValue === "wild" ||
    normalizedTopValue === "wild draw four" ||
    normalizedTopValue === "+4";

  // Wild is always playable
  if (normalizedValue === "wild") return true;

  // Wild Draw Four / +4 rule: only playable if no card in hand matches currentColor.
  // Exclude wild cards from the color-match check since wilds have no meaningful color.
  if (normalizedValue === "wild draw four" || normalizedValue === "+4") {
    if (!hand) return true; // safety fallback
    const hasMatch = hand.some(
      (c) =>
        c.color === currentColor &&
        c.value.toLowerCase() !== "wild" &&
        c.value.toLowerCase() !== "wild draw four" &&
        c.value.toLowerCase() !== "+4"
    );
    return !hasMatch;
  }

  // When the top card is a wild, only color-matching cards are playable.
  // Wild cards have no number/value, so value-matching is meaningless here.
  if (topIsWild) {
    return card.color === currentColor;
  }

  // Regular play: match by color OR by value
  return card.color === currentColor || normalizedValue === normalizedTopValue;
}

/**
 * Draws one card from the deck into the given hand.
 */
export function drawCard(
  deck: UnoCard[],
  hand: UnoCard[],
): {
  deck: UnoCard[];
  hand: UnoCard[];
  drawn: UnoCard | null;
} {
  if (deck.length === 0) return { deck, hand, drawn: null };

  const drawn = deck.pop()!;
  hand.push(drawn);
  return { deck, hand, drawn };
}

/**
 * Plays a card from the hand to the discard pile.
 */
export function playCard(
  card: UnoCard,
  hand: UnoCard[],
  discardPile: UnoCard[],
): {
  hand: UnoCard[];
  discardPile: UnoCard[];
} {
  const index = hand.findIndex(
    (c) => c.color === card.color && c.value === card.value,
  );
  if (index !== -1) {
    hand.splice(index, 1);
    discardPile.push(card);
  }
  return { hand, discardPile };
}

/**
 * Chooses a valid card to play for the AI.
 */
export function getPlayableCard(
  hand: UnoCard[],
  topCard: UnoCard,
  currentColor: string,
): UnoCard | null {
  for (const card of hand) {
    if (isValidPlay(card, topCard, currentColor, hand)) {
      return card;
    }
  }

  return null;
}

/**
 * Checks if a card is a draw effect card.
 */
export function getDrawCount(card: UnoCard): number {
  const normalizedValue = card.value.toLowerCase();
  if (normalizedValue === "draw two" || normalizedValue === "+2") return 2;
  if (normalizedValue === "wild draw four" || normalizedValue === "+4")
    return 4;
  return 0;
}

/**
 * Returns the next player's turn, accounting for skip/reverse.
 */
export function getNextTurn(
  current: "player" | "ai",
  cardPlayed: UnoCard,
): "player" | "ai" {
  const normalizedValue = cardPlayed.value.toLowerCase();
  if (normalizedValue === "skip" || normalizedValue === "reverse") {
    // Skip or Reverse: opponent loses their turn, current player plays again
    return current;
  }
  return current === "player" ? "ai" : "player";
}

export function applyUnoCard(game, card, currentPlayer, chosenColor = null) {
  let { playerHand, aiHand, deck, discardPile = [], turn, currentColor } = game;

  const newDiscardPile = [...discardPile];
  let newPlayerHand = [...playerHand];
  let newAiHand = [...aiHand];
  let nextTurn = turn;

  const switchTurn = () =>
    (nextTurn = currentPlayer === "player" ? "ai" : "player");
  const skipTurn = () => {
    switchTurn();
    switchTurn();
  };

  let playedCard = { ...card };

  //  Wilds must have a chosen color
  const normalizedValue = card.value.toLowerCase();

  if (
    normalizedValue === "wild" ||
    normalizedValue === "wild draw four" ||
    normalizedValue === "+4"
  ) {
    if (!chosenColor) {
      throw new Error("Wild cards must have a chosen color!");
    }
    currentColor = chosenColor.toLowerCase();
    // Keep discard pile visually aligned with the selected color.
    playedCard = { ...playedCard, color: currentColor };
  } else {
    currentColor = card.color.toLowerCase();
  }

  newDiscardPile.push(playedCard);

  switch (normalizedValue) {
    case "skip":
      nextTurn = currentPlayer; // opponent loses turn
      break;
    case "reverse":
      nextTurn = currentPlayer; // 2-player: Reverse = Skip
      break;
    case "draw two":
    case "+2":
      if (currentPlayer === "player") newAiHand.push(...deck.splice(0, 2));
      else newPlayerHand.push(...deck.splice(0, 2));
      skipTurn();
      break;
    case "wild":
      switchTurn();
      break;
    case "wild draw four":
    case "+4":
      if (currentPlayer === "player") newAiHand.push(...deck.splice(0, 4));
      else newPlayerHand.push(...deck.splice(0, 4));
      skipTurn();
      break;
    default:
      switchTurn();
      break;
  }

  return {
    ...game,
    playerHand: newPlayerHand,
    aiHand: newAiHand,
    deck,
    discardPile: newDiscardPile,
    turn: nextTurn,
    currentColor,
  };
}
