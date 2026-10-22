# Odds — Game Guide

Odds is a **shared-target prediction duel**. Each round the server picks one secret number in **1–100** and gives **both players the same clue**. Both call it independently — an exact number or a range — and the narrower your call, the more it pays. Highest total after **5 rounds** takes the pot.

## How a round works

Both players act at the same time (no turn-taking, no roles):

1. **Clue** — the server draws the round's target in `1..100` and derives a clue from it. Both seats see the same clue, and it always leaves at least five possible numbers standing.
2. **Call it** — each player submits **one** prediction: an exact number, or an inclusive range (`min..max`). Neither player sees the other's call, and the target stays server-side.
3. **Reveal** — once both calls are in, the target, both calls and both scores are revealed, and the next round opens with a fresh target and a tighter clue.

## Scoring

| Your call | Result | Points |
| --- | --- | --- |
| Exact number | correct | **100** |
| Exact number | wrong | **0** |
| Range containing the target | `max(1, round(100 / width))` | 1–100 |
| Range missing the target | — | **0** |

`width` is the inclusive width of the range: `max - min + 1`. A one-number range therefore pays 100, `41–42` pays 50, `40–44` pays 20, `1–100` pays 1. Narrower calls pay more, but miss more often.

All inputs are validated as integers in `1..100`, with `min <= max`. Every score is computed on the server from the round's own target — a client never supplies a score.

## The clue ladder

The domain is fixed at 1–100 for **every** round. What changes is the clue: short, direct, and deliberately vague early, then tighter as the match goes on. Both seats always get the same sentence, generated on the server from that round's target.

| Round | Clue formats | Targets left standing |
| --- | --- | --- |
| 1 | `Higher than X.` · `Lower than X.` · `Somewhere in the upper half.` · `Somewhere in the lower half.` | 40–60 |
| 2 | The same four formats, with a tighter boundary band | 30–45 (or a half) |
| 3 | `Higher than X.` · `Lower than X.` · `Between A and B, inclusive.` | 16–30 |
| 4 | `Between A and B, inclusive.` — more restrictive | 9–16 |
| 5 | `Between A and B, inclusive.` — the tightest clue | 5–9 |

The halves are fixed: **lower half 1–50, upper half 51–100**. Boundaries are solved from the actual target — "Higher than X" leaves `100 − X` targets, "Lower than X" leaves `X − 1` — so every clue is true, and both comparisons are strictly exclusive.

Parity and divisibility hints are never used, and no clue ever leaves fewer than **five** possible targets: the generator refuses a sentence that would come too close to naming the answer.

## Match end

After **5 rounds**, the player with the higher **cumulative score** wins the pot. An exact tie is a **draw** (both stakes refunded).

## Payout

- **Winner** — takes the pot (both stakes minus the shared house rake).
- **Loser** — loses the stake.
- **Draw** — both stakes refunded.
- **Abandoned / timed-out round** — the seat still present banks the pot; a match both players walked away from is voided and both stakes are refunded.

A stake is never both paid and refunded: every ending writes one terminal row inside one transaction.

## Key numbers

| Constant | Value |
| --- | --- |
| Rounds per match | 5 |
| Domain (every round) | 1–100 |
| Max points per round | 100 (exact hit) |
| Round timeout | 120 s before the present seat may claim a forfeit |
