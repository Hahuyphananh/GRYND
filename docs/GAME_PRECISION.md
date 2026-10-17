# Precision — Game Guide

Precision is a **reflex-stop duel**: each round a hidden timer runs toward a random target time, and both players race to stop it as close to the target as possible. Best of 5 rounds — first to 3 wins takes the pot.

## How a round works

1. **Arming** — a round begins with a brief arming phase; the server rolls a **fresh hidden target** between **2.5 s and 10 s** for that round (millisecond precision, e.g. 3821 ms). The target is stored server-only and revealed only when the round goes active — both clients see the same revealed value at the same time.
2. **Active — STOP!** — a countdown/timer runs. Both players hit **Stop** when they judge the target time has been reached.
3. **Resolution** — whoever stops closest to the target time wins the round (+1 round win). Round scores are server-authoritative.

### One flight per stop

Each rocket stops when **its own seat** stops, and only then: a lane whose seat has not stopped keeps flying on the board's shared clock, so a round where you stop early stays visibly open until the opponent's stop lands too. The bot's stop is applied **on its own server instant** — a human's click never brings it forward (the bot is graded from that stored instant either way, so only the moment the players are told would change) — and the round is graded when the **last** stop is in.

### The round-result card

Between rounds the overlay is a one-glance verdict rather than a results table: **green** when your seat took the round, **red** when the opponent did, **amber** on a tie (the round then replays with a fresh target). It deliberately carries no per-seat times, deltas or rank badges — those are unreadable in the few seconds it is up, and the board behind it parks both rockets at their server-stamped stops for exactly that. The times that decide the round stay on `state.lastRoundStops`.

## Match format

- **Best of 5** — the first player to win **3 rounds** ends the match and takes the pot (max 5 rounds).
- Round targets are independent every round (random 2.5–10 s), so there's no memorising a fixed length.

## Payout

- **Winner** — takes the pot (stake back + winnings; standard 80/20 rake on the loser's stake (10% of the pot)).
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
| Arming countdown | 5 s (server-stamped) |
| Round-result card | green win / red loss / amber tie — the verdict only, no figures |
| Round-result popup | appears with the decision, ends when the countdown starts (3 s window), so the whole 5 s countdown is read after it |

## Server architecture

Precision's lobby queue and match state live in **Postgres** — the same
approach as Pool Masters and Tower Arena:

| Table | Holds |
| --- | --- |
| `precision_lobbies` | the PvP queue. The lobby id **becomes** the match id once two players are paired, so both clients land on `/casino/precision/game/<id>`. |
| `precision_matches` | one row per match: the public state snapshot as jsonb, the house reporting columns (`player1_id`, `player2_id`, `winner_id`, `wager`, `status`, `created_at`, `ended_at`) and the server-only columns (`server_target_ms`, `ai_stop_at`, `pending_stops`, `anomaly_ledger`). |

**There are no timers.** The arming countdown and the AI's stop are stored
*instants* (`countdownEndsAt`, `ai_stop_at`), and the next read performs
the transition they would have performed (`readMatch`). That is what keeps
a round from being stranded at 0 when a serverless instance is recycled,
and it is why any client's poll can open the round for both players.

Pairing and scoring run inside `SELECT … FOR UPDATE` transactions, so:

* two players clicking **Join** at the same instant cannot land in the
  same seat (the claim carries `status = 'waiting'`);
* a round is decided exactly once, when both seats have stopped;
* the payout idempotency guard (`payout_processed_at`) holds across
  instances, not just inside one process.

Housekeeping is opportunistic and throttled (`sweepPrecisionGames`):
waiting lobbies past their TTL, finished matches past the replay window,
and **unfinished matches nobody has touched** are deleted, so quitting
mid-match can't leave a dead game behind for the next player.