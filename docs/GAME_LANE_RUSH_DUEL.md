# Lane Rush Duel — Game Guide

Lane Rush Duel is a **memory-deduction race** across one shared, provably-fair glass bridge. Both players cross the **same 10 rows**, alternating turns: each row hides exactly one bad tile, a safe step keeps your turn, and the **first player to cross row 10 wins**.

## How a match works

1. **Matchmaking** — pick a stake (free AI practice is token-free). ONE bridge is generated provably-fair from a shared server seed, the host's client seed and the match id; both players see the same difficulty and the exact same rows.
2. **Alternating turns** — only the player whose turn is live may choose, and only on the row they are standing on. The server owns the turn: a stale click or a replay can never resolve twice.
3. **On your turn, choose one of:**

   - **PICK a tile** on your current row — a **safe** tile advances you one row and you **keep the turn** (choose again immediately); the row's single **bad tile** breaks for the rest of the match, ends your attempt and sends you **back to Row 1**, handing the turn to your opponent.
   - **FLAG** — mark a tile you **personally landed on safely**, so you can remember it (2 flags per match, public to both players, append-only, never consumes your turn). Flags never assert safety the server has not already witnessed.

## Win conditions

- **First across row 10** wins immediately.
- **A fall never ends the match** — it only breaks a tile, resets that player to Row 1 and passes the turn.
- **Resignation** — the resigner forfeits and the opponent wins.

## Timer

- Every tile choice has a **15-second** window. A safe step resets it; a fall starts your opponent's fresh window. The server clock is authoritative, and letting the window expire ends your attempt exactly like a fall (without breaking a tile).

## Payout

- **Winner** — own stake back + 90% of the loser's stake.
- **Loser** — loses the stake.
- **Draw** — both refunded, no rake.

## Key numbers

| Constant | Value |
| --- | --- |
| Bridge rows | 10 |
| Bad tiles per row | Exactly 1 |
| Tiles per row | Difficulty-based (easy 4 / medium 3 / hard 2) |
| Choice window | 15 seconds |
| Memory flags per player | 2 |