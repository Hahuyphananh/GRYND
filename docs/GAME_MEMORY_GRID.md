# Memory Grid — Game Guide

Memory Grid is a **pattern-recall race** between two players. A grid of tiles lights up for a few seconds; both players then reconstruct the pattern from memory on their own blank grid — whoever recalls more tiles, more accurately, wins the match.

## How a match works

1. **Matchmaking** — pick a stake in the lobby (free AI practice is token-free).
2. **Exactly 5 rounds**, each with a fixed grid size and number of lit tiles:
   | Round | Grid | Lit tiles | Memorize time |
   | --- | --- | --- | --- |
   | 1 | 3×3 | 3 | 2.5 s |
   | 2 | 4×4 | 5 | 3.0 s |
   | 3 | 4×4 | 7 | 3.0 s |
   | 4 | 5×5 | 10 | 3.5 s |
   | 5 | 5×5 | 14 | 4.0 s |
3. **Two simultaneous phases each round** (both players play at once — no turn-taking):
   - **Memorize** — the SAME server-generated pattern lights up for both players.
   - **Reconstruct** — the grid goes dark; each player taps the tiles they remember on their own grid. Submit when done (you then wait for the opponent; the AFK timer auto-locks a player who doesn't finish).
4. **Round scoring** — each round scores out of **100**: the percentage of grid cells reconstructed correctly. Speed never changes points.
5. **Match winner** — after round 5, the higher **total cumulative score** wins. An exact tie deals a **6th tiebreak round** (6×6, 18 tiles, 4 s). If the tiebreak also ties, the match is a **draw**.

## Determinism & fairness

- Every round's pattern derives from the match's random **server seed** (SHA-256) — both players are guaranteed the exact same grid, the client never generates the pattern, and the post-match seed reveal makes every round independently verifiable.

## Payout

- **Winner** — own stake back + 90% of the loser's stake.
- **Loser** — loses the entire stake.
- **Draw** — both refunded, no rake (a tiebreak-round draw refunds 95% per side).

## Modes

- **Memory Grid vs AI** — free practice.
- **Memory Grid PvP** — real-time duel for the stake pot.

## Key numbers

| Constant | Value |
| --- | --- |
| Rounds per match | 5 (+1 tiebreak on an exact tie) |
| Round scale | 0–100 points, exact accuracy |
| Grid progression | 3×3 → 4×4 → 4×4 → 5×5 → 5×5 |