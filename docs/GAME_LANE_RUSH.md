# Lane Rush — Strategic Racing Rules

Lane Rush is a **simultaneous-planning racing game** for two seats. Every round
is a 60-second planning phase followed by a simultaneous race: you build and
maintain a garage, deploy up to four cars to routes, and race them for points.
The first seat to **1,000 points** wins.

> This guide is the engineering/rules reference for the racing game
> (`src/lib/lane-rush/`). `GAME_LANE_RUSH_DUEL.md` is the player-facing guide.
> The legacy glass-bridge transitions that remain in
> `src/lib/lane-rush-duel/` are preserved only for historical rows and are never
> used by a new match.

## Starting position (both seats, symmetric)

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

Cars have stable, seat-scoped ids (`p1-c1`, `p1-c2`, …), an owner, a tier, a
status (`garage` / `racing` / `recovering`), damage, a route selection, and an
upgrade list (empty today; persisted for later rules).

## Cars and tiers

| Tier | Name | Base points per successful run |
| --- | --- | ---: |
| 1 | Compact | 12 |
| 2 | Sport | 28 |
| 3 | Supercar | 65 |
| 4 | Hypercar | 150 |

- Purchases are **Tier 1 only**: 2 Scrap + 1 action point.
- **Merge** two undamaged cars of the **same tier** (1 action point): both are
  consumed and one car of the next tier is created. Tier 4 is the maximum.
- Damaged cars cannot race or merge. Garage cars score nothing; only a car that
  races can earn points.

## Routes

| Route | DNF chance | Points | Success reward |
| --- | ---: | ---: | --- |
| Safe Circuit | 5% | 1.0× | +1 Scrap |
| Sprint Lane | 15% | 1.5× | +1 Fuel |
| Risk Route | 30% | 2.2× | +1 Tech |

A successful run scores **tier base points × route multiplier**. There is one
rounding rule for the whole game: `Math.round` of the product (e.g. a Compact
on the Risk Route scores `12 × 2.2 = 26.4 → 26`; a Supercar on Sprint scores
`65 × 1.5 = 97.5 → 98`).

A **DNF** scores nothing and pays no route reward; the car returns to the
garage **damaged**. A successful car also returns to the garage, undamaged and
with no route, ready for the next round.

Race outcomes are decided **server-side** from authoritative random values in
`[0, 1)` — one per racing car, player 1's grid then player 2's. The client never
generates a DNF.

## Planning actions

Each planning phase grants a fresh **2 action points**.

| Action | Cost | Notes |
| --- | --- | --- |
| Buy a Tier 1 car | 2 Scrap + 1 AP | Refused at the 8-car cap |
| Deploy a garage car | free | Car needs a route; max 4 racing |
| Return a deployed car to the garage | free | Refunds the deploy; max 4 racing |
| Change a deployed car's route | free | Before lock-in |
| Merge two same-tier cars | 1 AP | Next tier, both consumed |
| Repair a damaged car | 1 Scrap + 1 AP | Back to undamaged in the garage |
| Lock in | free | Plan is final |
| Workshop recovery | free | See below; consumes the phase |

Action points are **set** to 2 each round (not accumulated), and they never go
negative. All actions are validated by the engine: no acting after lock-in or
after the server deadline, no duplicate deployment, no fifth racing car, no
opponent-owned or nonexistent cars, no negative resources.

When both seats lock in (or the 60-second deadline passes) the round resolves.
A seat that never locked in races whatever it had deployed.

## Repair and workshop recovery (soft-lock guard)

A normal repair costs 1 Scrap + 1 action point.

A seat can still be stuck: **no Scrap and every owned car damaged**. To make
that recoverable without awarding unearned Scrap, Lane Rush has a free
**workshop recovery**:

- available only when the seat has **0 Scrap** and **every** car is damaged;
- costs no Scrap and no action points;
- **consumes the planning phase** — the seat is locked in immediately and can
  take no further actions that round;
- the car is not usable while in the workshop; recovery completes during race
  resolution, so the car returns to the garage **undamaged for the next round**.

A car in the workshop cannot race, merge, be repaired, or enter the workshop
again until recovery completes.

## Winning

Points are cumulative across rounds. The first seat to reach **1,000 points**
wins. If both seats cross the threshold in the same round, the higher total
wins; an exact tie is a draw. After the match ends, no further planning actions
are accepted.

## Persistence

The match row keeps its existing identity, match id and player1/player2 seats.
The race itself is a **versioned JSONB state** (`game_state`) with an explicit
`game_state_version`:

- `0` = legacy row (the untouched glass-bridge duel) — never read as a race;
- `1` = the racing game state described above.

`readState()` refuses legacy, corrupt and future-versioned states rather than
guessing, so an unfinished legacy match can never be interpreted as a Lane Rush
race. See migration `0223_lane_rush_race_state.sql`.

## Server lifecycle

Every new match is a **race match** (`game_state_version = 1`). The lifecycle
is explicit and server-owned:

| State | Meaning |
| --- | --- |
| `waiting` | Lobby open, waiting for the opponent |
| `ready` | Opponent joined; short "match found" banner |
| `active` (phase `planning`) | Both players plan against the 60s server deadline |
| `resolving` | Both plans locked (or the deadline passed); the race is being applied |
| `active` (next round) | Results are stored and the next planning phase opens immediately |
| `finished` | A seat reached 1,000 points, or a resignation settled the match |
| `cancelled` | Host cancelled a waiting lobby |

The **Results** moment is the persisted `results[]` entry: it is written before
the next planning phase opens and before any socket broadcast, and every
status read returns `lastResult` alongside the reopened planning phase.

