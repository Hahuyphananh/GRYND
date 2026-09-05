# Blackjack — Game Guide

Blackjack on GRYND is a **best-of-3-round** duel between two seats (you vs a human opponent, or you vs the GRYND AI). The classic goal still applies — get closer to **21** than your opponent without going over — but each round is played head-to-head with a shared deck and a set of skill actions that let you recover from a bad hand.

## How a match works

1. **Matchmaking** — pick a stake in the lobby and get matched (AI mode starts instantly). The stake is escrowed for PvP.
2. **Round play** — each round deals both players two cards. Play continues until **both seats** have finished their hands:
   - **Hit** — draw another card.
   - **Stand** — keep your hand and lock it. The round resolves when both seats leave "playing".
   - **Swap** — click a card in your hand to mark it, then **Swap** to replace it with a random draw from the deck.
   - **Freeze** — lock your current score so a later bust can't hurt you.
   - **Peek** — see the next card off the shoe before deciding.
   - **Hold** — reserve a card for later (add it to your hand or discard it when you need it).
3. **Bust recovery** — a busted hand is not instantly lost: **Swap** and **Freeze** stay available so you can recover before the round resolves. Hit/Stand are disabled on a busted seat.
4. **Round resolution** — the higher score under 21 wins the round (busts lose; ties are handled per round). The opponent's cards and score are kept hidden until the round ends — you only see your own hand and the round result.
5. **Match end** — first player to win **2 of 3** rounds takes the pot. A tied 3-round series deals a **round-4 tiebreak**. The winner gets their stake back plus 90% of the loser's stake; the house keeps 10% of the loser's stake. AI practice matches never move tokens.

## Round timer

Each round runs on a **30-second** timer. If the round deadline expires, the server auto-resolves the hand — so you can't stall to pressure the opponent.

## Payout

- **Winner** — own stake back + 90% of the loser's stake.
- **Loser** — loses the entire stake.
- **House** — 10% rake on the loser's stake only.
- **Draw / cancelled** — stakes refunded.

## Modes

- **Blackjack vs AI** — free practice against the GRYND AI (no tokens wagered or awarded).
- **Blackjack PvP** — real-time duel against another player for the stake pot.

## Key numbers

| Constant | Value |
| --- | --- |
| Rounds per match | 3 (best-of-3, plus a round-4 tiebreak on a tie) |
| Round timer | 30 seconds |
| House rake (PvP) | 10% of the loser's stake |