# A standalone Poki build of one game — scope assessment

Status: **assessment only. Nothing is implemented, and this does not claim Poki
compatibility or approval.** Estimates below are judgements, not measurements;
the file sizes and line counts are real.

---

## 1. Why the current surface cannot be submitted

Everything in this app is server-authoritative: board state in Postgres, moves
validated by API routes, the bot run by an API route, results written by the
server. Poki hosts the build itself and **blocks external requests by default**,
so an iframe or a redirect to `grynd.dedyn.io` is not a submission. A Poki build
is a single self-contained HTML5 bundle that runs with no network at all.

That is a port, not an export: one game's rules, bot and state have to live in
the browser, and the site's shell (Clerk, PostHog, Sentry, fonts, consent banner,
navbar, chat, quests) has to be absent rather than hidden.

## 2. Recommended candidate: Ultimate Tic-Tac-Toe

| Candidate | Verdict |
|---|---|
| **tic-tac-toe** | ✅ best fit — see below |
| odds | ⚠️ small rules, but the round/clue/shrinking-range loop and its scoring need porting |
| dominoes | ⚠️ larger rule surface (deal, chain matching, passes, blocked end) |
| battleship | ❌ biggest — fleet placement, 14×10 grids, simultaneous rounds, reveal timing |

Tic-Tac-Toe wins on three counts:

1. **Its logic is already browser-safe.** `src/lib/tic-tac-toe/rules.ts`
   (844 lines) imports only its own constants and types;
   `src/lib/tic-tac-toe/ai.ts` (315 lines) imports constants, `aiDifficulty` and
   `rules` — no database, no `next/*`, no env. Both can be lifted into a static
   bundle unchanged.
2. **Its bot already exists and is pure** — the Hard/Normal/Easy tiers are in
   `ai.ts`, so there is no server round-trip to replace, only a call site.
3. **Its board is presentational.** `src/components/tic-tac-toe/MegaBoard.tsx`
   takes the lattice and callbacks as props and imports React, framer-motion and
   `TicTacToeBoard` — nothing server-side.

What must be written is the *shell*, not the game.

## 3. Work breakdown

| # | Work | Notes | Est. |
|---|---|---|---|
| 1 | Local match store | replace `lib/tic-tac-toe/serverStore.ts` (Prisma/Drizzle + tx) with an in-memory reducer + `applyMove` from `rules.ts`; one player, one bot | 1–1.5 d |
| 2 | Bot turn loop | call `ai.ts` turn-choice, animate the reply, guard against double-start | 0.5 d |
| 3 | Screen shell | one page: title, difficulty picker, board, result card, "play again" — no Next, no Clerk, no i18n framework | 1–1.5 d |
| 4 | Build pipeline | Vite (or esbuild) build to a single HTML + JS + CSS; no CDN, no code splitting, inline or bundled assets | 0.5–1 d |
| 5 | Poki SDK | `PokiSDK.init()`, `gameLoadingFinished()`, `gameplayStart/Stop()`, `commercialBreak()` at match end; no-op fallback outside Poki | 0.5 d |
| 6 | Persistence | localStorage for wins/losses/streak; no account, no cookie, no identifier | 0.5 d |
| 7 | Layout & input | responsive in a 16:9 frame, portrait phones, touch targets, no scroll | 1 d |
| 8 | Network audit | prove zero external requests in DevTools; strip fonts, analytics, Sentry, Clerk, images from third parties | 0.5 d |
| 9 | QA + polish | play-through on desktop + mobile, ad interruptions, restart, reload mid-game | 1 d |
| 10 | Store assets + submission | icon, cover, screenshots, description, privacy statement for the build (no backend calls) | 1 d |

**Rough total: 7–9 developer days** for a submission-grade build of one game,
before Poki's review cycles. The rule of thumb that matters: the game is ~15% of
the work and the shell, build and QA are the rest.

## 4. Constraints the build must satisfy

- **Initial download under ~8 MB.** Feasible with a wide margin: the rules, bot
  and board are a few hundred KB of JS before minification; the risk is only if
  React + framer-motion + shared UI are pulled in wholesale. A build without
  framer-motion would be smaller and is worth considering.
- **16:9 canvas** and mobile-first controls.
- **No external requests.** Poki allows approved exceptions (multiplayer server,
  analytics, leaderboards) only after review with a privacy statement; the
  simplest compliant build makes none.
- **No external account system, no personal data, no outbound links.** That
  directly conflicts with the "Play on GRYND" button added for Poki visits on
  `/play` (`docs/portal-export.md` §5.6) — in a standalone Poki build that button
  would have to be removed.
- **Web exclusivity.** Poki expects the game to be on Poki for the open web. The
  same game is live at `grynd.dedyn.io` and would be offered to itch.io /
  CrazyGames, so this is a business decision before it is an engineering one.
- **Review is curated** (closed access, application through Poki for
  Developers). A build can be complete and still not be accepted.

## 5. What this does NOT reuse

- `/play/[gameKey]` — it is a Next.js route on a server. Nothing from it ships.
- The shared `PvpLobby` — its practice-only mode (docs §5.4) is the right UX, but
  it is a React page component wired to routing; the standalone build wants a
  much smaller screen.
- Matchmaking, coins, Elo, trophies, quests, guest progress storage, analytics —
  all server features, all out of scope by design.

## 6. Recommendation

Do **itch.io** and **CrazyGames (external iframe)** first — they cost days, not
weeks, and the framed surface already exists and is tested. Port one game for
Poki only if the exclusivity trade-off is acceptable for that specific game;
Ultimate Tic-Tac-Toe is the one to port when it is.
