# LAST RUN — game removal

LAST RUN was removed from GRYND in full. It was a 1v1 endless-runner duel whose
match state lived in the server's own simulation and was pushed to both seats
continuously, which made it the heaviest game in the catalogue for a single
match. The game is now unreachable: no route, no API, no client code, no
engine, no cron.

Every other game — and all of the shared networking, auth, matchmaking and
database code they rely on — is untouched.

## What was deleted

App surface (`src/app`):

- `casino/last-run/` — the lobby (`page.jsx`, `PageClient.tsx`) and the
  per-match view (`[matchId]/page.tsx`, `[matchId]/PageClient.tsx`)
- `api/last-run/` — `queue`, `practice`, `history`,
  `match/[matchId]` (`route`, `input`, `result`, `forfeit`)
- `api/jobs/last-run-sweep/` — the hourly job that closed abandoned matches

Game logic and rendering:

- `src/lib/last-run/` — `engine`, `realtime`, `broadcast`, `matchRegistry`,
  `persistence`, `queries`, `settlement`, `outcome`, `practice`, `constants`,
  `eventIds`
- `src/components/last-run/` — `RunnerArena`, `useRunInput`, `useRunPrediction`,
  `useRunAudio`, `inputKeys`

Assets, docs, tests and ops:

- `src/images/last-run-card.svg`, `public/images/og/last-run.svg`
- `docs/last-run.md`, `screenshots/lobbies/last-run.png`
- `tests/last-run-{engine,realtime,controls,progression,settlement,data-lifecycle,practice}.test.mjs`
- `deploy/jobs/grynd-job-last-run-sweep.timer` and its row in `deploy/README.md`

## What was unwired

| File | Change |
| --- | --- |
| `src/app/casino/PageClient.jsx` | hub card removed |
| `src/lib/gameLandingPages.ts` | landing-page object removed (this also removes `/games/last-run`, its sitemap entry and its related-game links) |
| `src/lib/gameTags.js` | discovery tags removed |
| `src/components/games/gameCardArt.js` | card art import + registry entry removed |
| `src/lib/rating.js` | removed from `RATED_GAMES` and `RATING_GAME_LABELS` |
| `src/lib/quests/games.ts` | removed from `QUEST_GAME_IDS` |
| `src/app/classement/PageClient.jsx` | removed from the leaderboard game chips |
| `src/proxy.ts` | both route patterns (`/casino/last-run(.*)`, `/games/last-run(.*)`) removed |
| `src/lib/appTextTranslations.js` | hub card description removed in all three locales |
| `vercel.json` | `last-run-sweep` cron removed |
| `package.json` | `test:last-run` script and the game's tests removed from `test` |
| `qa/lobby-layout-shots.mjs` | removed from the lobby screenshot roster |

Old URLs (`/games/last-run`, `/games/last-run/play`, `/casino/last-run`,
`/casino/last-run/<id>`, `/api/last-run/*`) now fall through to the normal
not-found path: the files are gone, the proxy no longer classifies them as game
routes, and the unknown-slug guard rewrites `/games/last-run` to the not-found
sentinel.

## Database: what stays, and why

Nothing was dropped. The migrations and the table are retained:

- `src/db/migrations/0233_last_run_matches.sql` — creates `last_run_matches`
- `src/db/migrations/0234_last_run_rls.sql` — denies direct client access
- `src/db/schema.ts` — `lastRunMatches` table definition
- `src/lib/security/deleteUserData.ts` — erases a deleted account's rows
- `src/app/api/jobs/retention/route.ts` — keeps the table inside the 45-day
  retention window

The rows are the only per-match record those players have (the shared
`match_lifecycle` row carries no participants), so they are historical user data
and are preserved. The two remaining references in live code are not gameplay:
they are the privacy erasure path and the retention purge, and both would be
needed even for an unplayable table.

### Proposed cleanup (NOT executed — needs approval)

Only after the data has been exported or explicitly declared disposable:

```sql
-- 1. stop the retention job from referencing the table (already harmless)
-- 2. drop the RLS policies and the table
DROP POLICY IF EXISTS last_run_matches_no_client_access ON last_run_matches;
DROP TABLE IF EXISTS last_run_matches;
```

Then delete `src/db/migrations/0234_last_run_rls.sql` + `0233_last_run_matches.sql`
and their `src/db/migrations/meta/_journal.json` entries, remove `lastRunMatches`
from `src/db/schema.ts`, `src/lib/security/deleteUserData.ts` and
`src/app/api/jobs/retention/route.ts`, and drop the matching
`rating_events` / `trophy_events` rows with `game_key = 'last-run'` if the
historical ladder entries are also to go. Generate a NEW forward migration
rather than editing applied ones.

## Verification

- `npx tsc --noEmit` — clean
- `npm run build` — see the removal report in the pull request
- Existing tests for every other game still pass (the game's own 7 test files
  were deleted with it)
- Old URLs return the app's not-found page

## Measured change

Grep counts over the deleted game code at `HEAD` (files are now gone, so the
after count is zero for each):

| Primitive | Before | After |
| --- | --- | --- |
| `setInterval` | 2 | 0 |
| `setTimeout` | 11 | 0 |
| polling / `useSWR` | 16 | 0 |
| socket listeners/emits | 0 (used the shared realtime rooms via `broadcast.ts`) | 0 |

The shared Socket.IO server, its rooms, the shared matchmaking and the shared
Supabase/Postgres access are unchanged — LAST RUN only consumed them.
