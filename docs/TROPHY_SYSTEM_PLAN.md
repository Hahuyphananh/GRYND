# GRYND Trophy System — Implementation Plan

Status of this document: living plan. Last updated after the trophy data
model + writer landed.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Prestige naming collision | **Repurpose the existing Prestige.** Retire the XP/net-wins model; redefine as a derived `Elo − 1000`. |
| 2 | Battle Pass progression | **Derived from trophies.** Implemented as the player's TOTAL trophies (sum of the per-game counts): level 1 at 0, level 100 at 10,000, i.e. 100 trophies/level. A per-game split is NOT implemented — see the open question below. |
| 3 | Draws | **0 trophies** (decisive results only). |
| 4 | Game coverage | **Exactly the 14 `RATED_GAMES`** (the Elo registry). |
| 5 | Battle Pass reward claim scoping | **Per game (planned).** Not yet implemented: `battlepass_claims` is still global / per-level. Earned rewards are preserved across the level reset. |

### Open question — total vs per-game Battle Pass

The user's instruction was "base the Battle Pass on trophy amount (level 100
is 10k trophies)". This batch implements a single 1–100 track driven by the
player's **total** trophies, because the Battle Pass is one global track with
one level. With 14 rated games each capped at 10,000, a per-game track would
require 14 separate 1–100 ladders (and per-game claim scoping, decision 5).
Which model is intended should be confirmed before the per-game work starts.

### Why "per game" for Battle Pass rewards (decision 5)

The requirement is that 10,000 trophies represents "100% Battle Pass
completion / all Battle Pass progression unlocked **for that game**". A single
pooled reward set would let one game's trophies unlock rewards the player never
progressed in another game to, which contradicts the per-game framing and would
make the trophy ladder trivially farmable through the easiest game.

Consequences to implement in the Battle Pass phase:
- `battlepass_claims` gains a `game_key` and its unique key becomes
  `(user_id, game_key, level, reward_type)`.
- `/api/battlepass` returns per-game progress; `/api/battlepass/claim` takes the
  target game.
- The catalogue in `src/lib/battlepassRewards.js` is reused unchanged, applied
  once per game.
- Existing global claims are grandfathered: the migration backfills them under a
  sentinel game key (or mirrors them into every game) so nothing is revoked.

## The trophy rule

- Ranked win = **+30**, ranked loss = **−30**, draw = **0**.
- Clamped to **[0, 10,000]**.
- Per game, independent, never combined.
- Below the cap: trophies are the primary visible progression **and** the primary
  matchmaking signal.
- At the cap: trophy progression is complete; **Elo** (and its derived Prestige)
  becomes the primary signal.

