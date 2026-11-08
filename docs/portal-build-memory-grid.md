# Memory Grid — portal package

One self-contained folder that runs the same Memory Grid the GRYND app serves,
with no server, no runtime configuration, and no network calls in the default
build.

The rules are not re-implemented here. The package imports the shared engine
(`src/lib/memory-grid/constants.js`) for the round ladder, the seeded pattern
generator, the scorer, the round and match winners, and the bot, so a round
scored 87.5 in the portal build is the same 87.5 the app commits.

---

## 1. Build

```bash
npm install                        # once
npm run build:portal:memory-grid   # -> dist/portal/memory-grid/
```

The itch.io deliverable has its own command, which builds, zips and re-reads the
archive as it goes:

```bash
npm run package:itch:memory-grid   # -> dist/packages/memory-grid-itch.zip
npm run verify:itch:memory-grid    # validates that ZIP, extracts it, plays the copy offline
```

Local checks:

```bash
npm run dev:memory-grid-standalone   # dev server on http://localhost:4320
npm run test:memory-grid-standalone  # engine parity, controller, UI markup, isolation (50 tests)
npm run verify:portal:memory-grid    # drives the BUILT package in Chrome, offline
npm run verify:itch:memory-grid      # same, against the extracted ZIP
```

`verify:portal:memory-grid` needs Chrome (set `CHROME_PATH` if it is not in a
standard location). It serves the package from `127.0.0.1`, blocks all `https`
and `wss` traffic in the browser, plays a whole match, and fails on any
off-origin request, `/api/` request, blocked request, or console error.

## 2. Output

```
dist/portal/memory-grid/
  index.html                  <- the entry point, AT THE ROOT of this folder
  favicon.svg                 <- the only icon the package ships
  assets/index-<hash>.js      <- React + the screen + the shared GRYND engine
  assets/index-<hash>.css     <- only the board's utilities and its tokens
  assets/logo1-<hash>.png     <- the tile face, bundled as an asset
```

`index.html` references its assets as `./assets/…`, so the package works from a
domain root, from a subdirectory, and from any portal CDN path. There is no
`public/` output folder, no second chunk and no source map.

The document title is `Memory Grid — remember the pattern, out-score the bot`,
with a description and `theme-color` — no GRYND host appears anywhere in the
shipped page.

The tile face is referenced from the source as
`new URL("../../../src/images/logo1.png", import.meta.url)`, which Vite rewrites
to the emitted hashed file. The verifier proves that the emitted PNG is both
**present in the archive** and **named in the bundle**: if that rewrite ever
breaks, every tile renders a broken image and verification fails.

## 3. Artwork

The package ships a favicon only. The covers are generated **from a real capture
of the built game**:

```bash
npm run build:portal:memory-grid     # the capture targets the built package
npm run artwork:portal:memory-grid   # -> dist/portal/artwork/
```

| File | Size | Where it goes |
| --- | --- | --- |
| `cover-landscape-1920x1080.png` | 1920×1080 | portal form |
| `cover-portrait-800x1200.png` | 800×1200 | portal form |
| `cover-square-800x800.png` | 800×800 | portal form |
| `cover-itch-630x500.png` | 630×500 | portal form (itch cover thumbnail) |
| `social-1200x630.png` | 1200×630 | social/OG preview |

`standalone/memory-grid/artwork/render-artwork.mjs` launches the built package
in headless Chrome, starts a match, waits for the memorize phase to light the
board, and screenshots just the phase banner and grid at 2× device scale. That
capture is cover-cropped into a rounded panel and laid on the game's own navy
stage with the wordmark, strapline and a PLAY FREE badge drawn in vector — so
the board on every cover is the board a player actually sees.

The covers go to `dist/portal/artwork/`, **not** inside the game package: they
are uploaded to the portal's form, so shipping them with the game would only
bloat the download and confuse a review of the build.

It needs Chrome (set `CHROME_PATH` if it is not in a standard location) and a
built package. `--keep-capture` also writes the two raw crops as
`dist/portal/artwork/memory-grid-banner.png` and `memory-grid-board.png`.

There are two crops because the covers have different shapes: the wide cover
shows the phase banner above the grid, while the square, portrait, itch and
social covers use the board alone. Every panel is sized to its source's aspect
ratio, so no cover cuts a row of tiles in half. The board comes from a random
match seed, so a re-run deals a different — equally valid — pattern; the rest is
deterministic.

## 4. What to upload

**The itch.io ZIP, as produced:** `dist/packages/memory-grid-itch.zip`.

For a portal that wants the loose folder instead (Poki, a self-hosted CDN),
upload the **contents of** `dist/portal/memory-grid/`, keeping the `assets/`
subfolder, so `index.html` lands at the package root.

Do not upload anything else: `standalone/`, `src/`, `node_modules/`, the repo, the
build configs and `dist/packages/.verify-extract/` are never part of a game
submission.

## 5. The itch.io package

