# Lane Rush — Game Guide

Lane Rush is a **1v1 simultaneous-planning racing game**. Both seats own a
garage, spend a short planning window each round building and repairing cars,
deploy up to four cars to one of three route lanes, and then the server races
both grids at once. The first seat to **1,000 cumulative points** wins.

> This is the player-facing guide for the live game. The deeper engine/rules
> reference (state shape, API, lifecycle and code map) is
> [`GAME_LANE_RUSH.md`](./GAME_LANE_RUSH.md). The retired glass-bridge board is
> kept only for historical rows — see [Legacy matches](#legacy-matches).

## How a match works

1. **Matchmaking** — pick a stake and press Play, or take a free practice race
   against the bot. Each new match is created as a race (state version `1`).
2. **Planning (60 seconds)** — both seats plan at the same time with
   **2 action points**. You deploy cars to lanes, buy / merge / repair, then
   **lock in**. The opponent's lane choices stay hidden until the round is
   resolved.
3. **Race** — when both seats are locked in (or the 60 seconds run out) the
   server rolls every racing car with its own random values, applies the round
   exactly once, stores the result and immediately opens the next planning
   window.
4. **Repeat** until a seat reaches 1,000 points, resigns, or the lobby is
   cancelled before the match starts.

## Starting position (both seats, identical)

| Resource | Start |
| --- | --- |
| Cars | 2 × Tier 1 (garage) |
| Scrap | 4 |
| Fuel chips | 0 |
| Tech chips | 0 |
| Points | 0 |
| Action points | 2 per planning phase |
| Max owned cars | 8 (garage + racing + workshop) |
| Max cars racing | 4 |
| Planning window | 60 seconds (server clock) |

## Cars and tiers

| Tier | Name | Base points per finished run |
| --- | --- | ---: |
| 1 | Compact | 12 |
| 2 | Sport | 28 |
| 3 | Supercar | 65 |
| 4 | Hypercar | 150 |

- **Buy** — Tier 1 only: 2 Scrap + 1 action point.
- **Merge** — two **undamaged** cars of the **same tier** for 1 action point.
  Both cars are consumed and one car of the next tier is created. Tier 4 is the
  maximum.
- **Repair** — 1 Scrap + 1 action point. The car returns to the garage
  undamaged.
- **Damaged cars** cannot race, merge or be deployed until repaired.

## Routes

| Route | DNF chance | Points | Success reward |
| --- | ---: | ---: | --- |
| Safe Circuit | 5% | 1.0× | +1 Scrap |
| Sprint Lane | 15% | 1.5× | +1 Fuel |
| Risk Route | 30% | 2.2× | +1 Tech |

A finished run scores **tier base points × route multiplier**, rounded once with
`Math.round` (a Compact on the Risk Route scores `12 × 2.2 = 26.4 → 26`; a
Supercar on Sprint scores `65 × 1.5 = 97.5 → 98`).

- A **DNF** scores nothing, pays no route chip, and the car returns to the
  garage **damaged**.
- A **finished** car returns to the garage undamaged, with no route, ready for
  the next round.
- Deploying a car, recalling it and changing its route are **free**; only the
  garage economy spends action points.

## Action points

Each planning phase grants a fresh **2 action points**. They are *set* to 2 each
round (never accumulated) and never go negative.

| Action | Cost |
| --- | --- |
| Buy a Tier 1 car | 2 Scrap + 1 AP |
| Deploy a garage car | free |
| Return a deployed car to the garage | free |
| Change a deployed car's route | free |
| Merge two same-tier cars | 1 AP |
| Repair a damaged car | 1 Scrap + 1 AP |
| Lock in | free |
| Workshop recovery | free (consumes the phase) |

## Deadline and lock-in

The server clock is the only deadline authority. A seat that locks in has its
plan frozen for the round; when both seats are locked in the round resolves
immediately. If the 60 seconds expire, the round is finalized with whatever each
seat had deployed at that moment — unsubmitted actions never applied, and an
unlocked seat simply races the grid it had. Late actions are rejected with
`deadline_expired`.

## Workshop recovery (soft-lock guard)

A seat with **0 Scrap and every owned car damaged** can hand one car to the free
workshop:

- costs no Scrap and no action points;
- **consumes the planning phase** (you are locked in immediately);
- completes during race resolution, so the car is back in the garage
  **undamaged for the next round**.

A car in the workshop cannot race, merge, be repaired or enter the workshop
again until recovery completes.

## Winning and payout

- **First to 1,000 points** wins immediately.
- If both seats cross 1,000 in the same round, the **higher total** wins.
- An **exact tie** at the target is a draw and both stakes are refunded.
- **Winner** — own stake back + 80% of the loser's stake (1.8× total).
- **Loser** — loses the stake.
- **Resignation** — the resigner forfeits; the opponent wins and the match
  settles through the same path.

After the match ends no further planning actions are accepted.

## Practice

The bot submits an ordinary validated plan — it buys, merges, repairs and locks
in by the same rules a human does. Only its **route risk appetite** changes with
the chosen difficulty. Practice races are zero-stake and never feed rating,
trophies or leaderboards.

## Legacy matches

Unfinished matches created before the cutover keep `game_state_version = 0` and
stay on the retired glass-bridge transitions. Their result, payout and history
are preserved, and the match page shows an explicit "retired bridge board"
notice instead of racing controls. A legacy row is never read as a race.
