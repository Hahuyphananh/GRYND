# Crash Poker — Architecture & Schema Plan

This document describes how the existing **Crash Arena** multiplayer system is
refactored into **Crash Poker**. The lobby, table rooms, matchmaking, Clerk
auth, wallet/buy-in, realtime Socket.IO sync, disconnect grace timers and
stale-seat sweeps are all **preserved unchanged**. Only the *game concept*
inside a hand changes: instead of "everyone antes the wager and cashes out
before the crash", a hand now plays poker-style betting against the crash
curve.

## 1. Concept → rules mapping

| Crash Poker rule | Where it lives |
| --- | --- |
| Multiplayer table, existing Arena capacity (6 seats) | `crash_arena_tables.max_players` (unchanged) |
| Players use existing table balance / chips (no new currency) | `crash_arena_players.balance` (unchanged) |
| Small Blind + Big Blind posted each hand | `crash_arena_rounds.small_blind` / `big_blind` — `SB = round(wager/2)` by default, overridable per table via `crash_arena_tables.small_blind`, `BB = wager` |
| Configurable blind values | `SMALL_BLIND_RATIO` (0.5) + `MIN_SMALL_BLIND` (0.01) constants; resolved once at table creation and persisted on `crash_arena_tables.small_blind` |
| Never bet more than your stack; all-in naturally | the engine caps every call/raise at the server-authoritative table balance (`stack` passed by the route) and marks the player `allIn` instead of rejecting |
| Non-blind players post a minimum opening contribution (ante) | every non-blind player posts `SB` (ante); `BB` player posts `BB` total |
| First meaningful betting checkpoint at **1.25x** | `FIRST_BETTING_CHECKPOINT = 1.25` |
| Betting decisions every **+0.25x** (1.25, 1.50, 1.75, …) | `checkpointMultiplier(index) = 1.25 + 0.25·index` (pure, integer math) |
| At each checkpoint: **FOLD / CALL / RAISE** | `applyAction()` in the rules engine; new API route `POST /api/crash-arena/action`. EVERY active non-all-in player acts at each checkpoint (matching alone never closes betting — the BB gets a chance to raise too); a raise re-opens everyone else's decision |
| A raise increases the required contribution for everyone still in | `requiredBet` state; a raise re-opens action for every other active player |
| Folders lose only what they already contributed | contributions stay in the pot; nothing more is deducted |
| Pot = all contributions made during the hand | `pot = Σ entries.contributed + table.carry_over` |
| Crash can happen at any moment between checkpoints | the crash point is server-authoritative; checkpoints below it are the only valid ones (settle voids over-eager actions) |
| If 2+ players remain active at the crash, they all lose the hand | resolver: no winner → pot carries over to the next hand |
| Winner determined by fold-order / pot rules (not old cashout logic) | isolated `resolveHand()` in the engine, called by the shared `settleCrashPokerHand()` used by both the action route (fold-out) and the settle route (crash) |

### Settlement rules (reference — the "agreed Crash Poker fold-order/pot rules")

Settlement follows the **fold-order mechanic** — there are no side-pot
returns in any branch:

1. When a fold leaves exactly **one active player**, the hand ends immediately
   and that player **wins the WHOLE pot** (every folded contribution + the
   carry-over tier), minus the 5% platform fee. Folded players keep their
   losses — nothing is returned to them. This can happen before any crash.
2. If the crash happens while **2+ players are active**, every active player
   **loses** what they committed. The pot then goes to the **latest
   successful fold** before the crash — the fold at the highest checkpoint,
   tie-broken by the fold recorded last within that checkpoint (the hand's
   chronological action log).
3. If the crash happens while **2+ players are active AND nobody folded**, no
   one wins: the **whole pot carries over** to the next hand
   (`crash_arena_tables.carry_over`, server-authoritative — never
   client-side).
4. Folds recorded at a checkpoint **above** the crash point are void (that
   checkpoint never opened): the player is restored to active and busts with
   the rest — an over-eager/tampered client gains nothing.
