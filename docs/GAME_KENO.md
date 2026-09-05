# Keno — Game Guide

GRYND has two Keno games built on the same 40-ball pool and the same multiplier table: **solo Keno** (pick numbers, watch the draw, get paid by the multiplier table) and **Keno Catch Duel** (a PvP reaction race where both players tap glowing balls as they stream in).

## Solo Keno

1. **Pick numbers** — choose **1 to 10 numbers** from the 1–40 grid (or use auto-pick for 5).
2. **Draw** — **10 winning numbers** are drawn at random from the pool.
3. **Payout** — payout = bet × multiplier for your (picks, hits) combination from the shared multiplier table. Fewer hits than the table's minimum pay nothing.

### Solo multiplier table (excerpt)

| Picks | Hits → Multiplier |
| --- | --- |
| 1 | 1 → 3 |
| 3 | 1 → 1, 2 → 3, 3 → 10 |
| 5 | 2 → 1.5, 3 → 5, 4 → 15, 5 → 50 |
| 8 | 4 → 5, 5 → 25, 6 → 150, 7 → 600, 8 → 2500 |
| 10 | 4 → 2, 5 → 7, 6 → 35, 7 → 180, 8 → 700, 9 → 1800, 10 → 5000 |

## Keno Catch Duel (PvP)

1. **Matchmaking** — pick a stake (free AI practice is token-free).
2. **Shared draw each round** — both players face the **same** 10-ball stream (drawn server-side from the 1–40 pool; the release schedule is derived from the round deadline so both clients see the identical stream).
3. **Catch the glow** — tiles light up one at a time and stay glowing for **0.8 s**. Tap a glowing tile to catch that ball; tap after the glow fades and you miss (the tile turns red). A small latency cushion makes taps sent while visibly glowing still land.
4. **Round score** — your score for the round is the classic keno multiplier for the number you caught (catching 5 is worth ×50, catching all 10 is worth ×5000) — catching more dominates.
5. **First to 10 cumulative points** wins the match pot. If nobody reaches 10 within **16 rounds** (≈3 min), the match enters a **30-second overtime** and the leader wins; an overtime tie is a draw (95% refund per side).

## Payout

- **Solo** — instant payout = bet × multiplier from the table.
- **PvP** — winner takes the pot (90/10 rake on the loser's stake); draws refund.

## Key numbers

| Constant | Value |
| --- | --- |
| Number pool | 40 |
| Draw size | 10 per round |
| Max picks | 10 (solo) / catch-all-10 (PvP) |
| PvP win target | 10 cumulative points |
| PvP max rounds | 16 + 30 s overtime |
| Glow window (PvP) | 0.8 s per ball |