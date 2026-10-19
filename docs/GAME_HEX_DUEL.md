# Hex Duel — Game Guide

Hex Duel is a **hex-grid strategy territory war** between two players. Each turn you spend **action points (AP)** to move your units, capture tiles, reinforce, and attack the opponent's territory — the player who controls the most territory (or eliminates the opponent) wins.

## How a match works

1. **Setup** — each player starts with a **capital** tile and initial troops on a hex grid (a single shared board; no fog-of-war between the two players beyond your opponent's unit counts).
2. **AP budget** — each turn you have a limited pool of **action points (max 3 per turn)** to spend on actions:

   | Action | AP cost |
   | --- | --- |
   | Move a unit to an adjacent tile | 1 |
   | Push / displace an opponent's unit | 1 |
   | Reinforce a tile (add troops) | 1 |
   | Attack an adjacent enemy tile | 1 |
   | End turn | 0 |

3. **Capturing** — moving troops onto neutral or enemy tiles captures them for your side; your territory count (tiles held) is tracked every turn.
4. **Troop growth** — captured/held tiles grow troops over time, feeding your attacks and defence.
5. **Win** — the winner is the player who controls the most territory at match end (round limit) or who eliminates the opponent's presence on the board. Rounds and territories are tracked server-side; every action is logged in an action log.

## Key mechanics

- **Action log** — every move/push/reinforce/attack is recorded, so matches are fully reviewable.
- **Capital** — your home tile; losing it is decisive.
- Territory is scored per player each turn; the higher total takes the pot.

## Payout

- **Winner** — takes the pot: **1.8× their own stake** (both stakes minus the platform's 10% rake — the same 80/20 split of the loser's stake, written the other way).
- **Loser** — loses the stake.
- **Draw** — pays nobody.

Both stakes are escrowed when the opponent joins, and all three endings (the server's verdict, a resignation, a disconnect forfeit) settle through one writer (`src/lib/hex-duel/settle.ts`), so the pot is paid exactly once. The **winner is the server's**: the action endpoint replays the moves it accepted through the game's own rulebook (`src/lib/hex-duel/rules.ts`) and writes the winner itself — the finish request only signals that the board is over and cannot name a winner.

## Key numbers

| Constant | Value |
| --- | --- |
| Stake | 1–100 coins (`GLOBAL_MAX_BET`), required to open a ranked lobby |
| Payout | 1.8× the winner's stake (10% rake: `PVP_RAKE_PCT`) |
| Action points per turn | 3 |
| Action costs | 1 AP each (move / push / reinforce / attack) |
| Win | Most territory at match end (or elimination) |