5. A player who **crashed** (still active at the crash) can never win, and a
   winner never receives both a refund and the pot — the pot is awarded
   exactly once, atomically, inside the settlement transaction.

## 2. Database schema changes

No new tables — the existing Crash Arena tables are extended. Migrations:
`src/db/migrations/0098_crash_poker.sql` (hand state) and
`0099_crash_poker_allin_blinds.sql` (configurable blinds + all-in), raw SQL
applied manually like the 0090+ files (drizzle journal is not extended for
0055+).

### `crash_arena_tables`
| Column | Type | Notes |
| --- | --- | --- |
| `carry_over` | `numeric(14,2) NOT NULL DEFAULT '0.00'` | pot carried from a hand with no winner |
| `small_blind` | `numeric(10,2)` | per-table SB override; NULL = standard `round(wager/2)` |

### `crash_arena_rounds`
| Column | Type | Notes |
| --- | --- | --- |
| `small_blind` | `numeric(10,2)` | posted by the SB seat |
| `big_blind` | `numeric(10,2)` | = table wager; also the opening `required_bet` |
| `dealer_position` | `integer` | rotates each hand: `(round_number - 1) % seated_count` |
| `checkpoint_index` | `integer NOT NULL DEFAULT -1` | the currently open betting checkpoint (0 = 1.25x) |
| `required_bet` | `numeric(14,2) NOT NULL DEFAULT '0'` | total contribution needed to stay in the hand |
| `betting_open` | `boolean NOT NULL DEFAULT false` | whether the current checkpoint window is open |
| `hand_state` | `jsonb` | compact hand snapshot (roles, acted flags, action log) |

### `crash_arena_entries`
| Column | Type | Notes |
| --- | --- | --- |
| `contributed` | `numeric(14,2) NOT NULL DEFAULT '0'` | total committed this hand (blinds/ante + calls/raises) |
| `folded_at_multiplier` | `numeric(6,2)` | checkpoint multiplier where the player folded |
| `last_action` | `varchar(20)` | `ante` / `sb` / `bb` / `call` / `check` / `raise` / `fold` |
| `is_active` | `boolean NOT NULL DEFAULT true` | still in the hand |
| `all_in` | `boolean NOT NULL DEFAULT false` | committed the whole remaining stack — can no longer act, counts as matched |

`crash_arena_transaction_type` (existing enum) gains `RETURN` — ledger rows
for side-pot refunds (migration `0100_crash_poker_side_pot_return.sql`).

`crash_arena_entries.result` (existing `varchar(20)`) gains the value
`folded` alongside `pending` / `won` / `lost`. The legacy
`cashout_multiplier` / `cashout_timestamp` columns stay for compatibility but
are **unused** by Crash Poker hands.

## 3. Module layout

```
src/lib/crash-poker/
  constants.js        FIRST_BETTING_CHECKPOINT, CHECKPOINT_STEP, SB ratio,
                      min-raise rule, checkpointMultiplier(index), rounding
  roundSystem.js      PURE hand engine (no DB):
                        computeBlinds / computeOpeningContributions
                        createHand / openNextCheckpoint
                        applyAction (fold|call|raise, stack-capped all-in)
                        computePots (main pot + side pots, tier accounting)
                        resolveHand (winner determination — the clean hook)
                        → returns { winner, payoutGross, returns, pots }
  types.ts            TS view of the hand object for the API routes/settle
  botStrategy.js      per-difficulty betting decisions for AI practice tables
  settleHand.ts       shared DB settlement used by /action (fold-out) and
                      /settle (crash): marks entries, credits winner, writes
                      WIN/RAKE transactions, updates carry_over, broadcasts
```

Everything money-touching stays in the existing API routes; the engine is a
pure, unit-testable rules module. `resolveHand()` is the single place that
decides the winner, so a future rules change (e.g. split pots, all-in, rake
structure) only touches that function.

## 4. Server-authoritative flow