### Deadline policy

The server clock is the only deadline authority. When the 60 seconds expire,
the round is finalized with **whatever each seat has deployed at that moment**.
Unsubmitted actions were never persisted, so nothing is invented; an unlocked
seat simply races the grid it had. The client countdown is display-only and any
late action is rejected with `deadline_expired`.

### Action API

`POST /api/lane-rush-duel/match/:id/act` accepts a validated plan:

```json
{
  "actionId": "client-unique-id",
  "round": 3,
  "stateVersion": 1,
  "actions": [
    { "type": "buy" },
    { "type": "deploy", "carId": "p1-c1", "route": "sprint" },
    { "type": "lockIn" }
  ]
}
```

The server validates the seat, `actionId` (duplicate-safe), round and state
version, deadline, lock-in and every engine rule inside one row-locked
transaction. It never reads a client score, DNF, roll, opponent plan or winner.
Typed failures carry a `code` (`stale_round`, `stale_state`, `deadline_expired`,
`locked`, `invalid_action`, …).

### Resolution and settlement

Resolution is two committed steps: a conditional `active → resolving` marker,
then a row-locked transaction that generates **server-side** random rolls,
applies the engine result exactly once, stores the complete result, and — when
the 1,000-point threshold is crossed — settles through the existing shared
settlement path (escrow, 80/20 payout, draw refunds, Elo, trophies,
leaderboards, practice exclusions). A crash between the steps leaves a
`resolving` row that the next status read resumes; a concurrent resolver sees
the consumed marker and does nothing.

**Tie-break:** if both seats cross 1,000 in the same resolution, the higher
cumulative score wins; an exact tie is a draw (both stakes refunded).

### Bots and practice

The practice bot submits an ordinary validated plan from
`src/lib/lane-rush/bot.ts` — it buys/merges/repairs as action points allow,
deploys up to four cars, chooses routes by difficulty, and locks in. It never
submits a tile pick, a roll or a result. Practice matches remain zero-stake and
never feed rating, trophies or leaderboards.

### Legacy compatibility

Unfinished glass-bridge rows keep `game_state_version = 0` and stay on the old
transitions, so they can finish on their original rules. New matches are always
stamped version 1 and dispatched to the racing store; a legacy row can never be
read as a race (`readState` refuses it).

The race match page renders such a row as an explicit "retired bridge board"
notice rather than racing controls, so no control ever acts on a bridge payload;
its stored result and history remain intact.

## Board (client)

The match page (`src/app/casino/lane-runner/[matchId]/PageClient.jsx`) renders a
top-down **oval circuit** built from pure SVG geometry:

- Three concentric **route lanes** (Safe outside, Sprint middle, Risk inside) on
  the same closed lap. A car's position is one normalized lap progress `t` in
  `[0, 1)`; `t = 0` is the start/finish line on the left and travel is clockwise.
  `src/components/lane-rush/ovalGeometry.js` owns that maths and is unit-tested.
- **Blue-glowing cars are Player 1, red-glowing cars Player 2**; each tier has
  its own top-down artwork, oriented along the lane tangent, and the sprite
  grows modestly with the tier. Deployed cars wait on their lane's grid; an
  opponent's deployed cars wait on the neutral rival ring because their route
  stays private until the round resolves.
- The only moving cars are `buildRacePlayback(lastResult)` — a projection of the
  round the **server already resolved**. A finished car crosses the line, a DNF
  stalls and is marked damaged in the garage. Scores count up to the confirmed
  value; the page never rolls, scores or decides a winner, and a reconnect
  seeds its playback baseline from the first payload so nothing is replayed.
- Controls are the authoritative actions (`deploy`, `recall`, `setRoute`, `buy`,
  `merge`, `repair`, `workshopRecovery`, `lockIn`) and are disabled with a
  reason whenever the phase or the payload forbids them.

## Code map

| File | Responsibility |
| --- | --- |
| `src/lib/lane-rush/rules.ts` | All configuration: starting resources, tiers, routes, costs, scoring, state types |
| `src/lib/lane-rush/engine.ts` | Pure engine: init, state validation, actions, plans, lock-in, race resolution, match result |
| `src/lib/lane-rush/bot.ts` | Minimal legal practice planner (same engine actions as a human) |
| `src/lib/lane-rush/raceStore.ts` | Authoritative lifecycle: planning actions, lock-ins, `resolving`, exactly-once resolution, bots, resignation, sanitized views |
| `src/components/lane-rush/ovalGeometry.js` | Pure oval geometry, grid parking queue + confirmed-round playback projection (unit-tested) |
| `src/components/lane-rush/OvalTrack.jsx` | The SVG board: route lanes, parked-grid queue, tier-scaled car sprites, finish/DNF animation |
| `src/components/lane-rush/RaceGarage.jsx` | Fleet panel: deploy/recall/routes/buy/merge/repair/workshop |
| `src/app/casino/lane-runner/[matchId]/PageClient.jsx` | Match page: HUD, planning, lock-in, result screen, waiting states |
| `src/lib/lane-rush-duel/serverStore.js` | Preserved legacy bridge engine + the ONE shared settlement path (`settleLaneRushMatch`) |
| `tests/lane-rush-engine.test.mjs` | Unit tests for every rule above |
| `tests/lane-rush-race-lifecycle.test.mjs` | Lock timing, deadline policy, stale/duplicate actions, exactly-once resolution, reconnect payload, bot, resignation, legacy dispatch (`npm run test:lane-rush`) |
