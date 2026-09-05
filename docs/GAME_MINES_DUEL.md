# Mines Duel — Game Guide

Mines Duel is a 1v1 (or vs-AI) nerve game on a **5×5 board** with a hidden minefield. Players take turns revealing tiles; the first player to step on a mine loses the pot.

## How a match works

1. **Matchmaking** — pick a stake in the lobby (free AI practice is token-free). The server generates a hidden 5×5 board and randomly assigns who picks first.
2. **Alternating picks** — both players reveal tiles in a fixed alternating pattern (pairs of turns — the pair-leader swaps every pair, so the pattern repeats every 4 turns):
   - Turn order: FP, SP, SP, FP, FP, SP, SP, FP, …
3. **Each pick has a 20-second window** — miss the deadline and the server auto-picks a random cell for you.
4. **Resolution** — a round ends the moment a mine is revealed:
   - **P1 picks mine + P2 picks mine** → P2 loses (P1 mined first).
   - **P1 mine + P2 safe** → P1 loses.
   - **P1 safe + P2 mine** → P2 loses.
   - **P1 safe + P2 safe** → **draw** — the round replays with a fresh board (full refund, no house fee).

## Payout

- **Winner** — own stake back + **90%** of the loser's stake.
- **Loser** — loses the entire stake.
- **House** — 10% rake on the loser's stake only.
- **Draw** — both refunded, no rake.

## Modes

- **Mines Duel vs AI** — free practice against the GRYND AI.
- **Mines Duel PvP** — real-time duel against another player for the stake pot.

## Key numbers

| Constant | Value |
| --- | --- |
| Board | 5×5 (25 tiles) |
| Mines per board | 1–24 (server-randomised) |
| Pick timer | 20 seconds per turn |
| House rake (PvP) | 10% of the loser's stake |