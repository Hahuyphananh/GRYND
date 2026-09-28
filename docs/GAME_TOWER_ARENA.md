# Tower Arena — Game Guide

Tower Arena is a **1v1 physics block-stacking survival duel**. Two players take
turns dropping blocks onto a tiny floating platform, building one tower as high
as they can — and the first one who is forced to breach the ceiling loses.

Every match is strictly two seats. The old 2–6 player shared-table mode was
retired, and the board went with it: it is **half the width** it was when a
table of up to six players built the tower, so the stack fills the line and
runs out of room far sooner.

## How a match works

1. **Lobby & stakes** — create or join a 1v1 match with a chosen stake (free AI
   practice is token-free).
2. **Placement phase** — on your turn a falling block shape descends from the
   top of the board. Position it over the tower and drop it; gravity and
   collision physics decide where it settles.
   - The board is a narrow **8-column** line, sized for two players, with a
     visible **hard ceiling** above it.
   - Blocks spawn above the ceiling and fall with gravity onto the highest
     support below their footprint.
   - The shared pool is sized for exactly two seats, so a cycle offers **two
     pieces of every shape**.
3. **Losing** — the **only** losing placement is one whose top crosses the
   ceiling: the tower keeps everything below it and the player who dropped is
   eliminated. You may also resign.
4. **Winner** — with the dropper eliminated the other seat is the last tower
   standing and takes the pot. The match ends immediately at that placement.

## Match controls

- **Move** — shift the falling block left/right.
- **Drop / hard-drop** — place the block.
- **Rotate** — rotate the block (R).
- **Pause** — the match can be paused (in human-vs-AI matches), freezing the
  turn timer while the creator reviews a recording.

## Payout

- **Winner** — takes the pot (their stake back plus winnings, per the standard
  rake).
- **Loser** — loses their stake.

## Modes

- **Tower Arena vs AI** — free practice against the GRYND AI on the same board.
- **Tower Arena PvP** — real-time 1v1 duel for the stake pot.

## Notes

- Turn order and elimination are server-authoritative; the client only animates
  and renders.
- Tower Arena integrates Creator Mode: pressing **Stop & Save** while recording
  pauses the match so the creator can review the clip, and the recording result
  panel offers a **Go back to lobby** button.