Prestige is derived, never stored: `prestige = max(0, elo − 1000)`.

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Retire the legacy XP/net-wins Prestige and its settlement hooks | **Done** |
| 2 | Trophy data model (`player_trophies` / `trophy_events` / `trophy_identities`) | **Done** |
| 3 | Server-authoritative writer `applyTrophyResult` + tests | **Done** |
| 4 | Wire the writer into the 14 rated settlements | **Done** |
| 5 | Trophy Redis namespace + invalidation | **Done** |
| 6 | Per-game + Overall Trophies leaderboards (readers + routes) | **Done** |
| 7 | Classement UI: trophies primary, Elo secondary | **Done** — a Trophies tab (default-adjacent) renders the Overall Trophies board; every other board keeps its Elo badge. |
| 8 | Profile / result / navbar UI: trophies → Elo → Prestige | **Done** for the navbar + profile + public profile + stats APIs (totalTrophies exposed; navbar chip swapped from Overall Elo to trophies). In-chat / in-game Prestige badges remain inert until per-user trophy maps are joined there. |
| 9 | Reimplement Prestige as derived `Elo − 1000` + badge | **Done** — `src/lib/prestige.js` is now pure/derived (gated on a game's trophies reaching the cap); prestige-badge, public-profile, titles, battlepass, user/stats and the leaderboard decorator all read the derived value. |
| 10 | Battle Pass derivation + re-keyed claims | **Partially done** — level/progress derived from TOTAL trophies; XP rewards removed (reserved levels pending replacements); level reset to 1 for all players (migration `0176`). Per-game claim scoping still pending. |
| 11 | Matchmaking: skill snapshot + expanding ranges | **Done** — the quick-queue worker loads each player's per-game trophy snapshot and the matcher prefers a close gap, widening with wait time and falling back to FIFO when data is missing. |
| 12 | Docs, build + tests | **Done** — `next build` exit 0; `test:trophies` (now includes the matchmaking tests), `test:elo`, `test:overall-elo`, `test:elo-leaderboard`, `test:prestige-retired`, `test:battlepass` all green. |

## Phase 2-3 inventory (done)

- `src/lib/trophies.js` — pure rule, bounds, phase, derived Prestige, read
  shapes. Reuses `RATED_GAMES` as the single game registry (no drift from Elo).
- `src/lib/trophyStore.js` — `applyTrophyResult`, `getTrophyForUser`,
  `getTrophiesForUser`. Mirrors `src/lib/rating.js`: row locks in ascending
  `user_id` order, `(user_id, game_key, match_id)` idempotency journal, and the
  email-hash anti-reset ledger.
- `src/db/schema.ts` — `playerTrophies`, `trophyEvents`, `trophyIdentities`.
- Migrations `0173_player_trophies.sql`, `0174_trophy_events.sql`,
  `0175_trophy_identities.sql`, registered in `_journal.json`.
- `tests/trophy-system.test.mjs` — 36 hermetic tests (pure math, bounds,
  derived Prestige, writer happy paths, duplicate protection, unauthorized
  input, cap, anti-reset, schema/migration presence, and the "only the store
  writes trophy tables" security invariant).
- `package.json` → `npm run test:trophies`.

## Phase 1 inventory (done)

- `src/lib/prestige.js` is now a retirement seam: `getPrestigeStatus` reports a
  neutral state and `resolvePrestigeBadge` always returns null; the writer
  (`applyPrestigeResult`), requirements table, tiers and transition math are
  gone.
- Every `applyPrestigeResult` call and import was removed from all 22 settlement
  call sites (the 18 rated ones plus hex-duel, uno, tower-arena and
  rps/pvp/choose). Nothing writes `prestige_results` any more.
- The obsolete `tests/prestige.test.mjs` / `tests/prestige-db.test.mjs` were
  deleted; `tests/prestige-retirement.test.mjs` + `npm run test:prestige-retired`
  assert the removal (including that the rating/trophy anti-reset ledgers are
  still not purged with an account).
- The legacy `users.prestige_level` / `prestige_net_wins` columns and the
  `prestige_results` table are now inert and can be dropped in a later
  migration.

## Phase 4-6 inventory (done)

- `applyTrophyResult` is wired into all 18 settlement call sites for the 14
  rated games, inside the caller's transaction where one exists and with the
  same `matchId` idempotency key as Elo. Draws pass `result: "draw"` (0
  trophies).
- `src/lib/redis/keys.ts` gained the `trophy` cache namespace and
  `CacheTTL.trophy = 60`; `src/lib/redis/invalidation.ts` gained
  `invalidateTrophyBoards(gameKey?)`, wired into `invalidateOnGameSettlement`.
- `src/lib/trophyStore.js` gained `fetchTrophyLeaderboard`,
  `fetchOverallTrophyLeaderboard`, `toOverallTrophyShape` and
  `listTrophyGames`; `src/lib/trophies.js` gained
  `overallTrophiesFromCounts`, `OVERALL_TROPHY_MIN_GAMES` (3) and the label.
- Routes: `GET /api/leaderboard/trophy?game=` and
  `GET /api/leaderboard/trophy-overall` (read-only, cached, rate-limited).

Nothing is exposed in the UI yet, and the legacy Elo tables, routes, UI and
calculation are untouched.

## This batch (trophies → product)

- **Navbar** (`src/components/navigation-bar.jsx`) now shows the player's
  **total trophies** (`data-testid="nav-trophies"` / `nav-trophies-mobile`)
  instead of Overall Elo, seeded from a `nav-trophies` sessionStorage cache.
  `/api/get-user-tokens` exposes `totalTrophies`. Everyone starts at 0, so 0 is
  rendered rather than an "Unrated" placeholder.
- **Battle Pass** (`src/lib/battlepass.js`, `src/app/api/battlepass/*`,
  `/api/user-stats`, `/api/user/stats`) derives the level from TOTAL trophies:
  `TROPHIES_PER_LEVEL = 10_000 / 100 = 100`, level 1 at 0, level 100 at 10,000.
  The legacy XP functions remain only as the retired read seam.
- **XP rewards removed** from `src/lib/battlepassRewards.js` at levels 9, 17, 19,
  27, 33, 36, 43, 53, 61, 67, 73, 91, 93, 97, 99 — now listed in
  `RESERVED_LEVELS` until replacement rewards are specified.
- **Level reset** — migration `0176_reset_battlepass_progress.sql` sets
  `users.xp=0, users.level=1` (and the `user_stats` mirror) while leaving every
  earned reward table (`battlepass_claims`, `user_emotes`,
  `user_special_titles`, `user_glows`, `user_cosmetics`) untouched.
- **Prestige** is derived (`max(0, elo − 1000)`, gated on the 10,000 trophy cap)
  and read consistently by the prestige-badge route, public profile, titles,
  battlepass, user/stats and the leaderboard prestige decorator.
- **Trophy leaderboard UI** — a Trophies tab on `/classement` backed by
  `GET /api/leaderboard/trophy-overall`.
- **Trophy matchmaking** — workers snapshot trophies in bulk
  (`getTrophyMapsForUsers`) and the matcher (`src/lib/quickQueue.ts`) accepts a
  partner within a trophy window that widens 60 trophies/second from 200 up to
  the full 10,000 band. Non-rated games and players with no trophy rows match by
  FIFO as before.

## Preserved (must stay untouched)

`src/lib/elo.js`, `src/lib/rating.js`, tables `player_ratings` / `rating_events`
/ `rating_identities`, migrations `0170`-`0172`, `GET /api/leaderboard/game`,
`GET /api/leaderboard/overall`, and the Elo UI primitives (`ProvisionalChip`,
`OverallEloBadge`, `RatingsPanel`).

## Known conflicts / risks

1. **Prestige collision** — the live `src/lib/prestige.js` (Battle Pass Level
   100 gated, net wins, tiers 0-10, badge) must be retired before the derived
   `Elo − 1000` representation can take the name. Its writer is called from more
   settlements than Elo (also hex-duel, uno, tower-arena, rps), so those calls
   come out too.
2. **Battle Pass is global/XP-based** — per-game trophy derivation is a
   structural change (see decision 5).
3. ~~**No skill signal in matchmaking today**~~ — **resolved**: the quick queue
   now snapshots each player's trophies per game and widens the acceptable gap
   with wait time, falling back to the original game/mode/region/FIFO matching
   when either side has no trophy data.
4. **Excluded games** — hex-duel trusts a client-supplied winner; uno and
   tower-arena are multi-player. They are not rated and therefore not trophy
   eligible until their winners are server-derived.
