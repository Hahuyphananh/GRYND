# LAST RUN — engine, contracts and local testing

LAST RUN is GRYND's 1v1 endless-runner duel. Two players run the **same seeded
course**; the first crash loses, and two crashes on the same authoritative tick
are a draw.

Nothing in this feature touches an existing game, the Socket.IO server, the PWA,
the database schema, or any paid service.

---

## 1. Physics and course constants

Source of truth: `src/lib/last-run/constants.ts`. Every number below is a
module constant; the engine, the server replay and the renderer all read it.

| Constant | Value | Meaning |
|---|---|---|
| `TICK_HZ` / `DT` | 60 / 1/60 s | Fixed simulation step. Never variable. |
| `GRAVITY` | 3400 px/s² | Downward acceleration. |
| `JUMP_VELOCITY` | 980 px/s | Takeoff speed. |
| `JUMP_AIRTIME_S` | 0.576 s (derived) | `2v/g`. |
| `JUMP_APEX_PX` | 141 px (derived) | `v²/2g`. |
| `RUNNER_WIDTH` | 26 px | Body width, standing or ducking. |
| `RUNNER_STANDING_HEIGHT` | 44 px | Hits a 42 px-high beam. |
| `RUNNER_DUCK_HEIGHT` | 26 px | Clears the beam by 16 px. |
| `START_SPEED` | 260 px/s | Speed at tick 0. |
| `SPEED_RAMP` | 12 px/s² | Linear acceleration. |
| `MAX_SPEED` | 640 px/s | Reached at 31.7 s. |
| `COURSE_DURATION_S` | 75 s | Course length; also the hard match cap. |
| `FIRST_OBSTACLE_AT_S` | 1.35 s | Clear opening. |
| `GAP_START_S` → `GAP_FLOOR_S` | 1.95 s → 1.12 s | Obstacle gap, tightening over 44 s. |
| `MIN_OBSTACLE_GAP_S` | 0.92 s | Absolute fairness floor. |
| `MAX_KIND_RUN` | 2 | The same shape never repeats 3× in a row. |

Obstacle shapes (readable, SVG-drawn, no assets):

| Kind | Box | Answer |
|---|---|---|
| `crate` | 34×34 on the ground | Jump |
| `spike` | 30×20 on the ground | Jump (ducking is not enough) |
| `beam` | 56×46, underside at 42 px | Duck |

Controls: **Space / Arrow Up** jump, **Arrow Down** duck. Jump is
edge-triggered (holding the key does not bunny-hop) and cannot start from a
duck. Both are also on-screen buttons on touch devices.

---

## 2. Authority model

```
browser                         Next.js server                    engine
───────                         ────────────────                  ──────
POST /api/last-run/queue   ───► pairing + seed + startsAt
GET  /api/last-run/match/x ◄─── snapshot ◄────────────────────── replay(seed, inputs, now)
POST /api/last-run/match/x/input  { jump, duck } ──► stamp tick ─► replay
```

- **The client sends two booleans on transition.** Never a position, distance,
  collision, survival time or winner.
- **The server stamps the tick** as `received-at tick + INPUT_LEAD_TICKS (4)`.
  It only ever simulates ticks that no input can still land in, so the replay is
  forward-only and a client cannot backdate a jump.
- **`getSnapshot` advances the simulation**, then returns the compact state. A
  poll therefore never changes game logic; it only observes it.
- **Completion is finalised exactly once** in `finalize()`; every path (crash,
  distance at the end, abandon, leave) funnels through it, and a retry returns
  the stored result.
- **No joinable Socket.IO room exists.** Membership is checked on every read, so
  a match id alone yields `403`. That is stronger than a room-name convention.

### Endpoints

| Method + path | Body | Result |
|---|---|---|
| `GET /api/last-run/queue` | — | `{ status: idle \| queued \| matched, matchId?, waiting }` |
| `POST /api/last-run/queue` | `{ name? }` | join / pair (idempotent) |
| `DELETE /api/last-run/queue` | — | leave (idempotent) |
| `GET /api/last-run/match/:id` | — | authoritative snapshot; `403` for non-members |
| `POST /api/last-run/match/:id/input` | `{ jump: boolean, duck: boolean }` | accepted tick, `400` malformed, `403` non-member, `409` wrong phase, `429` rate limit |
| `POST /api/last-run/match/:id/forfeit` | — | the single final result (idempotent) |

Every endpoint requires a Clerk session; the user id comes from the session,
never the body.

---

## 3. Disconnect / reconnect / abandonment

- A live match advances on **server time**, not on client ticks. A client that
  disappears stops sending inputs; its runner keeps running until it crashes.
- A seat silent for `DISCONNECT_GRACE_MS` (10 s) forfeits — the same policy as
  the platform's existing disconnect-forfeit timers, applied inside the match
  registry. A deliberate leave uses the same finaliser with `reason: "left"`.
- Reconnecting is simply polling the snapshot again: the match id is stable, the
  sim is server-side, and the client re-renders the authoritative frame.
- **Do not award a win on a transient blip silently**: the 10 s grace exists for
  exactly that, and the result carries `reason: "abandon"` so the UI says so.
- The registry is in-process. A server restart ends in-flight matches (the
  players see "match not found"). This is the cost of shipping without a new
  table; moving it into Postgres is the documented follow-up.

---

## 4. Local two-client testing

1. `npm run dev`, sign in in **two different browser profiles** (or a normal and
   a private window) on `http://localhost:3000/games/last-run`.
2. Click **Find a match** in both. The second click pairs them; the first
   window flips to "Opponent found" and both navigate to the match.
