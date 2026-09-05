# Pool Masters — Game Guide

Pool Masters is a physics-based **8-ball pool** duel: sink your group (solids or stripes), then the 8-ball, before your opponent does. Playable against the AI or a real opponent for a stake.

## How a match works

1. **Break** — the cue ball breaks the racked 15 balls.
2. **Groups** — after the break, the table is **open**: your first legally pocketed ball assigns your group.
   - **Solids** = balls 1–7; **Stripes** = balls 9–15.
   - Once assigned, you must hit your own group first on every shot.
3. **Turn rules** — sink one of your balls → you keep shooting; miss or foul → the turn passes.
4. **Fouls** (server-validated):
   - **Scratch** (cue ball pocketed) — ball in hand for the opponent.
   - Hitting the wrong group first, no rail contact after contact, or pocketing the **8-ball** early.
5. **Win** — clear your group, then legally pocket the **8-ball**. Pocketing the 8-ball early or on a foul loses the match.

## Rules engine

- The server is the single authority: shot legality (first contact, rail after contact, scratch, open table), fouls, and winner are all evaluated server-side; the client renders physics and animations.
- A match is a best-of style race — rounds accumulate (rounds-won tallies) and the match winner takes the pot.

## Payout

- **Winner** — takes the pot (stake back + winnings; standard rake).
- **Loser** — loses the stake.
- **Draw** — both refunded.

## Modes

- **Pool vs AI** — free practice.
- **Pool PvP** — staked 8-ball duel.

## Key numbers

| Constant | Value |
| --- | --- |
| Balls | 15 object balls + cue (8-ball rules) |
| Groups | Solids 1–7 / Stripes 9–15 |
| Win | Pocket your group, then the 8-ball legally |