```bash
npm run package:itch:memory-grid
# dist/packages/memory-grid-itch.zip   (~120 kB, 5 files)
```

That command (`scripts/package-itch-memory-grid.mjs`) is deliberately strict
about what it will produce:

1. **Builds with the GRYND sign-in CTA on and any portal SDK forced off.** It
   sets `PORTAL_CTA`, `PORTAL_CTA_URL` (the production sign-in route) and
   `PORTAL_SDK` for the build process, so a developer's shell or a stray `.env`
   cannot change the deliverable or leak an SDK script into a package bound for a
   third party. This is the one build that needs no environment configuration at
   all.
2. **Refuses to continue** if the build produced no `index.html`, no
   `favicon.svg`, no JS, no CSS, no tile-face logo, a source map, or an absolute
   asset reference in the page (relative paths are what let itch serve the game
   from its own subpath).
3. **Zips from inside the package folder** (`scripts/zip-portal-package.mjs`), so
   `index.html` is entry #1 at the archive root — a nested
   `memory-grid/memory-grid/index.html` is structurally impossible. The archive
   is written to `dist/packages/`, outside the folder being packed.
4. **Reads the archive back** and re-checks every entry's CRC, that the archive
   holds exactly the build's files (nothing missing, nothing extra), that the CTA
   survived intact (sign-in URL, label, question, a new-tab anchor), that it is
   the only GRYND address in the package, and that no shipped file contains an
   SDK URL or a GRYND production endpoint.

The archive contains **5 files**, no wrapper folder:

```
index.html
assets/index-<hash>.css
assets/index-<hash>.js
assets/logo1-<hash>.png
favicon.svg
```

Excluded by construction: `node_modules/`, `src/`, `tests/`, `standalone/`,
`scripts/`, `qa/`, `docs/`, dotfiles, `.env`, `*.map`, `package.json`, the build
configs, and the archived Postgres/Drizzle stack that the app version uses.

### Verifying the package

```bash
npm run verify:itch:memory-grid
```

`scripts/verify-itch-memory-grid.mjs` parses the ZIP (dependency-free reader in
`scripts/lib/zip-read.mjs`), so every check is made against **the bytes a portal
receives**, then extracts it to `dist/packages/.verify-extract/` and runs the
offline browser QA on that extraction. It fails on any of:

- a corrupt entry, bad CRC, wrong unpacked size, or an unreadable archive;
- `index.html` not first, or not at the root;
- a reference in `index.html` that does not resolve inside the archive, or is
  root-absolute / external;
