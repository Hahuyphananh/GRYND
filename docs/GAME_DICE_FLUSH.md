# Dice Flush — Game Guide

> **Retired from the public catalogue.** Dice Flush has been replaced by
> **Barricade** (see [`docs/GAME_BARRICADE.md`](./GAME_BARRICADE.md)), which now
> holds its lobby card, public landing page and featured slot. Its legacy URLs
> 308-redirect to Barricade. This guide is kept because the game's engine
> (`game-engine/diceFlushEngine.ts`), its `dice_flush_*` tables,
> its `/api/dice-flush/*` routes, its historical matches and its per-game Elo and
> trophy rows are all deliberately preserved by that cutover — it is simply no
> longer offered in the product.

Dice Flush is GRYND's **Yahtzee-style** dice game: roll five dice up to three times per turn, then score your hand into a category on the shared scoresheet. Build the highest total score over the match to win the pot.

## How a round works

1. **Roll** — five dice are rolled. You may keep any dice and re-roll the rest — **up to three rolls per turn**.
2. **Score a category** — after your rolls, place the hand into one unused category on the shared scoresheet. Once used, a category is locked for the rest of the game.
3. **Categories** (classic Yahtzee sheet):

   - **Upper section** — Ones, Twos, Threes, Fours, Fives, Sixes: score the total of that die value.
   - **Lower section** — Three of a Kind, Four of a Kind, Full House, Small Straight, Large Straight, Chance (and the top bonus / Yahtzee rules where the sheet defines them).

4. **Match end** — after the full scoresheet is filled (all categories used by both players), the player with the **higher total score** wins the pot; a tie is a draw (stakes refunded).

## Turn rules

- Rolling is simultaneous-per-turn or turn-based per the match flow (each player completes their roll phase before the next).
- The scoresheet is shared and visible to both players — you can see which categories are still open and what the opponent needs.

## Payout

- **Winner** — takes the pot (stake back + winnings; standard 80/20 rake on the loser's stake (10% of the pot)).
- **Loser** — loses the stake.
- **Draw** — both refunded.

## Modes

- **Dice Flush vs AI** — free practice.
- **Dice Flush PvP** — staked match against another player.

## Key numbers

| Constant | Value |
| --- | --- |
| Dice | 5 |
| Rolls per turn | Up to 3 |
| Scoresheet | Shared, classic Yahtzee categories |
| Win | Higher cumulative total when the sheet fills |