1. **Start hand** (`POST /api/crash-arena/start-round`) — unchanged lobby
   gate (2+ players, ready votes, 12s countdown). New: computes blinds/ante
   from the table wager + the table's `small_blind` override, assigns
   dealer/SB/BB, deducts each player's opening contribution from their table
   balance — capped at the stack so a short stack posts everything and is
   all-in, while a player with no stack is left out of the hand — creates the
   round + entries (with `contributed`, `is_active`, `all_in`), sets
   `checkpoint_index = 0`, `betting_open = true`, `required_bet = big_blind`,
   and stores `hand_state`. All deductions + inserts commit in one
   `db.transaction`.
2. **Betting** (`POST /api/crash-arena/action`, new) — body
   `{ roundId, checkpointIndex, action, raiseTo?, forBot? }`. The server
   validates the caller's entry is active, the checkpoint matches (either the
   open one, or the next one once the open one is fully resolved), the action
   is legal (raise must be ≥ `required_bet + big_blind`, cannot double-act
   without an intervening raise), applies it via the engine **with the seat's
   DB balance as the authoritative stack**, persists to
   `crash_arena_entries` + the round, and broadcasts. The engine never trusts
   client-supplied balances: a call/raise is capped at the stack and the
   player is marked `all_in` instead of rejected; a below-min raise is only
   legal as an all-in shove. Entry update + balance deduction + hand window
   are written inside one `db.transaction`. When the action resolves the hand
   (fold leaves one player) it settles immediately through
   `settleCrashPokerHand`.
3. **Crash (server-driven, point hidden until it happens)** — the crash
   point is generated at hand start (`generateRoundSeed` →
   `generateCrashPoint`) and kept **server-only**: neither `start-round`'s
   response, the round-start broadcast, nor the tables poll ever carry it
   while the hand is running. The curve is deterministic
   (`multiplier = e^(GROWTH_RATE·t)` with `GROWTH_RATE = 0.33` shared between
   `CrashGraph.jsx` and `crashDueAtMs()`), so the exact crash moment is a
   server-side constant: `crashAt = roundCreatedAt + ln(crashPoint)/GROWTH_RATE`.
   The realtime server's `/api/crash-arena/crash-check` sweep (1s tick)
   settles every running hand whose `crashAt` has passed via
   `settleCrashPokerHand` → `resolveHand`, then broadcasts the crash
   (multiplier + authoritative results) to the table room. Clients animate
   the explosion from that broadcast — the crash can land at ANY multiplier,
   including between checkpoints (checkpoints are decision moments, not
   safe points). The seed + crash point are revealed only after the hand
   settles (provably-fair verification). The client's `CrashEngine` runs in
   "blind" mode: no crash point, `startedAt` aligns the curve to server time.
