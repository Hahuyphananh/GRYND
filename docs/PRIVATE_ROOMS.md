# Private rooms & friend challenges — implementation plan (from the actual code)

Status: implemented by migration `0217_private_rooms.sql` + `src/lib/rooms/**` +
`src/app/api/rooms/**` + `src/components/rooms/**` + `/rooms/*`.

This file is the audit that came first, the decisions it forced, and the limits
that remain.

## 0. What was verified, and how (read this before trusting the rest)

| Layer | How it was checked | Result |
| --- | --- | --- |
| Authorization rules (`src/lib/rooms/rules.ts`) | unit tests, 58 assertions in `tests/private-rooms.test.mjs` | **tested** |
| Settings / stake policy (`settings.ts`, `catalog.ts`) | unit tests against the real `validateWager` | **tested** |
| Migration `0217` | applied to the real database: tables, indexes, columns, the duplicate-membership `23505`, and two code-less challenges coexisting | **tested** |
| Store SQL (create / invite / join / respond / start / cancel / list / sweep) | executed against the real database with temporary rows, then deleted (0 rows left) | **tested** |
| Concurrent starts | two simultaneous `startRoom` calls on one room → exactly ONE `pool_matches` row, second call idempotent | **tested** |
| Private match never becomes public | the pair's `pool_lobbies` row is `active`, never `waiting`, so `/api/pool/lobbies` cannot list it | **tested** |
| IDOR | a stranger gets 403 on read and never sees the room in their list | **tested** |
| Free player joining by code, PRO-only creation | exercised end to end against the database | **tested** |
| Friendship gate (`areFriends`) | checked against real friendship rows (both directions resolve, self/unknown/non-friend do not) | **tested** |
| Invite → accept with a REAL friend | a real account invited a real friend into a PRO room; the friend read it, accepted, took the seat, the host's `canStart` became true, a repeated invite and a replayed acceptance were both idempotent; the room was then deleted (0 rows left) | **tested** |
| Routes | every endpoint answers 401 unauthenticated and /rooms/* pages redirect to sign-in on a live dev server; all 7 handlers build | **tested** |
| Precision and Tower Arena pair primitives | typecheck + build + source contracts only (see §5.6) | **not verified at runtime** |
| UI (cards, dialog, panel, room page) | compiles and renders; not clicked through by a browser session | **not verified at runtime** |
| `npm run lint` | cannot run in this checkout (no ESLint config; Next 16 removed `next lint`) | **not runnable** |

## 1. What already exists (audited, not assumed)

### Friends and invitations

| Thing | Where | What it really is |
| --- | --- | --- |
| Friendships | `friend_relations (user_id, friend_id)` | One row per direction; created by accepting a request. |
| Friend requests | `friend_invites`, `/api/friends/invite`, `/api/friends/invites`, `/api/friends/invites/respond` | **Request to become friends** — not a game challenge. Pending → accepted/declined, no expiry. |
| Friends tab | `src/app/profil/PageClient.jsx` (tabs: record / friends / invites) | Loads `/api/friends/list`, `/api/friends/invites`, `/api/friends/search`, `/api/friends/game-presence`. |
| Presence | `/api/friends/game-presence` (60s poll, Redis 10s) | Per-friend `presenceState`, `gameKey`, `gameId`. |
| Realtime transport | `realtime-server/server.js` (Socket.IO, verified Clerk token) + `src/lib/socket.ts` + `SocketProvider` | Per-match rooms; `join_room` accepts an arbitrary room id; `admin:join` shows the pattern for a **server-verified** room; `POST /emit` (internal secret) lets a Next.js route broadcast. |
| Supabase Realtime | `src/lib/realtime.ts`, migrations 0096/0097/0204 | Postgres-changes push for *published* tables. Published tables are **world-readable** with the public key, so invitation rows must never be published there. |

There is **no existing "invite a friend to a game" feature** — the platform's
invite vocabulary (`friend_invites`) is friendship-only, and no game route
accepts a specific opponent.

### Room / match creation per game (the decision driver)

Two families, and they are not interchangeable:

1. **`create-or-join` (public matchmaking, auto-paired)** — barricade,
   keno-pvp, lane-rush-duel, memory-grid, mines-pvp, mini-golf, sudoku-duel,
   speed-typing, solitaire-duel, tic-tac-toe. The store's `createOrJoin({userId})`
   picks *any* waiting row for the caller. There is no "seat these two players"
   primitive, so a private room would mean adding one to each store (and its
   game-state initialisation) — a substantial, per-game rewrite.
2. **Explicit lobby + atomic claim** — `pool` (Pool Masters), `precision`,
   `tower-arena`. Each has a `create-lobby` / `join-lobby` pair whose join is one
   conditional `UPDATE … WHERE status = 'waiting'` (or a row-locked transaction),
   so "seat this specific player" already exists as a primitive.

Chess (`create-game` / `join-game`) is closest to family 2 but its waiting rows
are also listed by `/api/chess/available-games` and claimable by anyone: a
private table needs a visibility marker plus listing/join filters on a live,
staked game. Deferred (see §5).

### Money, age and membership

* `src/lib/games/stakes.js` is the ONE wager policy: `validateWager(requested, gameKey)`
  rejects an illegal stake (400), `normalizeStake` clamps, and a 0 stake is a
  legal free match. Room settings reuse it — nothing new decides a wager.
* `requireAgeVerifiedUser()` (18+ gate) is what every game API calls.
* Pro membership is `getMembershipTier(clerkId) === "pro"`
  (`src/lib/stripe/subscriptions.ts`) — the same authoritative check the rest of
  the platform uses. A request body can never claim it.

## 2. Supported games (first cut)

| Game key | Label | Mode | Settings | Why it is safe |
| --- | --- | --- | --- | --- |
| `precision` | Precision | PvP duel | stake | `createMatchForPairing({players: [host, guest]})` creates the match for a **named pair** — no lobby row, nothing to snipe. |
| `pool` | Pool Masters | PvP duel | stake | The claim + `pool_matches` insert used by `/api/pool/join-lobby` is extracted into `src/lib/pool/lobbyJoin.ts` and reused, so the room creates the same match the public flow creates. |
| `tower-arena` | Tower Arena | PvP duel | stake | New `createTowerArenaMatchForPair()` runs the store's own `createLobbyTx` + `joinLobbyTx` in ONE transaction: seat 1 = creator, seat 2 = opponent, and the match is created already started. |

Each adapter calls the game's own store — no game state is re-implemented, and
no public lobby row is created, so nothing about the public matchmaking flow
changes (its queries are untouched).

**Unsupported for now** (the UI cannot select them): every `create-or-join` game
listed in §1.1, plus `chess`, `uno`, `four-in-a-row`, `dots-and-boxes`,
`hex-duel` (client-supplied winner), `crash-arena` (a tables/join-code system
owned by the realtime server), and every solo/AI mode. Selecting one is refused
by the server (`unknown_game`), not hidden in the UI.

## 3. Data model (migration 0217)

* `private_rooms` — one row per room **or** challenge: `id uuid`, `code`
  (unguessable, unique, NULL for a challenge), `kind` (`room` | `challenge`),
  `host_user_id`, `game_key`, `mode`, `settings jsonb`, `status`
  (`open|starting|started|declined|expired|cancelled|failed`), `match_id`,
  `match_url`, `created_at`, `expires_at`, `started_at`, `closed_at`.
* `private_room_members` — `room_id`, `user_id`, `role` (`host|guest`),
  `invite_status` (`invited|accepted|declined`), `name`, timestamps.
  `UNIQUE (room_id, user_id)`.

Indexes: `code` (partial unique, non-null), `(host_user_id, status)`,
`(status, expires_at)`, and `UNIQUE (room_id, user_id)` — the duplicate-join
guard. Persistent tables (not views), no existing table touched.

## 4. Rules enforced on the server

* **Create** — `kind=room` requires a live Pro membership (checked per request);
  `kind=challenge` is free but structurally limited: exactly one invitee, no
  code, and settings the server chooses (any client-supplied settings are
  ignored). That is what lets a free player challenge a friend without gaining
  standalone room-creation privileges.
* **Invite** — host only, must be a friend, room must be open and unexpired, and
  a challenge accepts at most one invitee.
* **Join by code** — any authenticated, age-verified player (free included) may
  join a valid `room` if the code matches; idempotent for someone already in the
  room; refused when expired, cancelled, started, or full.
* **Read status** — host or invited member only; anyone else gets 403 (no IDOR
  by room id, and no private invitation is ever listed to an unrelated player).
* **Respond** — the invitee only; a challenge acceptance claims the room with an
  atomic `UPDATE … WHERE status='open'`, so a duplicate or concurrent acceptance
  can only mint one match.
* **Start** — the host of an accepted Pro room claims the room the same way, then
  calls the game adapter; a failed match creation marks the room `failed` and
  releases it rather than leaving a ghost.
* **Expiry** — lazy sweep on read/write (`expires_at < now()`), so nothing
  depends on a cron; expired rooms answer 410.
* **Abuse** — `consumeRateLimit` on create (Pro: 12/hour) and on join-by-code
  (30/minute per user), on top of 10-char codes from a 32-symbol alphabet
  (32^10 ≈ 1.1e15) with a unique index.

## 5. Known limitations

1. **Three games.** The other multiplayer games need a "seat these two players"
   primitive in their own store first (family 1 in §1.1). Chess is the next one
   worth doing: it needs a `private`/`invite_only` marker on `chess_games` plus
   listing and join filters.
2. **Settings are thin by construction.** Pool, Precision and Tower Arena offer
   no per-room rule options beyond the stake, so the room settings expose exactly
   that: the platform's own `validateWager` bounds (0 = free play). The schema and
   validation path are generic, so the first real per-game option (a chess time
   control, say) is one adapter field.
3. **Realtime is an accelerator, never the source of truth.** A pending
   invitation is a database row that the Friends tab polls; the socket signal
   (`rooms:changed`, emitted to a server-verified `user:<clerkId>` room) only
   makes it appear sooner. The signal carries no room, game or inviter — the
   client refetches its own invitations over its authenticated session.
4. **No push/email** for invitations (out of scope); the existing email
   machinery is for account/lifecycle mail.
5. Rooms are 1v1: every supported game is a two-seat duel, so seats are fixed at
   2 and the model is ready for >2 only after a game supports it. A room may
   invite several friends, but the SEATS are first-come-first-served: the first
   accepted guest takes seat 2 and later acceptances are refused with
   `room_full`. Inviting more than one friend is therefore only useful once a
   game supports more seats (or as a "first to answer plays" lobby).
6. **Precision and Tower Arena match creation is not runtime-verified.** Their
   pair primitives (`createPrecisionMatchForPair`, `createTowerArenaMatchForPair`)
   are type-checked, built and pinned by source contracts, but they were NOT
   executed against the database during this change, because both write a real
   match (escrow + canonical lifecycle for Precision) that would have to be
   undone. What WAS executed for real is the shared mechanism they depend on:
   the room claim, the room rows and Pool Masters' pair primitive. Verify one
   Precision and one Tower Arena room on a staging database before relying on
   them in production.
7. Room creation, joins and the room page all require a signed-in (and, for the
   mutating endpoints, age-verified) account; `/rooms/*` pages are already behind
   the existing page middleware, so a signed-out visitor is redirected to sign-in
   before the page's own "sign in" state can render.
8. A start that dies between the claim and the match (instance crash) leaves the
   room `starting`; the lazy sweep releases any claim older than 2 minutes back
   to `open`, so the host can retry. A guest who re-accepts during the stuck
   window is answered from the room's real state rather than starting a second
   match.
