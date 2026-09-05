# Dots & Boxes — Game Guide

Dots & Boxes is the classic pencil-and-paper territory game: players take turns drawing edges on a **7×7 dot grid** (36 boxes). Each box you complete is yours; the player who claims the most boxes when every edge is drawn wins.

## How a match works

1. **Mode** — play the AI or a staked PvP match.
2. **Turn play** — on your turn, place **one edge** between two adjacent dots (horizontal or vertical).
   - Edges are validated server-side (bounds, not already drawn, correct turn).
3. **Claiming boxes** — after placing an edge, every box whose **4th side** you just completed is claimed by you and scores +1.
   - Claim at least one box → you get **another turn** (multiple boxes from the same edge count as ONE bonus turn — no infinite chains).
   - Claim nothing → the turn switches to your opponent.
4. **Game end** — the match ends when all **84 edges** are drawn. **Most boxes wins**; equal boxes is a draw (stakes refunded).

## Timer

Each move runs on a **20-second** turn timer (tuned after player feedback; clamped 5–120 s server-side). Miss the deadline and the server resolves your turn.

## Payout

- **Winner** — takes the pot (stake back + winnings; standard 90/10 rake on the loser's stake).
- **Loser** — loses the stake.
- **Draw** — both refunded.

## Key numbers

| Constant | Value |
| --- | --- |
| Dot grid | 7×7 → 6×6 boxes (36 total) |
| Edges | 84 total |
| Turn timer | 20 seconds |