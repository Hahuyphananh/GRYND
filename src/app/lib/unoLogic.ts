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
};

/**
 * Checks if a card is playable based on the top card of the discard pile.
 */
export function isValidPlay(card: UnoCard, topCard: UnoCard): boolean {
  return (
    card.color === topCard.color ||
    card.value === topCard.value ||
    card.color === "black"
  );
}

/**
 * Draws one card from the deck into the given hand.
 */
export function drawCard(deck: UnoCard[], hand: UnoCard[]): {
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
  discardPile: UnoCard[]
): {
  hand: UnoCard[];
  discardPile: UnoCard[];
} {
  const index = hand.findIndex(
    (c) => c.color === card.color && c.value === card.value
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
export function getPlayableCard(hand: UnoCard[], topCard: UnoCard): UnoCard | null {
  for (const card of hand) {
    if (isValidPlay(card, topCard)) {
      return card;
    }
  }
  return null;
}

/**
 * Checks if a card is a draw effect card.
 */
export function getDrawCount(card: UnoCard): number {
  if (card.value === "Draw Two") return 2;
  if (card.value === "Wild Draw Four") return 4;
  return 0;
}

/**
 * Returns the next player's turn, accounting for skip/reverse.
 */
export function getNextTurn(
  current: "player" | "ai",
  cardPlayed: UnoCard
): "player" | "ai" {
  if (cardPlayed.value === "Skip" || cardPlayed.value === "Reverse") {
    return current; // Same player plays again
  }
  return current === "player" ? "ai" : "player";
}

export function applyUnoCard(game, card, currentPlayer, chosenColor = null) {
  let { playerHand, aiHand, deck, discardPile = [], turn, currentColor } = game;

  const newDiscardPile = [...discardPile];
  let newPlayerHand = [...playerHand];
  let newAiHand = [...aiHand];
  let nextTurn = turn;

  const switchTurn = () => nextTurn = currentPlayer === "player" ? "ai" : "player";
  const skipTurn = () => { switchTurn(); switchTurn(); };

  let playedCard = { ...card };
  if (card.value === "Wild" || card.value === "Wild Draw Four") {
    playedCard.color = chosenColor;
    currentColor = chosenColor;
  } else {
    currentColor = card.color;
  }

  newDiscardPile.push(playedCard);

  switch (card.value) {
    case "Skip":
      skipTurn(); // skip next player
      break;
    case "Reverse":
      switchTurn(); // just reverse turn
      break;
    case "Draw Two":
      if (currentPlayer === "player") newAiHand.push(...deck.splice(0, 2));
      else newPlayerHand.push(...deck.splice(0, 2));
      skipTurn();
      break;
    case "Wild":
      switchTurn();
      break;
    case "Wild Draw Four":
      if (currentPlayer === "player") newAiHand.push(...deck.splice(0, 4));
      else newPlayerHand.push(...deck.splice(0, 4));
      skipTurn();
      break;
    default:
      switchTurn();
      break;
  }

  return { ...game, playerHand: newPlayerHand, aiHand: newAiHand, deck, discardPile: newDiscardPile, turn: nextTurn, currentColor };
}
