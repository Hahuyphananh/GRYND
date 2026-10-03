# Load & Performance Testing Plan (Grynd)

Goal: prove the database-backed hot paths — **wallets, wagering, settlement,
game history, chat, leaderboards** — stay fast and correct under realistic
concurrency, and find where they break before users do.

This plan is grounded in a codebase survey (models, queries, indexes) done in
Sept 2026. It does **not** require touching production. Everything runs against
a **staging environment** with a production-like dataset.

---

## 1. Architecture snapshot (what load actually hits)

- **Postgres (Neon/Vercel serverless) + Drizzle** — 95 tables in
  `src/db/schema.ts`. Wallets and every persisted game row live here.
- **Upstash Redis** — live game state, match-lifecycle outbox, and *response
  caching* for the read-heavy feeds (leaderboards 5 min TTL, per-user stats
  3 min, recent-games 60 s), with event-driven invalidation
  (`src/lib/redis/invalidation.ts`).
- **Next.js API routes** (`src/app/api/**`) — all wagering/settlement HTTP
  endpoints; server-authoritative, auth via Clerk (`auth()`).
- **Standalone Socket.IO service** (`realtime-server/`) — relays game events;
  has an existing connection flood test (`realtime-server/loadtest.js`).

Load-test surfaces:
1. **HTTP API routes** (this plan's focus) — wagering, settlement, reads.
2. **Socket relay** — already covered by `realtime-server/loadtest.js`
   (connection count, `room_event` rate). Run it alongside HTTP tests for
   full-table games; it is not repeated here.

---

## 2. Key hot-path models & operations

"Model objects" = the rows that every real action touches. Ranked by risk:

| Model (table) | Role | Operations per action | Contention / growth risk |
|---|---|---|---|
| `users` | Wallet + stats on ONE wide row | Wager: conditional atomic `UPDATE balance = balance − x WHERE clerk_id = ? AND balance >= x … RETURNING` (per game serverStore, e.g. `src/lib/tower-arena/serverStore.ts:376`). Settlement: `balance + payout` again. **Every settled bet additionally runs `applyLeaderboardCounters` (`src/lib/leaderboardCounters.js`)**: one big CTE updating `total_wagered`, `weekly_*`, streaks, XP/level on the same `users` row + upserting `user_stats`. Battle-pass grants may update the row again. | **High.** Same row updated ≥2× per wager. Same-user concurrent sessions serialize on the row lock. |
| `user_stats` | Per-user aggregated counters | Upsert on every settlement (see above) | **High.** PK only; upsert from the CTE; no rankable indexes (see §4). |
| PvP match tables (`*_matches`, `*_rounds`) | Round/match state | Join = player row + match row; a round settles with the counter/stat updates (`applyLeaderboardCounters`) | **High burst.** Players settle within seconds of each other (round-end spike). Tables are indexed well (status/created, per-user); risk is write volume, not lookups. |
| `chat_messages` | Global chat | Insert per message; read-back by `(roomType, roomId, createdAt)` | **Medium.** Well indexed (`chat_messages_room_idx`); grows fastest of any table. Soak test watches index bloat. |
| Leaderboards (reads) | `users`/`user_stats` + per-game tables | `fetchRankedRows` / `fetchGameLeaderboard` (`src/lib/leaderboardQueries.js`) — full-table window/aggregate when cache misses | **Medium-high on cache miss.** Cached 5 min with debounced (60 s) purge on settlement → under heavy settle load the full-table sorts recompute up to once/minute. |
| `token_transactions` | Money-movement audit | Insert on purchase/spend/refund | Low; append-only, indexed `(clerk_id, created_at)`. |
| Solo game tables (`mines_games`, `keno_games`, `uno_games`, `lane_runner_games`, `rps_games`, `chess_games`) | Historical game rows | Insert on play; read in `GET /api/get-bet-history` | **Medium.** Per-user reads are unindexed seq scans (see §4) and grow forever. |

**The two money-movement invariants to protect under load:**
1. Balance changes are atomic conditional `UPDATE … RETURNING` — never
   client-computed. Load tests must verify no balance corruption/overdraw at
   the end (see §6, integrity checks).
2. Same-user concurrency is the sharpest edge — two simultaneous sessions of
   one account contend on the `users` row lock.

---

## 3. Endpoint inventory for the load mix (verified contracts)

Auth: every route below uses Clerk; send the session cookie header
`Cookie: __session=<token>`.

| Operation | Endpoint | Method/Body | DB work |
|---|---|---|---|
| History | `/api/get-bet-history` | GET | **16 fan-out queries** across game tables |
| Leaderboard | `/api/leaderboard/all-time` etc. | GET `?category=&limit=&offset=` | Redis-cached; recompute on miss |
| Per-game board | `/api/leaderboard/game?game=` | GET | cache; miss = full scan+group of that game table |
| My stats | `/api/user-stats` | GET | cached 3 min |

Other games follow the same shape (each PvP game has `create-or-join` /
`join` / turn-action / settle routes, e.g. `mines-pvp`, `keno-pvp`,
`tower-arena`). Add their routes to the Artillery scenarios as
they stabilize; the pattern to replicate is **join/wager → actions → settle**.

---

## 4. Query performance pass — findings (static review)

Run `EXPLAIN (ANALYZE, BUFFERS)` on each below against a staging copy at
production-ish row counts before trusting the mitigations.

### 4.1 Risky queries

1. **`GET /api/get-bet-history` — 16 parallel per-table queries**
   (`src/app/api/get-bet-history/route.ts`). Every request fires one query per
   game table (`… WHERE user_id = ? [AND created_at >= ?] LIMIT 200`).
   **Index-gap caveat (verified live):** the migration chain never recorded a
   `(user_id, created_at)` index on the legacy solo tables, but the live DB
   carried ad-hoc ones created directly on Neon and carried into Supabase via
   the schema dump (`idx_*_user_id` on each, plus `*_user_created_idx
   (user_id, created_at DESC)` on most — `uno_games` lacked the composite). So
   **production was already indexed**; migration 0139 ships the canonical
   `*_user_idx` so fresh environments built purely from the chain match, and
   per-user history is index-backed everywhere. On prod, 0139 duplicated the
   existing composites on 7 tables (see cleanup note in §4.2).
2. **Per-game leaderboard recompute** (`fetchGameLeaderboard` in
   `src/lib/leaderboardQueries.js`): `COUNT(*) FILTER … FROM <game_table> …
   GROUP BY clerk_id` — a **full scan + hash aggregate of the entire game
   table** (e.g. every `mines_games` row) on every cache miss. Cache is purged
   by settlements (debounced ≤60 s) → recompute cost grows linearly with
   table size and spikes under settle load.
3. **All-time/weekly leaderboard recompute** (`fetchRankedRows`):
   `ROW_NUMBER() OVER (ORDER BY <expression> DESC)` over the **whole**
   `user_stats × users` join, sorted by computed expressions (`COALESCE`,
   win-rate math). Even with indexes these expressions defeat them; a cache
   miss = full scan + sort of every player.
4. **`applyLeaderboardCounters` CTE** (`src/lib/leaderboardCounters.js`) is
   *intentionally* one statement (good), but it takes a `users` row lock and
   an `user_stats` upsert lock on **every settled wager** — it is the write
   hotspot, not a slow query per se. Watch lock waits under settlement load.
5. Chat reads are fine (`chat_messages_room_idx` covers
   `(room_type, room_id, created_at)`). `users` lookup by `clerk_id` uses the
   unique index.

### 4.2 Missing / suggested indexes

Verified against index declarations in `src/db/schema.ts`:

| Table | Gap | Suggested index |
|---|---|---|
| `mines_games`, `keno_games`, `uno_games`, `rps_games`, `chess_games` | Migration chain had **no `(user_id, created_at)` index** (only `lane_runner_games` had one, from `0014`). Live prod carries ad-hoc equivalents (`idx_*_user_id`; `*_user_created_idx` composite on most — `uno_games` composite was genuinely missing). **Fixed by migration 0139** (`*_user_idx (user_id, created_at DESC)`, now also declared in `schema.ts`). **Prod cleanup:** 0139 duplicated existing composites — drop the ad-hoc `*_user_created_idx` + single-column `idx_*_user_id` so each table keeps exactly one canonical index | Keep exactly one composite per table |
| `user_stats` | Only PK on `user_id` | For the most-viewed boards, targeted partial indexes help some categories (e.g. `(wins DESC)` where losses tracked); for the rest prefer §4.3 snapshot |
| Per-game boards | full-scan aggregate | Prefer a **materialized snapshot** (§4.3) over indexes — you cannot index a `GROUP BY clerk_id` over a growing fact table cheaply |
| `users.search_name` | none | Confirm the search-player query uses it; if it ILIKEs `name`, note that an index only helps with `pg_trgm` |

### 4.3 Recommended structural fix (do before scale)

**Replace leaderboard-on-demand with a snapshot table** (e.g. refresh every
30–60 s via a cron/`pg_cron` or the existing lifecycle worker): copy of the
ranked rows (all-time + weekly + per-game) → page reads become tiny indexed
SELECTs, cache stampedes disappear, and per-game boards stop scanning the fact
tables. This removes the *worst* read-side scaling problem without index
gymnastics. Keep the existing Redis cache in front of the snapshot.

---

## 5. Scenarios, budgets, pass criteria

Targets below are **starting budgets** — adjust to your SLO once you have a
baseline. All latencies are measured at the client (Artillery) and are p95
server-time budgets for a single request *excluding* think time.

| # | Scenario | What it proves | Shape (see `load-test/scenarios/*.yml`) | Pass criteria |
|---|---|---|---|---|
| S1 | Ramp — create/join path | Throughput ceiling of **PvP match create/join** under rising concurrency | drive the `create-or-join` routes (e.g. `mines-pvp`, `keno-pvp`): 0→80 VUs over 3 min | p95 ≤ 600 ms; error rate ≤ 1%; zero `400` beyond expected validation |
| S2 | Sustained — read mix | Feeds under steady user load, incl. cache-hit leaderboards/history | `read-mix.yml`: 40 VUs, 5 min | p95 ≤ 800 ms reads; cache-hit ratio high (watch `grynd:lb:*` Redis misses) |
| S3 | **Settlement burst** | Round-end spike: N players settle concurrently | Drive real PvP rounds (socket + HTTP driver, see §7), or hit a game's settle route on staging rounds | p95 settle ≤ 1 s at 5× normal round-end rate; **no deadlocks/lock timeouts in logs** |
| S4 | Same-user contention | Two concurrent sessions on one account (double-tap action) | 20 accounts × 2 concurrent sessions playing | Final stat rows consistent; both settlements recorded exactly once |
| S5 | Cache stampede | Leaderboard recompute right after a purge | `read-mix.yml` with settlements firing (trigger purge) | p95 on boards ≤ 2 s (recompute cost bounded — validates §4.3 need) |
| S6 | Soak | 30+ min at 2× expected peak | extended read-mix + wagers | No monotonic latency drift; connection pool not exhausted; no index bloat surprises |

Always capture: per-request latency percentiles, error rate & HTTP codes,
requests/sec, and **DB-side**: `pg_stat_activity` (max concurrent queries,
longest query), lock waits (`pg_locks`/`pg_stat_database`), connection-pool
queue time, Redis cache hit/miss (leaderboard keys).

---

## 6. Money-integrity checks (run after every scenario)

Because wagers move real balances, every load run ends with an audit:

```sql
-- 1. No negative balances
SELECT count(*) FROM users WHERE balance < 0;
-- 2. Invariant: balance column equals signed ledger
SELECT u.clerk_id
FROM users u
JOIN (
  SELECT clerk_id, sum(amount) AS ledger
  FROM token_transactions GROUP BY clerk_id
) t ON t.clerk_id = u.clerk_id
WHERE abs(u.balance - 1000000 - t.ledger) > 0.01; -- adjust starting balance
-- 3. Settlements applied exactly once per match (no double counting). Run per
--    game against its own match table (e.g. mines_pvp_matches, keno_pvp_matches,
--    memory_grid_matches, lane_rush_duel_matches): each settled match must have
--    exactly one settled row and its counters applied once.
SELECT id, count(*) FROM mines_pvp_matches
WHERE status = 'finished' GROUP BY id HAVING count(*) > 1;
```

Run these **before** the test (baseline) and **after**; diff the totals. A load
test that corrupts a balance is a failing test even at 0 ms latency.

---

## 7. Harness & prerequisites

Artillery v2 (repo devDependency) drives the HTTP scenarios in
`load-test/` — runbook: `load-test/README.md`.

Required staging setup before the first run:
1. **Dataset at production-like scale** (row counts within ~10× of prod for
   the tables in §2; leaderboard + history behavior is meaningless on an empty
   DB).
2. **≥ peak-VU real users** (Clerk accounts) each with a funded balance.
   Provide their session tokens as one-per-line CSV (`load-test/tokens.csv`,
   copied from `tokens.example.csv`). Tokens are short-lived — mint fresh ones
   per run. `__session` cookie value works.
3. **`BASE_URL`** pointing at staging (never production).
4. **Refill strategy**: bets spend balances, so either fund accounts with a
   large starting balance for short runs, or interleave a refill job for
   longer ones. Keep the total minted-vs-spent ledger so §6 checks stay
   meaningful.
5. Socket relay reachable for the round-driving tests (S3/S5), and
   `realtime-server/loadtest.js` run in parallel to add connection pressure.

### Extending to round/settlement-driven scenarios (S3, S5)

The HTTP-only driver cannot know when a live PvP round settles (the turn order
and round outcome are server-authoritative, surfaced via socket broadcast). The
realistic driver for S3/S5 is a k6/Node script that opens a socket per VU
(pattern already in `realtime-server/loadtest.js`), joins a seeded match, and
plays its turns as the broadcasts arrive — several such VUs per match to create
the N-player settle burst.

Add these as `load-test/scenarios/settlement.yml` once staging has reliably
cycling PvP matches.

---

## 8. Budgets & ownership

- Define the p95/error budgets above as code in the scenario files
  (`config.ensure`) so CI can fail a run automatically.
- Start with **S1 + S2** (cheap, high signal). Fix §4.2/§4.3 findings, then
  run S3–S6 before big game-launch events.
- Re-run whenever: a new game is added (new table + new fan-out in
  get-bet-history), an index migration lands, or the weekly-reset logic
  changes (it is a full-table write path).