- a missing bundle or stylesheet, more than one of either, or a missing favicon;
- a missing tile-face PNG, or a PNG the bundle never references;
- source, tests, maps, configs, dotfiles or a wrapper folder in the archive;
- any host other than the inert ones a bundle legitimately contains (`w3.org`
  SVG namespaces, React's error-docs URLs) and the CTA's own
  `www.grynd.dedyn.io` — so no CDN, font, tracker or API;
- `/api/`, Clerk, Supabase, Oracle, Socket.IO, PostHog, Sentry, Google ads/GTM,
  Monetag, Umami, or the CrazyGames SDK;
- a CTA that is missing, incomplete, moves off the sign-in route, or a second
  GRYND address anywhere in the archive;
- a browser run where the game does not load, start, memorize, reconstruct,
  submit, play five rounds to the final screen, replay, or makes any off-origin
  request; with the CTA on, a browser run where the link is missing, mislabelled,
  points off the sign-in route, or covers the replay button.

`--keep` leaves the extracted folder for inspection; `--no-browser` runs the
static checks only; `--no-cta` verifies a build that has the CTA compiled out.

Manual spot check of the same archive:

```bash
tar -tf dist/packages/memory-grid-itch.zip   # must start with index.html
```

## 6. Submitting to itch.io

`dist/packages/memory-grid-itch.zip` is the itch package.

1. itch.io → *Create new project* → **Kind of project: HTML**.
2. Upload the ZIP, tick **"This file will be played in the browser"**.
3. Set the viewport to **1280×720** with **mobile-friendly** enabled; the board
   is square and scales, and the layout is responsive down to a 390 px phone.
4. Set the cover image — none exists yet (§3).
5. Leave the embed origin at the default — the package has no server, no cookies
   and no storage of its own.

The package has no SDK, so itch needs no extra configuration.

## 7. Proving it is self-contained

1. `npm run verify:itch:memory-grid` — the automated archive check plus a full
   offline match in Chrome.
2. Manual: extract the ZIP somewhere and serve that folder
   (`npx serve dist/packages/.verify-extract` with `--keep`), open DevTools →
   Network, enable **Offline**, reload. The game must still load and play, with
   zero requests beyond its own document and assets.
3. Or open `index.html` directly from the extracted folder — the build uses
   relative paths, so `file://` works too (the seed only needs
   `crypto.getRandomValues`).

## 8. The GRYND CTA

The **final** result screen carries one secondary action, on a win, a loss and a
draw alike:

> Want to track your stats and compete in ranked games? — **Sign in to GRYND**

It never appears on a round result — only once the match is over.

- **Destination:** `https://www.grynd.dedyn.io/sign-in`, the production sign-in
  route (`src/app/sign-in/[[...sign-in]]`, allow-listed in `src/proxy.ts`). Not a
  new route and not a landing page.
- **New tab, ordinary anchor:** `<a target="_blank" rel="noopener noreferrer">`.
  Nothing is requested on load, so the standalone game still makes no network
  call of its own; the link only does anything when a player clicks it.
- **No promise of transfer:** the copy never states or implies that this match,
  its result, its score or its stats was saved, linked or moved into a GRYND
  account. The match is local and stays local.
- **Never in the way:** the CTA sits below the totals and the round-by-round
  breakdown; "Play again" and "Change difficulty" stay below it and work with or
  without the CTA.

`package:itch:memory-grid` **always ships the CTA on** — it sets `PORTAL_CTA=on`
and `PORTAL_CTA_URL` itself (see §5), so every deliverable is identical and the
sign-in route is the only GRYND address the package contains. It is rendered by
`standalone/memory-grid/src/ResultScreen.tsx`.

Every other build leaves it **off by default**, with the strings compiled out
(`standalone/memory-grid/src/portal-config.ts`). Turn it on only for a portal
whose rules allow outbound promotion:

```bash
PORTAL_CTA=on PORTAL_CTA_URL=https://www.grynd.dedyn.io/sign-in npm run build:portal:memory-grid
```

- resolved at **build time**, so the published package has no runtime
  configuration;
- requires an absolute `https://` URL — a missing or malformed URL leaves the CTA
  off rather than shipping a broken link.

Verify an enabled build in the browser before shipping it:

```bash
PORTAL_CTA=on PORTAL_CTA_URL=https://www.grynd.dedyn.io/sign-in npm run build:portal:memory-grid
npm run verify:portal:memory-grid:cta   # plays a whole match, then checks the CTA
```

The offline QA reads the lit tiles during memorize, submits exactly those during
reconstruction, and does that for every round, so the match is decided in five
rounds and the final screen is reached without any test-only hooks. With
`--expect-cta` it then asserts the link's destination, `target`, `rel`, label,
question, and that it sits below the result information without covering replay;
without the flag it asserts the CTA is absent and no CTA copy exists in the DOM.

`verify:itch:memory-grid` performs the same checks against the archive's own
bytes and its extracted copy (it passes `--expect-cta` automatically, because the
itch build always has it on); add `--no-cta` to verify a CTA-free build instead.

## 9. The portal SDK (CrazyGames only)

```bash
PORTAL_SDK=crazygames npm run build:portal:memory-grid
```

`PORTAL_SDK` is `none` unless set, and the itch package always builds with
`none`. With `none` the adapter in `standalone/memory-grid/src/portal-sdk.ts`
returns before touching the DOM, and the bundle contains no SDK URL at all.

When enabled, the build injects
`https://sdk.crazygames.com/crazygames-sdk-v2.js` at runtime (the portal's own
script — the one permitted off-origin request), reports
`sdkGameLoadingStart/Stop`, `gameplayStart/Stop` and `happytime()` on a win, and
never sends a result anywhere. Every SDK failure is swallowed, so a blocked CDN
leaves the game fully playable.

A build with both `PORTAL_SDK=crazygames` and `PORTAL_CTA=on` **fails**: CrazyGames
prohibits promoting an outside product or account in-game.

The offline QA has no `--expect-sdk` mode yet; an SDK build can be smoke-tested
manually in a browser, where the only off-origin request should be the SDK script.

## 10. The whole pipeline, timed

```bash
npm run pipeline:memory-grid                  # tests → package → verify
npm run pipeline:memory-grid -- --no-browser  # static verification only (no Chrome)
```

`scripts/memory-grid-pipeline.mjs` runs the three stages in order, streams their
output, and prints a timing table:

```
  stage        time  result
  unit tests   1.2 s  pass
  package      5.3 s  pass
  verify      76.7 s  pass
  ─────────────────────────────
  total       83.2 s  pass
```

Those are the numbers from one local run; the verify stage is almost entirely
the real browser playing five rounds at real speed (~74 s), which is the price of
checking the package a player will actually receive rather than a fixture.

It stops at the first failing stage and reports which later stages were skipped,
so a red run never reports a half-built package as verified.

## 11. Still required before publishing to itch.io

- **Page copy**: title, short description, tags, genre, and a "how to play" line.
  The one the game is built around: *"Study the lit tiles for a few seconds, then
  tap the ones you remember. Accuracy over the whole grid is your score."*
- **A human look at the covers**: they are generated from a live capture and
  correctly sized, but nobody has design-reviewed the type placement.
- **Price/visibility settings** and the itch project URL — an account decision,
  not a build one.
- **A human play-through on a phone**: the layout is responsive, but nobody has
  played a full match on a real handset with a real thumb.
