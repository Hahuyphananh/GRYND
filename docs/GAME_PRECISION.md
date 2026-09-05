# Precision — Game Guide

Precision is a **reflex-stop duel**: each round a hidden timer runs toward a random target time, and both players race to stop it as close to the target as possible. Best of 5 rounds — first to 3 wins takes the pot.

## How a round works

1. **Arming** — a round begins with a brief arming phase; the server rolls a **fresh hidden target** between **2.5 s and 10 s** for that round (millisecond precision, e.g. 3821 ms). The target is stored server-only and revealed only when the round goes active — both clients see the same revealed value at the same time.
2. **Active — STOP!** — a countdown/timer runs. Both players hit **Stop** when they judge the target time has been reached.
3. **Resolution** — whoever stops closest to the target time wins the round (+1 round win). Round scores are server-authoritative.

## Match format

- **Best of 5** — the first player to win **3 rounds** ends the match and takes the pot (max 5 rounds).
- Round targets are independent every round (random 2.5–10 s), so there's no memorising a fixed length.

## Payout

- **Winner** — takes the pot (stake back + winnings; standard 90/10 rake on the loser's stake).
- **Loser** — loses the stake.

## Modes

- **Precision vs AI** — free practice against the GRYND AI.
- **Precision PvP** — staked best-of-5 duel (also has a free test/practice page).

## Key numbers

| Constant | Value |
| --- | --- |
| Win target | 3 round wins (best of 5) |
| Target time | Random 2.5–10 s per round |
| Seats | 2 (strictly 1v1) |