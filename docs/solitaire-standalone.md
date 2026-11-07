# A standalone HTML5 build of Solitaire Duel

Status: **implemented, builds locally, not submitted anywhere.** This document
describes the build in `standalone/solitaire-duel/` and what it is and is not.

---

## What it is

A completely independent HTML5 version of Solitaire Duel: one folder of static
files that plays the full game — one proven-solvable Klondike deal, a human
board, a bot board, three difficulties, live progress and a result — with **no
server of any kind**.

It exists for portals that host the build themselves and block external requests
(Poki), and for portals where an upload is simply the better shape (itch.io). It
is a *second delivery shape* for the same game, not a replacement for the hosted
URL export (`/play/<gameKey>` + `scripts/export-portal.mjs`), which remains the
right route for CrazyGames' externally hosted iframe.

## Build

```bash
npm run package:itch:solitaire     # build (GRYND sign-in CTA on, no SDK) -> dist/packages/solitaire-duel-itch.zip
npm run verify:itch:solitaire      # validates that ZIP, then plays the extracted copy offline
npm run build:portal:solitaire     # vite build -> dist/portal/solitaire-duel/
npm run dev:solitaire-standalone   # local dev server on :4319
npm run test:solitaire-standalone  # the focused test file
npm run verify:portal:solitaire    # plays the BUILT package in Chrome, offline
```

Output (`dist/portal/solitaire-duel/`, git-ignored):

```
index.html        # the upload root — document-relative asset paths
favicon.ico       # + favicon.svg, favicon-32.png, apple-touch-icon.png
icon-512.png      # the icon portal submission forms ask for
assets/*.js       # one bundle: React + the game + the shared engine
assets/*.css      # only the board's utilities and its six --gr-* tokens
```

Upload the CONTENTS of that folder (so `index.html` is at the package root).
There is no base path to configure (`base: "./"`), no `public/` output folder and
no second chunk. Icons come from `standalone/solitaire-duel/public/` (generated
by `npm run artwork:portal:solitaire`, committed so a build never needs the image
toolchain). Packaging, covers, zipping, the CTA switch and the opt-in portal SDK
are documented in `docs/portal-build-solitaire.md`.

## What it reuses (unchanged)

The point of the build is that it contains no second copy of the game:

| Concern | Module |
|---|---|
| rules, legality, move application, views, progress, race ladder | `src/lib/solitaire-duel/rules.ts` |
| deck + seeded deal | `deck.ts` |
| proven-solvable deal generation | `solvable.ts` |
| bot heuristics, pacing, planner | `ai.ts` |
| drag-and-drop and click-to-place model (one move builder) | `interactions.ts` |
| result and progress labels | `ui.ts` |
| PRNG | `src/lib/physics2d/deterministic.ts` |
| difficulty tiers | `src/lib/aiDifficulty.ts` |
| board and card rendering | `src/components/solitaire-duel/{SolitaireBoard,PlayingCard}.tsx` |

Only two things are new: the local match controller
(`standalone/solitaire-duel/src/match.ts`) and the screen
(`standalone/solitaire-duel/src/App.tsx`).

## What it deliberately omits

No Clerk, no session or guest cookie, no `serverStore.ts`, no database, no API
route, no Socket.IO, no PostHog/Sentry, no ads, no analytics, no Elo, trophies,
coins, wagers, quests or any persistence. The only network request the build can
make is the one for its own document and assets. The optional post-match CTA is
an ordinary anchor to the GRYND sign-in page: it loads nothing unless a player
clicks it, and the game never talks to GRYND itself.

`tests/solitaire-duel-standalone.test.mjs` walks the import graph from
`src/main.tsx` and fails if any of those reappear, if a non-React package is
imported, or if the app's own sources call `fetch`/XHR/WebSocket or touch
storage.

## The match, locally

Identical to the server's practice mode, minus the server:

1. `randomSeed()` — one `crypto.getRandomValues` uint32.
2. `solvableDealFromSeed(seed)` — a random Klondike deal that a search proved
   winnable, that the engine replayed move by move, and that the naive
   foundation-only strategy *cannot* solve. Deals are hard-but-fair, never
   laid out.
3. `initialStateFromDeal(deal)` **twice** — two boards, same cards, no shared
   objects.
4. Player moves go through `applyMove` (the same validator the API uses); an
   illegal move changes nothing and surfaces the engine's own message.
5. The bot is paced by the clock, not by a turn: at any instant it has earned
   `floor((now − GO) / delay)` moves, and `planAiMoves` catches it up. Easy is
   slower *and* sloppier, exactly as in the app.
6. Resolution is `resolveRace`: a completion wins immediately, two completions
   within 200 ms are a draw, and "End match" resolves by `compareProgress`
   (foundations, then revealed cards, then a draw).

### Moving a card

There are two ways to play a card, and both build their move through the same
`interactions.ts` helper (checked against the engine), so neither can propose an
illegal move:

- **Drag** a card — or a whole face-up run — onto a pile. The ghost tracks the
  pointer and snaps onto the slot the card would occupy when that pile will
  accept it; an accepted drop settles onto the pile before the move is sent, and
  a refused one eases back to the card it was lifted from.
- **Click** the card, then click a highlighted target. This is also the keyboard
  path.

A face-down card flips by itself when the card above it leaves.

### Deal generation cost

Measured on Node 24 (desktop): `solvableDealFromSeed` averages **40 ms** and
peaks at **133 ms** over eight seeds; `dealFromSeed` alone is 0.009 ms. That is
behind a "Finding a solvable deal…" state at match start, so no Web Worker is
used. If a low-end target ever measures above ~1 s, the fix is to ship a
pre-verified `deals.json` rather than to weaken the solvability gate.

## Known limitations

- **No web font.** The app uses Orbitron for display text; a portal build must
  not request a font, so the system UI stack is used. Weight, tracking and the
  cyan accent carry the identity instead.
- **No SDK.** itch.io needs none; CrazyGames and Poki each need their own SDK
  inside the document. That is a thin adapter to add per portal, not a change to
  the game.
- **Human dead-board re-deal runs on the main thread.** It only triggers when
  the player has no legal move at all *and* the exhaustive search proves the
  position unwinnable, so it is rare — but it can cost ~100 ms when it fires.
- **Visual parity is untested in a browser.** The board is the shared component
  and the tokens were copied verbatim, but the scoped Tailwind build should be
  compared against the app's board side by side before any submission.
- **Poki web exclusivity** is a business decision, not a technical one: a Poki
  build is expected to be Poki-only for the open web, which conflicts with the
  same game on itch.io, CrazyGames and GRYND. See `docs/poki-standalone-build.md`.
- **No leaderboard, no save, no resume.** By design — the brief forbids
  persistence, so a reload starts a new match.
- **The GRYND CTA is on in the itch build, off everywhere else.**
  `package:itch:solitaire` builds it in (sign-in route, both Victory and Defeat
  screens); a plain `build:portal:solitaire` ships no CTA and no GRYND address
  unless `PORTAL_CTA=on PORTAL_CTA_URL=https://…` is passed explicitly.
