# Tower Arena — Game Guide

Tower Arena is a **physics block-stacking survival duel**. Drop blocks onto a tiny floating platform, build your tower as high as you can — and don't let it topple into the void. Players take turns stacking on a shared tower; the last player standing wins.

## How a match works

1. **Lobby & stakes** — create or join a match with a chosen stake (free AI practice is token-free).
2. **Placement phase** — on your turn a falling block shape descends from the top of the board. Position it over the tower and drop it; gravity and collision physics decide where it settles.
   - Blocks stack cell by cell on the shared tower.
   - A **hard ceiling** caps how high you can build — a placement whose top crosses the ceiling is invalid.
   - The tower is unstable: a careless drop that makes the tower collapse eliminates you.
3. **Elimination** — a player whose tower falls into the void (or who breaches the ceiling / resigns) is eliminated at their current place. The server eliminates the player when their collapse animation completes.
4. **Last tower standing** — the match continues until one player remains; that player wins the pot. Eliminated players can spectate until the match finishes.

## Match controls

- **Move** — shift the falling block left/right.
- **Drop / hard-drop** — place the block.
- **Pause** — the match can be paused (in human-vs-AI matches), freezing the turn timer while the creator reviews a recording.

## Payout

- **Winner** — takes the pot (their stake back plus winnings, per the standard 90/10 rake on the loser's stake).
- **Loser / eliminated** — loses their stake.

## Modes

- **Tower Arena vs AI** — free practice against the GRYND AI.
- **Tower Arena PvP** — real-time duel (or up to a table) for the stake pot.

## Notes

- The board is a wide floor with a visible hard ceiling; blocks spawn above it and fall with realistic gravity.
- Turn order and elimination are server-authoritative; the client only animates and renders.
- Tower Arena integrates Creator Mode: pressing **Stop & Save** while recording pauses the match so the creator can review the clip, and the recording result panel offers a **Go back to lobby** button.