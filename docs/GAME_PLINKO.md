# Plinko — Game Guide

Plinko Duel is a **physics skill duel**: you and your opponent launch balls down a peg board and score points based on which bucket each ball lands in. The skill is in the launch — power and angle decide whether your ball lands in a high-value bucket or a trap.

## How a match works

1. **Matchmaking** — pick a stake in the lobby (free AI practice is token-free).
2. **Each player launches 3 balls** (one per ball-phase: ball 1 → ball 2 → ball 3). Before each launch you set two inputs:
   - **Power** — how hard the ball is launched (0–100).
   - **Angle** — the launch direction (swing of ±45°).
3. **Physics resolution** — the server runs a deterministic ball simulator: the ball falls through a **19-row peg grid**, bouncing off pegs and **off the opponent's balls** (ball-on-ball collisions are a real skill element — you can knock the opponent's ball off course), until it lands in one of **5 buckets**.
4. **Scoring** — the bucket table is the same every ball:
   | Bucket | Points |
   | --- | --- |
   | Far left / far right (safe edges) | 100 |
   | Left / right precision | 140 |
   | Center trap | 40 |
   | Outside the board | 0 |
5. **Match resolution** — the player with the higher **total points across their 3 balls** wins the pot. A tie is a draw (full refund).

## Modes

- **Plinko vs AI** — free practice; the AI picks deterministic-but-varied launch inputs per ball.
- **Plinko Duel PvP** — real-time duel for the stake pot.

## Payout

- **Winner** — own stake back + 90% of the loser's stake (per the shared 90/10 split).
- **Loser** — loses the entire stake.
- **Draw** — both refunded, no rake.

## Key numbers

| Constant | Value |
| --- | --- |
| Balls per player | 3 |
| Peg rows | 19 |
| Buckets | 5 (100 / 140 / 40 / 140 / 100) |
| Max match points | 420 (3 × 140) |
| Launch swing | ±45° |