3. Both see the same seed and the same countdown. `Space`/`↑` jumps, `↓` ducks,
   and the touch buttons appear under the arena on a phone.
4. Crash one runner: the arena freezes and the result panel shows win/loss, the
   survival time and the distance for both seats.
5. Test cancellation: join, press **Cancel search**, confirm the queue status
   returns to idle and no match is created.
6. Test abandonment: start a match, close one tab, wait ~10 s — the remaining
   player's snapshot resolves as `reason: "abandon"`.
7. Restart test: `POST /api/last-run/match/:id/forfeit` twice with curl and
   confirm the JSON result is identical both times.

No database rows, no fixtures and no test accounts are needed: the registry is
created on first use and lives in the Next.js process.

---

## 5. Known limitations (deliberate, for this pass)

- **Settlement is fire-and-forget on the snapshot path.** The result screen
  shows the server's final state immediately and then asks
  `/api/last-run/match/:id/result` for the persisted row; it never blocks on a
  database write.
- **Live state is per process.** A restart drops in-flight matches (players see
  "match not found"), and an interrupted match is closed as `failed` by
  `/api/jobs/last-run-sweep` — never recorded as a result.
- **In-process state.** One Next.js instance owns the match. Fine for the
  single-host deployment this repo uses; not for serverless multi-instance.
- **No Socket.IO push yet.** The match page polls the authoritative snapshot at
  4 Hz. The existing `lobby:updated` relay can be added later without changing
  the engine or the payload.
- **Not in the public catalogue.** `/games/last-run` is `noindex` and is not in
  `GAME_CATALOG`/`GAME_LANDING_PAGES`, so the lobby and hub are untouched until
  the launch copy exists.
- **Registered as a playable route.** Because it has no landing-page entry, the
  route is listed in `GAME_ROUTE_PATTERNS` (src/proxy.ts). Without that entry the
  middleware's unknown-slug guard treats `/games/last-run` as a missing page and
  rewrites it to the not-found sentinel — the game 500s. Any future game that
  ships before its landing page needs the same entry.

---

## 6. Test commands

```bash
# Pure engine: physics, collisions, determinism, fairness, replay
node --import tsx --test tests/last-run-engine.test.mjs

# Registry: pairing, identical seeds, invalid input, forfeits, abandonment
node --import tsx --test tests/last-run-realtime.test.mjs

# Types + the repository's only lint gate
npm run typecheck
npm run lint:release

# Progression: completion projection + deterministic event id
node --import tsx --test tests/last-run-progression.test.mjs

# Settlement: completion → plan, draw handling, migration/schema/RLS invariants
node --import tsx --test tests/last-run-settlement.test.mjs
```

---

## 7. Progression (what a completed match records)

LAST RUN reuses GRYND's canonical match record — it does **not** add a table,
a column or a migration:

| Write | Where | When | Idempotency |
|---|---|---|---|
| `queued → forming → ready` | `match_lifecycle` | pairing | unique `match_id`; retry is ignored |
| `ready → started` | `match_lifecycle` | first `racing` snapshot | state machine rejects a second edge |
| `started → completed` + one event | `match_lifecycle`, `match_lifecycle_events` | settlement (first snapshot/forfeit/result read carrying `final`) | deterministic `event_id` (`eventIds.ts`) + coalesced in-process |
| **match record** | `last_run_matches` (migration 0233) | same transaction as the completion | `id` = match id, `ON CONFLICT (id) DO NOTHING` |
| **Elo** | `player_ratings`, `rating_events`, `rating_identities` | same transaction, via `applyRatingResult` | `rating_events` unique `(user, game_key, match_id)` |
| **Trophies** | `player_trophies`, `trophy_events`, `trophy_identities` | same transaction, via `applyTrophyResult` | same journal rule |
| **Leaderboard counters** | `users`, `user_stats` | after commit, best-effort (`applyLeaderboardCounters`) | statistics only — never a result |

The completion event's `payload.metadata` carries both Clerk ids, the result,
reason, survival times, distances, duration and seed. It is additive JSON in an
existing column, and it mirrors the typed row rather than replacing it.

`last_run_matches` is the authoritative per-match record: seat-absolute `result`
(`player1` | `player2` | `draw`), `winner_id` (NULL on a draw), the server's
survival times and distances, the seed, `rated`, and the timestamps. The result
screen and `/api/last-run/history` read it; a refresh after the registry has
forgotten the match still shows the real result.

**Rating is the platform's, not a second one.** `last-run` is registered in
`RATED_GAMES` (trophies reuse that same list), so the shared writer applies Elo
and trophies. A draw settles as `result: "draw"` — both seats journal a draw
and neither win counter moves — exactly like Tic-Tac-Toe. The screen shows a
delta only when `rating.applied` is true and the persisted row exists.

Every write is best-effort and fire-and-forget on the player path: a database
failure is logged and never delays the result. Without `DATABASE_URL` the module
is a no-op. `/api/jobs/last-run-sweep` closes orphaned `started` rows after ten
minutes as `failed` — it never invents a winner.

---

## 8. Free-hosting limitations

- One Next.js process holds live matches; a restart drops them (players see
  "match not found"). The canonical record of a *completed* match survives in
  Postgres.
- The 4 Hz snapshot poll is one authenticated read per player per 250 ms while a
  match is live — under a handful of requests per second for two players, well
  inside a free tier.
- No new service, queue, cache, analytics provider or paid API is used.
- `match_lifecycle` and `match_lifecycle_events` grow by one row (plus the
  canonical transition rows) per completed match; the existing retention job is
  the only cleanup.
