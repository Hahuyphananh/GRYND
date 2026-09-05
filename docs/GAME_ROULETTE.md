# Roulette — Game Guide

Roulette on GRYND is a head-to-head wheel duel. You and your opponent (a human or the GRYND AI) play **match points**, not your token wallet directly: both players start a match with **100 points** and bet from that balance round after round. The player who out-bets the other on the wheel wins the match pot; the first player whose points hit **0** is eliminated.

## How a match works

1. **Create or join a lobby** — pick a stake (free AI practice costs nothing; PvP escrows your stake). Both players are dealt the same starting balance of **100 match points**.
2. **Betting phase** — place chips on the roulette table (numbers 0–36, or outside bets like Red/Black, Odd/Even, 1-12, 13-24, 25-36, 1-18, 19-36, Green). Your chips come **out of your match points**, which persist across rounds:
   - Bets are staged locally first, then submitted with **Lock in**.
   - You can never bet more than your current match-point balance — staged bets are capped at what you own.
   - Right-click any tile (number or outside bet) to clear just that tile's bet; "Clear bets" wipes the whole board.
3. **Spin** — the server resolves the round with a random number. Winning bets are paid from the payout table (mirroring classic roulette: straight numbers, splits, outside bets, etc.) at your standard multipliers; the round result shows how many points each player has now.
4. **Round result → match end** — after each round both players' new balances are shown. When a player's balance hits **0**, the round result stays on screen for a few seconds, then the winner/loser popup appears (win for the survivor, loss for the player at 0).

## Scoring & match end

- **Round scoring** — each round's (payout − bets) is credited/debited from the persistent match-points balance. You can never go below 0.
- **Elimination** — a player at 0 match points is out. If both players are wiped out on the same spin the match is a **draw** and stakes are refunded.
- **Sudden death** — in drawn-out matches the rules enter sudden-death rounds to force a winner.
- **Payout** — the winner takes the pot (their stake back plus winnings); the house keeps a small rake on PvP matches (2.5%). AI practice matches never move tokens.

## Skill layer

- **Eliminate** — spend **10 match points** to permanently remove a number (or the 0 pocket) from the wheel for the rest of the match. Dead numbers are struck through and can't be bet on. Use it to shrink the board the opponent can win on.
- **Call their bet** — optionally guess the opponent's biggest wager before locking in; a correct call earns a bonus transfer.

## Modes

- **Roulette vs AI** — free practice against the GRYND AI (no tokens wagered or awarded).
- **Roulette PvP** — real-time duel against another player for the stake pot.

## Key numbers

| Constant | Value |
| --- | --- |
| Starting match points | 100 |
| Elimination cost | 10 points per number |
| Numbers on the wheel | 0–36 (standard roulette) |
| House fee (PvP) | 2.5% of the pot |