4. **Crash/action ordering (deterministic, latency-proof)** — both the
   action route and the settle route use the same `crashDueAtMs` server
   constant. An action arriving after `crashAt` is rejected and the hand is
   settled instead (an action that reached the server before the crash
   counts; one that didn't is refused) — ordering is by server time, never
   network latency. The row-locked settle also rejects early settlement of a
   still-running hand. If the crash lands between 1.25x and 1.50x, active
   players lose immediately — no further betting is accepted.
5. **Advance** — the server opens the next checkpoint lazily: the first
   action submitted for `checkpointIndex + 1` re-opens betting. Clients only
   offer the betting UI once their (deterministic, shared) curve crosses the
   checkpoint multiplier. Settle voids any action recorded at a checkpoint
   above the crash point (over-eager / tampered clients).
6. **Stall guard (auto-resolve deadlines)** — every open checkpoint window
   has a `windowDeadlineAt` (`CHECKPOINT_ACTION_DEADLINE_MS = 10s`, refreshed
   on raise re-opens). Because every active player must act per checkpoint,
   `expireStaleActions()` auto-resolves silent players at the deadline:
   matched-but-silent players are **auto-checked** (implicit check — their
   chips are already committed, folding them would be a theft) and
   unmatched-and-silent players are **auto-folded** (their call is
   unreturned, leaving them in would freeze betting). All-in players are
   committed and never touched; a sole survivor is never auto-folded (the
   fold-out is already decided). Enforced lazily in the action route (before
   the checkpoint gate — the acting player is excluded from the pass), at
   settle, and proactively by the realtime server's periodic
   `/api/crash-arena/auto-fold` sweep — so one staller can't freeze betting
   for the table. The client shows a countdown and submits the player's
   default action at 0 (fold when a call is owed, otherwise check); the
   server remains authoritative.
7. **Carry-over** — `crash_arena_tables.carry_over` feeds the next hand's pot
   and is either paid out to a fold-out winner or carried again on a crash
   with 2+ active players.

**CRASH RISK meter** — a purely visual gauge (`CrashRiskMeter.jsx`) next to
the pot while the hand runs: `risk = 1 − e^(−(m−1)/1.9)` clamped to
[4%, 97%], a strict function of the public multiplier (higher curve =
more dangerous). It is synchronized by construction (every client renders
the same shared curve), is NOT the source of randomness, and reveals
nothing about the hidden crash point — it can't predict the crash, only
that the hand is getting more dangerous.

## 5. Client changes (foundational state, not final UI polish)

- `src/lib/crash-arena/roundSystem.js` (client mirror) — same phases
  (`waiting → running → crashed → settling`), but `startRound` applies
  per-player contributions from the server hand payload and
  `playerCashout` is replaced by `applyPlayerAction` (fold/call/raise).
- `useCrashArenaRound` — submits actions through `/api/crash-arena/action`,
  applies server hand snapshots on poll/socket sync, resolves remote actions,
  and drives the AI bot's per-checkpoint decisions on practice tables.
- `ArenaTable` — the Cashout button area becomes a Fold / Call (Check) /
  Raise betting panel shown while a checkpoint window is open and the player
  is active; a "folded" badge joins the existing busted/cashed-out badges.
- The lobby, join/buy-in, rules popup (content to be reworded in a later
  pass), result modal, and all socket wiring keep their current look.

## 6. Compatibility & safety

- `cashout` / `ai-cashout` routes are kept but reject Crash Poker hands
  (`hand_state` present) so a legacy client can never corrupt a running hand.
- `releaseCrashArenaSeat` already treats `pending → lost` and `won → deferred`
  correctly; `folded` falls through to a clean refund of remaining balance.
- AI practice tables run the same engine; the bot bets via the seated human's
  session (`forBot: true`, only on `is_ai` tables), mirroring `ai-cashout`.

## 7. Known follow-ups (explicitly out of scope for the foundation)

- Per-checkpoint action timers: DONE — 10s auto-resolve deadline per
  window (`expireStaleActions` auto-checks matched silents and auto-folds
  unmatched silents + `/api/crash-arena/auto-fold` sweep + client
  countdown), enforced lazily by the action/settle routes and proactively
  by the realtime server.
- Checkpoint resolution model: DONE — a checkpoint only closes once EVERY
  active non-all-in player has acted (matching alone never closes it, so a
  late raiser always gets their chance); a raise re-opens everyone else's
  decision.
- Fold-order winner mechanic: DONE — the latest successful fold before the
  crash wins the whole pot when active players crash; nobody folded → pot
  carries over; fold-out → sole survivor wins the whole pot. `resolveHand()`
  is the single hook where the rule lives.
- Disconnect safety: DONE — a player released mid-hand (disconnect cleanup
  marks their entry "lost") is excluded from the hand at settlement, so a
  released player can never be crowned the winner and paid twice (refunded
  seat balance + pot credit).
- Side-pot tier display: the PotDisplay tier breakdown (`computePots`) is
  kept for the running-hand view, but settlement no longer returns any
  side-pot money — the whole pot goes to the fold-order winner.
- Split-pot / tie handling (not applicable — Crash Poker has no showdown,
  so the latest-fold tie-break always yields a sole winner).
- Rules modal + result modal copy fully rewritten for betting language.
- Persisted per-hand action history for replay/audit (currently in
  `hand_state.actions`).
