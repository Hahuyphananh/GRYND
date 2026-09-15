# Active players per game (the lobby's "N playing" badge)

Complete: the backend counts live players, every game the lobby ships reports
presence from the lifecycle edge it already had, and every game card shows the
result. See *Lobby badge* for the UI half.

## What it answers

```
game → number of currently active players        e.g. { roulette: 12, crash: 8, rps: 5 }
```

Aggregate counts **only**. No user ids, emails, usernames, session ids or
per-game player lists are ever returned or rendered — the lobby shows a number,
never a person.

## Storage: `user_game_presence`

One row per **(user, game)**, extended by migration `0159_game_presence.sql`
with the columns this feature needs:

| Column | Meaning |
|---|---|
| `user_id` | `users.id`, from the Clerk session — never a client value |
| `game_key` | **canonical game id** (the lobby's `leaderboardKey`, e.g. `mines-pvp`, `rps`, `crash`) |
| `game_id` | reserved integer (0012); unused today |
| `session_id` | client tab/session id — informational, **not** part of the unique key |
| `last_seen_at` | last heartbeat; the activity window is measured from here |
| `created_at` | first time this user was seen in this game (INSERT-only) |
| `updated_at` | bumped on every beat |

Constraints: `UNIQUE (user_id, game_key)` — the upsert target, and the reason a
player with two tabs or two devices still counts once. Index
`(game_key, last_seen_at DESC)` — the aggregate's access path.

### Why this table and not `user_presence`

`user_presence` is the online / friends feed. Its app-wide heartbeat
(`src/components/PresenceHeartbeat.tsx`) refreshes `last_seen` for **every**
signed-in tab and deliberately preserves `status = 'in_game'`, so a player who
closes a game with another GRYND tab open would be counted as playing forever.
`current_game_id` is also a `"key:id"` string that can't be grouped per game
with an index.

`user_game_presence` had the right shape and indexes since migration `0012` and
was **written and read by no code at all**, so this feature adopts it rather
than adding a fourth presence system. `spectator_presence` (spectators) and
`match_lifecycle` (canonical queue/match state for a few games, no per-player
rows) stay as they are.

## Expiration: time only

There is **no leave requirement**. A row is active while
`last_seen_at > now - ACTIVE_PLAYER_WINDOW_SECONDS`.

| Constant | Value | Why |
|---|---|---|
| `PRESENCE_HEARTBEAT_MS` | 60s | three beats per window → two dropped beats can't blink a real player out |
| `ACTIVE_PLAYER_WINDOW_SECONDS` | 180s | a closed tab / crashed browser is gone within ~3 minutes; shorter would flap, longer would leave ghosts |

A deliberate leave just makes the drop-off instant. Daily storage hygiene is
handled by the existing `/api/jobs/retention` sweep, which calls the store's
`pruneStalePresence()` (rows older than a day) — one implementation, in the
module that owns the table.

### One clock, assumed UTC

`user_game_presence.last_seen_at` is a naive `TIMESTAMP` (the wait-0012 design,
kept so the whole 0012 presence family matches). Writes and the window
predicate both use the app clock, and the runtime is UTC (Vercel/Node default),
so the window means the same thing on both sides. A runtime with a non-UTC `TZ`
pointed at a UTC database would shift the window by the offset — if that ever
becomes a deployment shape, make the column `timestamptz` (or compare against
`NOW()` in SQL) rather than relying on the app clock. The retention sweep is
immune either way: it deletes on a one-day threshold.

## API

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/presence/active-game` | required | body `{ gameLabel, sessionId? }`; resolves the label to a canonical id server-side; unknown → `400`; rate-limited (30/min); idempotent upsert; returns `{ success: true }` only |
| `POST /api/presence/active-game/leave` | required | body optional; scoped to the caller and, when supplied, to their `sessionId`, so one tab can't clear another's |
| `GET /api/casino/active-players` | public | `{ success, counts, generatedAt }`; Redis-cached 10s (`CacheKeys.activePlayers()`), `s-maxage=10`; fails closed to `{}` |

`gameLabel` is the value game pages **already** pass to `<CreatorModeHost>` /
`useRecordPlayedGame` (`mines-duel`, `rock-paper-scissors`, `crash-arena`, …).
The label → id map lives in exactly one place, `src/lib/gamePresence.js`, so a
page needs no changes and an unknown label can never create a row.
`precision-test` is intentionally not in the map (developer harness, not a
shipped game surface). Alternate play surfaces collapse onto their lobby card:
`chess-ai` → `chess`, `neon-flush` → `uno`, `dice-flush` → `yahtzee`, etc.

## Client wiring

Two files carry the client half; no game page implements presence itself.

- `src/lib/gamePresenceClient.js` — the transport. `getPresenceSessionId()`
  (a per-tab id in `sessionStorage`), `sendPresenceBeat()`,
  `sendPresenceLeave()`. Every call is `credentials: "include"` +
  `keepalive: true`, resolves to a boolean, and **never rejects**.
- `src/hooks/useActiveGamePresence.js` — the one hook:
  `useActiveGamePresence(gameLabel, active, { enabled, terminal })`.

| Edge | Behaviour |
|---|---|
| `active` turns true | one beat immediately, then every `PRESENCE_HEARTBEAT_MS`; also re-beats on `visibilitychange`/`online` so a tab the browser throttled is current the moment the player returns |
| `active` turns false | beats stop. **No leave is sent** — the 180s window absorbs a transient gap (that is what keeps a Crash Arena player counted between rounds) |
| `terminal` turns true | beats stop **and** a scoped leave is sent, so a finished match leaves the count at once instead of up to 3 minutes later |
| component unmounts | scoped leave (sent whenever **this mount beat**, even if it was opted out later), so navigating away is instant |
| tab/browser closed or crashed | nothing is sent — the server window expires the row |
| label is not a real game, or `enabled === false` | nothing is sent at all, not even the leave |

`sessionId` is not an identity: the server always takes the caller from the
Clerk session, so no client value can make someone else look active. It exists
so one tab's leave cannot wipe a second tab's still-live row.

## How each game counts as "playing"

Every mount forwards the game's **own** lifecycle signal. `<CreatorModeHost>`
is wired once (`active = autoStart && !autoStop`, `terminal = autoStop`), which
covers 21 surfaces; the four pages that never mount it call the same hook next
to their existing "a real session started" edge.

| Game (canonical id) | Surface(s) | Counts while |
|---|---|---|
| roulette | `roulette/[matchId]` | the match is bettable/ready (not the waiting room) → finished/cancelled |
| blackjack | `blackjack/[matchId]` | the match left `waiting` → finished/cancelled |
| mines-pvp | `mines-pvp/[matchId]` (`mines-duel`) | past `waiting` → finished/cancelled |
| memory-grid | `memory-grid/[matchId]` | past `waiting` → until the match is finished or cancelled |
| plinko | `plinko/[matchId]` (`plinko-duel`) | ready or launchable → finished/cancelled |
| poker | `poker/multi` | the hand is dealt (`!waiting`) → showdown with a winner |
| crash | `crash-arena/table/[tableId]` (hook) | a round is `running`; the gap between rounds is absorbed by the window, leaving the table clears |
| chess | `chess/ai` (`chess-ai`) and `chess-game/[gameId]` | the game is live → game over / finished / expired |
| keno | `keno-pvp/[matchId]` | a round is in play → finished/cancelled |
| uno | `uno/multiplayer` (`uno-multiplayer`) and `uno/game/[gameId]` (`neon-flush`) | a game is on screen (never the lobby) → end popup |
| rps | `rps/game/[gameId]` and `rps/play-ai` | matched/active · past the picker → finished/cancelled · match over |
| tower-arena | `tower-arena/game/[matchId]` | `isActive` **and not eliminated** → `isFinished` |
| four-in-a-row | `four-in-a-row/game/[gameId]` and `.../play-ai` | `in_progress` · game active → finished/cancelled · game ended |
| lane-runner | `lane-runner/[matchId]` (`lane-rush-duel`) | match `active` → finished/cancelled |
| pool-masters | `pool-masters/game/[matchId]` (hook) | match started with a dealt rack → a winner is decided |
| hex-duel | `hex-duel` (hook) | a real board is on screen → game over (resumes on rematch) |
| yahtzee | `dice-flush` | `playing` → `finished` |
| odds | `odds` (hook, AI + PvP components) | a duel is live → the duel is decided |
| precision | `precision/game/[matchId]` | past the waiting room → finished |
| dots-and-boxes | `dots-and-boxes/game/[gameId]` | `in_progress` → finished/cancelled |

### Product decisions

- **Waiting rooms / matchmaking do not count.** Every signal above starts past
  the waiting takeover: a player queueing for an opponent is not yet playing.
  Where a game's own `autoStart` already counts its post-matchmaking ready step
  (roulette, blackjack) that step counts too — the rule is "reuse what the game
  itself calls a live session", not a new definition per game. The one genuine
  exception is Crash Arena, where the table itself is the session and the wait
  between rounds is part of playing.
- **Finished games stop.** `autoStop` (or the direct `terminal` signal) ends the
  beats and clears the row, so a result screen never keeps a match "playing".
- **Spectators are never counted.** Five surfaces expose a view-only route where
  the match looks live to the watcher too — chess, four-in-a-row, poker and
  dots-and-boxes pass `presenceEnabled={false}`, and hex-duel passes
  `!isSpectator` into the hook. A spectator sends nothing at all.
  Tower Arena reaches the same state from inside a match: a player eliminated
  mid-match stays on the live page (`match.status` is still `active`) watching
  the survivors, so presence opts out at `iAmEliminated` while Creator Mode
  keeps recording the match as it always did.
  A player who stops counting this way is not stranded in the count: the row is
  this mount's own, so the unmount leave still clears it, and the window expires
  it regardless.
- **Multiple tabs never inflate a count.** The upsert key is `(user_id,
  game_key)`; the per-tab `session_id` only scopes the leave.
- **Presence can never affect gameplay.** The hook reads no match state, writes
  nothing a game reads, renders nothing, and swallows every failure (401/429/500
  and network errors alike) — see `src/lib/gamePresenceClient.js`.

## Lobby badge (on the game cards)

Every card in the casino lobby shows how many players are inside that game
right now, from `GET /api/casino/active-players`:

| State | Card footer |
|---|---|
| nobody playing | `● No players right now` |
| 1 … 49 | `● 12 playing` |
| 50+ | `🔥 127 playing` |
| first load | a subtle pulsing placeholder (no text) |
| the read failed | **nothing** — the card is exactly what it was before |

- **One request per poll, never one per card.** The endpoint answers for the
  whole lobby in one read (Redis-cached 10s server-side) and the lobby maps it
  with `counts[game.leaderboardKey]` — the canonical id the card already
  carries. No game list and no count is hardcoded in the UI.
- **Polling:** 20s (`ACTIVE_PLAYERS_POLL_MS`) — inside the requested 15–30s
  window and the shortest cadence that can never miss the endpoint's own 10s
  cache. It polls only while the tab is visible, refreshes immediately when the
  tab comes back, never overlaps two requests, and clears its interval (and its
  `visibilitychange` listener) on unmount. No page reload, no per-card fetch.
- **A failure hides the badge instead of printing a zero.** The route fails
  closed with `success: false` (HTTP 200) when it cannot read the store, and
  that is treated as a failure. Filters, sorting, search, game links, the For
  You strip and every Play button keep working through a presence outage —
  asserted in `tests/game-presence.test.mjs`.
- **Placement:** the footer of the existing `GameCard`, so the All Games grid
  and the personalized For You strip share one card system and one badge. The
  card art stays free for the PvP / NEW / HOT / Recommended badges and the
  friend-presence avatars.
- **Accessibility:** the label is real text, the glyph is `aria-hidden`, and
  every state differs in words — colour is never the only signal. The line is
  rendered *outside* the card's link (`<Link aria-label="Play …">` would
  otherwise swallow it), so screen readers read the count.
- **Localization:** `home.casino_lobby.players_playing` (`{count} playing`) and
  `home.casino_lobby.players_none` in `src/lib/appTextTranslations.js`, present
  in en / fr / es, with the count formatted for the active locale (`1,234` in
  en, `1 234` in fr).
- **One shared threshold:** `HOT_PLAYER_THRESHOLD = 50` and the pure
  `activePlayerTier()` / `formatPlayerCount()` rules live in
  `src/lib/gamePresence.js`, so the three states are tested rather than a
  condition inside JSX.

Verify the layout with `npm run verify:lobby-for-you`: real Chromium at six
viewports checks that the label is present on every card, stays inside it
(clipping would hide it silently), keeps to one line and a 200px budget, never
covers the card art, does not change the card/grid geometry, and introduces no
horizontal scroll — plus a control page with the badge removed.

## Files

- `src/lib/gamePresence.js` — ids, label map, window/heartbeat, pure helpers
- `src/lib/gamePresenceStore.ts` — `markPlaying` / `clearPlaying` / `countActivePlayers` / `pruneStalePresence` (+ inspectable query builders)
- `src/lib/gamePresenceClient.js` — client transport + per-tab session id
- `src/hooks/useActiveGamePresence.js` — the shared client hook
- `src/components/creator-mode/CreatorModeHost.jsx` — the shared wiring point (21 mounts, `presenceEnabled` for spectators / eliminated players)
- `src/app/casino/PageClient.jsx` — the "N playing" line on every game card
  (the shared `<GameCard>` used by the grid *and* the For You strip)
- `src/app/api/presence/active-game/**`, `src/app/api/casino/active-players/`
- `src/db/migrations/0159_game_presence.sql`
- `tests/game-presence.test.mjs` (`npm run test:presence`)
- `qa/game-presence-check.mjs` (`npm run verify:game-presence`) — prints every
  lobby game with its start/stop signal and fails if a game is unwired, a mount
  forgot `autoStart`/`autoStop`, or a second implementation appears
- `qa/lobby-for-you-check.mjs` (`npm run verify:lobby-for-you`) — the responsive
  check that now also covers the badge at six viewports
