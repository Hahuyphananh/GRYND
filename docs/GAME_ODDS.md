# Odds — Game Guide

Odds is a **mind-reading prediction duel**. Every round the guessing range shrinks; you pick a hidden number, then try to predict the opponent's number — the closer your prediction, the more points you earn. Highest total after 6 rounds takes the pot.

## How a round works

Each round has **two simultaneous phases** (no turn-taking, no roles):

1. **Pick your number** — both players secretly lock in their own number in `1..currentMax`. The opponent's number is never sent to you.
2. **Predict opponent** — once both numbers are locked in, each player predicts the opponent's number in `1..currentMax`. Predictions stay hidden until both are submitted.
3. **Reveal** — both numbers, both predictions, and the accuracy points are revealed.

## Scoring (fixed band table)

The closer your prediction to the opponent's actual number, the more points — the same table every round:

| Difference | Points |
| --- | --- |
| 0 (exact) | +100 |
| 1 | +80 |
| 2 | +60 |
| 3 | +40 |
| 4–5 | +20 |
| 6–10 | +10 |
| >10 | +0 |

A prediction outside the current range scores 0; no prediction can earn more than +100.

## The shrinking range

The guessing range halves every round — that's the progression mechanic (scoring never scales):

| Round | Range |
| --- | --- |
| 1 | 1–100 |
| 2 | 1–50 |
| 3 | 1–25 |
| 4 | 1–12 |
| 5 | 1–6 |
| 6 | 1–3 |

## Match end

After **6 rounds**, the player with the higher **cumulative score** wins the pot. An exact tie is a **draw** (both stakes refunded).

## Payout

- **Winner** — takes the pot (stake back + winnings; standard 90/10 rake on the loser's stake).
- **Loser** — loses the stake.
- **Draw** — both refunded.

## Key numbers

| Constant | Value |
| --- | --- |
| Rounds per match | 6 |
| Round 1 range | 1–100 |
| Max points per round | 100 (exact prediction) |