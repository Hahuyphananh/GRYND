# Hillstrike fairness evaluation

- Fixed seed set: **204** seeds — 200 consecutive seeds 0…199 (overlapping the fixed seeds below) plus the fixed awkward seeds 424242, 777777, 123456789, 4294967295
- Tiers: normal — slip-free bots, deterministic, reproducible
- Matches per tier: **408** (every seed played with both opening seats)

## Layouts

- Generated: 204/204
- Rejection rate (generator threw): 0.0% (0)
- Validation failures: 0
- Mirror failures: 0
- Playable for both seats: 100.0% (204/204)

## Matches

| tier | matches | player1 wins | player2 wins | opening-seat wins | opening 95% CI | first-shot hit | shot hit rate | mean length |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 408 | 204 | 204 | 406 (99.5%) | 98.2%–99.9% | 94.6% | 91.6% | 5.40 |

### Per-seed pairs (tempo vs seat)

| tier | opening seat won both | same seat won both | split |
| --- | --- | --- | --- |
| normal | 203/204 | 0/204 | 1/204 |

## Asymmetry found

**The opening seat decides the match at high accuracy.** The one-two-two
volley order gives the opener the killing shot first whenever both players
land their shots:

- `normal`: opener wins 99.5% (95% CI 98.2%–99.9%), opening shot hits 94.6% of the time, shot hit rate 91.6%, mean 5.40 shots

The seats themselves are not advantaged: player1 and player2 win equally
often, because every seed is played from both opening seats. This is a TEMPO
asymmetry in the volley rules, not a bias in the map or the physics.

## What this does and does not prove

The map generator is mirror-symmetric, and every layout in this sweep is
mirrored and playable for both seats. That symmetry is necessary and it is not
sufficient: it says nothing about whether a *match* is fair, because the opening
shot, the volley order and the way destruction reshapes one side of the field
are still asymmetric. The numbers above are the measurement of those parts, and
they are reported rather than asserted.

These numbers describe two equally-skilled bots. They are not a claim about
human play, where misses are common; they bound what a near-perfect player can
do with the opening seat.

## Design implications (not implemented here)

- The opening seat is recorded on every match (`openingSeat`), so a staked or
  ranked mode can account for the tempo asymmetry instead of ignoring it.
- If matchmaking ever pairs players of very high accuracy, alternating the
  opening seat across a series (or a best-of-N format) removes the advantage;
  a single match does not.
- The practice ladder should keep `easy` genuinely inaccurate: its low hit rate
  is what makes a practice match last long enough to practise aiming.
