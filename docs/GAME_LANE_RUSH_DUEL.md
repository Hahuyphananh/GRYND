# Lane Rush Duel — Game Guide

Lane Rush Duel is a **high-risk climbing race** on a shared, provably-fair tower. Both players climb their own lane of the same tower, alternating turns: pick safe tiles to gain points, bank your score to protect it, flag the hidden bad tile, and be the **first to bank 1,000 points** to win.

## How a match works

1. **Matchmaking** — pick a stake (free AI practice is token-free). A shared tower is generated provably-fair from a server seed; both players see the same difficulty and the same lanes.
2. **Alternating turns** — picks are **deferred**: they park as pending and only reveal once both players have acted on the row, so neither player can mirror the other's pick.
3. **On your turn, choose one of:**

   - **PICK a tile** in your current lane — safe advances your lane (your score grows); the **bad tile** busts you (instant loss of everything unbanked).
   - **FLAG** — call the bad tile (limited budget per match). A correct flag claims the row (advance + points, play continues) and reveals the bad tile to both players; a wrong flag busts you.
   - **HOLD (BANK)** — lock your accumulated points as your **safe score** and keep climbing. Banking never ends the climb, but each pick after your Nth bank earns **points × 0.5^N** (first bank → 50%, halving each extra bank). Only banked points are safe — busting costs you everything unbanked.
   - **PEEK** — spend one of a limited number of peeks (before your pick/flag/bank) to privately learn whether a chosen tile is safe or the bad tile. The opponent only sees that you peeked, not which tile or the answer.

## Win conditions

- **First to 1,000 banked points** wins instantly — it's a race to lock 1,000, not to out-score the opponent.
- **Bust** — your climb ends; you keep only your banked total. The survivor keeps climbing alone.
- **Complete all lanes** — the completer wins outright.
- **Fallback** — if both climbs end before 1,000 banked, the higher final score (banked total for a busted player) takes the pot; equal finals is a draw (full refund).

## Payout

- **Winner** — own stake back + 90% of the loser's stake.
- **Loser** — loses the stake.
- **Draw** — both refunded, no rake.

## Key numbers

| Constant | Value |
| --- | --- |
| Win target | 1,000 banked points |
| Flag budget | Limited per match (prevents free wins) |
| Peek budget | Limited per match |
| Bank decay | × 0.5 per extra bank |